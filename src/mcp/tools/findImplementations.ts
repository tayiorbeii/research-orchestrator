import { z } from "zod";
import { executeBrief } from "../../core/brief/executeBrief.js";
import { draftBriefFromGoal } from "../../core/brief/draftBriefFromGoal.js";
import { validateBrief } from "../../core/brief/validateBrief.js";
import { ResearchBriefSchema } from "../../schemas/researchBrief.js";
import { providerNotConfigured, ResearchError } from "../../core/errors.js";
import { MockEvidenceProvider } from "../../adapters/MockEvidenceProvider.js";
import { GitHubEvidenceProvider } from "../../adapters/GitHubEvidenceProvider.js";
import { resolveOctocodeProvider } from "../../adapters/bridge.js";
import type { EvidenceProvider } from "../../adapters/EvidenceProvider.js";
import { FileResearchCache } from "../../cache/FileResearchCache.js";
import type { ResearchRunV2 } from "../../schemas/researchRun.js";

export const findImplementationsInputShape = {
  goal: z.string().min(1).optional().describe("High-level research goal; adapted to the same brief engine."),
  brief: ResearchBriefSchema.optional(),
  resumeRunId: z.string().min(1).optional(),
  budgetOverrides: z.object({ maxQuestions: z.number().int().nonnegative().optional(), queryUnits: z.number().int().nonnegative().optional(), reconnaissanceReads: z.number().int().nonnegative().optional(), fileReads: z.number().int().nonnegative().optional(), fileReadsPerRepo: z.number().int().nonnegative().optional(), refinementRounds: z.number().int().nonnegative().optional(), refinementProbes: z.number().int().nonnegative().optional(), deadlineMs: z.number().int().positive().optional() }).optional().describe("Explicitly requested budget changes applied to the supplied or drafted brief."),
  stack: z.array(z.string()).optional(),
  mustHave: z.array(z.string()).optional(),
  shouldHave: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  language: z.string().optional(),
  maxCandidates: z.number().int().positive().optional(),
  maxReposToProve: z.number().int().positive().optional(),
  mode: z.enum(["mock", "octocode", "github", "hybrid"]).optional().describe("Evidence provider mode; defaults to mock."),
  deepwiki: z
    .object({
      enabled: z.boolean().optional(),
      maxAgeDays: z.number().optional(),
      fallbackToOctocode: z.boolean().optional(),
    })
    .optional(),
};

const InputSchema = z.object(findImplementationsInputShape).refine((input) => Boolean(input.brief) !== Boolean(input.goal), "Provide exactly one of brief or goal.");
export type FindImplementationsInput = z.infer<typeof InputSchema>;

export async function resolveProvider(mode: string | undefined): Promise<EvidenceProvider> {
  switch (mode ?? "mock") {
    case "mock":
      return new MockEvidenceProvider();
    case "octocode":
    case "hybrid":
      // Configured via injected callTool, setOctocodeToolCaller(), or
      // RESEARCH_OCTOCODE_BRIDGE; fails fast with a structured error otherwise.
      return resolveOctocodeProvider({ requireConfigured: true });
    case "github": {
      const provider = new GitHubEvidenceProvider();
      if (!provider.configured) {
        throw providerNotConfigured(
          "GitHub",
          "Run `gh auth login` or set GITHUB_TOKEN/GH_TOKEN, or use mode:'mock'.",
        );
      }
      return provider;
    }
    default:
      return new MockEvidenceProvider();
  }
}

/** research.findImplementations — find, score, and prove candidate repos. */
export async function findImplementations(input: FindImplementationsInput, deps: {
  executeBrief?: typeof executeBrief;
  draftBriefFromGoal?: typeof draftBriefFromGoal;
  validateBrief?: typeof validateBrief;
} = {}) {
  const parsed = InputSchema.parse(input);
  const provider = await resolveProvider(parsed.mode);
  let resumeLedger;
  let resumeRun: ResearchRunV2 | undefined;
  if (parsed.resumeRunId) {
    const parent = await new FileResearchCache().loadRun(parsed.resumeRunId);
    if (parent.schemaVersion !== 2 || !parent.brief || !parent.compiledProbes || !parent.probeOutcomes || !parent.providerName || parent.evidencePolicyVersion !== "phase2_claim_evidence_v2") {
      throw new ResearchError("invalid_feature_spec", "Resume requires a compatible Phase 5 v2 brief run.");
    }
    resumeLedger = parent.budgetLedger;
    resumeRun = parent as ResearchRunV2;
    if (!resumeLedger) throw new Error(`Parent run ${parsed.resumeRunId} has no budget ledger.`);
  }
  const draft = parsed.brief ?? (deps.draftBriefFromGoal ?? draftBriefFromGoal)(parsed.goal!, {
    ...(parsed.stack ? { ecosystems: parsed.stack } : {}),
    ...(parsed.language ? { languages: [parsed.language] } : {}),
  });
  const validation = (deps.validateBrief ?? validateBrief)(draft);
  if (validation.issues.length > 0) throw new ResearchError("invalid_feature_spec", `Invalid research brief: ${validation.issues.map((issue) => issue.code).join(", ")}`);
  const drafted = validation.brief;
  const brief = parsed.brief ? drafted : withLegacyTerms(drafted, [...(parsed.mustHave ?? []), ...(parsed.shouldHave ?? [])]);
  const run = await (deps.executeBrief ?? executeBrief)({ ...brief, budgets: { ...brief.budgets, ...parsed.budgetOverrides } }, { provider, maxCandidates: parsed.maxCandidates, maxReposToProve: parsed.maxReposToProve, deterministic: (parsed.mode ?? "mock") === "mock", resumeLedger, resumeRun, parentRunId: parsed.resumeRunId });
  const evidence = run.candidates.flatMap((candidate) => candidate.candidateSignals.flatMap((signal) => signal.evidence ?? []));

  // Persist the run so research.writePlanArtifact can reference it by runId.
  const cache = new FileResearchCache();
  await cache.saveRun(run);

  return {
    runId: run.id,
    mode: parsed.mode ?? "mock",
    provider: provider.name,
    evidenceOrigin: run.evidenceOrigin,
    featureSpec: run.featureSpec,
    probes: run.probes,
    candidates: run.candidates,
    scoredCandidates: run.scoredCandidates,
    selectedRepos: run.selectedRepos,
    schemaVersion: run.schemaVersion,
    brief: run.brief,
    compiledProbes: run.compiledProbes,
    probeOutcomes: run.probeOutcomes,
    budgetLedger: run.budgetLedger,
    parentRunId: (run as typeof run & { parentRunId?: string }).parentRunId,
    observations: run.observations,
    assessments: run.assessments,
    coverage: run.coverage,
    outcome: run.outcome,
    candidateStates: run.candidateStates,
    explanationResults: run.explanationResults,
    // Keep anchors in JSON for downstream agents (docs/08_mcp_tool_spec.md).
    evidence,
    warnings: run.warnings,
  };
}

function withLegacyTerms(brief: import("../../schemas/researchBrief.js").ResearchBrief, terms: string[]) {
  if (terms.length === 0 || brief.questions.length === 0) return brief;
  const known = new Set(brief.vocabulary.map((term) => term.text.toLowerCase()));
  const additions = terms.filter((term) => !known.has(term.toLowerCase())).map((text, index) => ({
    id: `legacy_hint_${index + 1}`, text, questionIds: [brief.questions[0]!.id], kind: "domain_phrase" as const,
    origin: "user_supplied" as const, status: "observed" as const,
  }));
  return { ...brief, vocabulary: [...brief.vocabulary, ...additions] };
}
