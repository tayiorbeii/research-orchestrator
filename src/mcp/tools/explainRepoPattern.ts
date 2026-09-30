import { z } from "zod";
import { FeatureSpecSchema, type RepoPatternExplanation, type CandidateRepo, type ScoredCandidate, type RepoExplanationResult, type ResearchRunV2 } from "../../schemas/index.js";
import { extractPattern } from "../../core/extractPattern.js";
import { scoreCandidate } from "../../core/scoreCandidate.js";
import { MockEvidenceProvider } from "../../adapters/MockEvidenceProvider.js";
import { HybridRepoExplainer } from "../../adapters/HybridRepoExplainer.js";
import { candidateShell, type EvidenceProvider, type ExplainOutput } from "../../adapters/EvidenceProvider.js";
import { resolveDeepWikiExplainer, resolveOctocodeProvider } from "../../adapters/bridge.js";
import { EVIDENCE_POLICY_VERSION, RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION } from "../../core/evidencePolicy.js";
import { FileResearchCache } from "../../cache/FileResearchCache.js";
import { deriveCoverage } from "../../core/assessment/coverage.js";
import type { SourceObservation } from "../../schemas/researchContracts.js";

export const explainRepoPatternInputShape = {
  featureSpec: FeatureSpecSchema,
  repos: z.array(z.string().min(1)).min(1),
  questions: z.array(z.string()).optional(),
  preferDeepWiki: z.boolean().optional(),
  fallbackToOctocode: z.boolean().optional(),
  freshnessPolicy: z
    .object({
      maxAgeDays: z.number().positive().optional(),
      requireCommitCheck: z.boolean().optional(),
    })
    .optional(),
  maxFiles: z.number().int().positive().optional(),
  mode: z.enum(["mock", "octocode", "hybrid"]).optional(),
};

const InputSchema = z.object(explainRepoPatternInputShape);
export type ExplainRepoPatternInput = z.infer<typeof InputSchema>;

/**
 * research.explainRepoPattern — answer implementation questions for selected
 * repos through the hybrid flow (docs/05): DeepWiki enrichment (when a bridge
 * is configured), while every free-form answer remains unverified. Read
 * excerpts support only narrow statements about what a source says.
 */
export async function explainRepoPattern(input: ExplainRepoPatternInput) {
  const parsed = InputSchema.parse(input);
  const warnings: string[] = [];
  const explanations: RepoPatternExplanation[] = [];
  const explanationResults: RepoExplanationResult[] = [];
  const observations: SourceObservation[] = [];
  const candidates: CandidateRepo[] = [];
  const scoredCandidates: ScoredCandidate[] = [];

  const mode = parsed.mode ?? "mock";
  const provider: EvidenceProvider =
    mode === "mock"
      ? new MockEvidenceProvider()
      : await resolveOctocodeProvider({ requireConfigured: true });

  const deepwiki = await resolveDeepWikiExplainer();
  const wantDeepWiki = parsed.preferDeepWiki ?? deepwiki.configured;
  if (parsed.preferDeepWiki && !deepwiki.configured) {
    warnings.push(
      "DeepWiki bridge not configured; using the exact-evidence fallback. " +
        "Set RESEARCH_DEEPWIKI_BRIDGE or call setDeepWikiAskQuestion() to enable enrichment.",
    );
  }
  const useDeepWiki = wantDeepWiki && deepwiki.configured;

  const mockCandidates =
    provider instanceof MockEvidenceProvider ? await provider.getCandidates() : [];

  const hybrid = new HybridRepoExplainer({
    provider,
    explainer: useDeepWiki ? deepwiki : undefined,
    fallbackWhenStale: parsed.fallbackToOctocode !== false,
    maxAgeDays: parsed.freshnessPolicy?.maxAgeDays,
    maxFiles: parsed.maxFiles,
    resolveCandidate: async (ref) => mockCandidates.find((c) => c.repo === ref.repo),
  });

  const questions = parsed.questions ?? DEFAULT_QUESTIONS;
  const checkedAt = new Date().toISOString();

  for (const repo of parsed.repos) {
    try {
      const out = await hybrid.explain({
        repo: { repo },
        feature: parsed.featureSpec,
        questions,
        freshnessPolicy: parsed.freshnessPolicy,
      });
      warnings.push(...out.warnings);
      observations.push(...(out.observations ?? []));

      const anchors = out.anchors ?? [];
      const candidate = mockCandidates.find((item) => item.repo === repo) ?? {
        ...candidateShell(repo),
        discoveredBy: [],
        matchedPaths: anchors.map((anchor) => anchor.path),
        candidateSignals: [],
      };
      const scored = scoreCandidate(parsed.featureSpec, candidate, anchors);
      const pattern = extractPattern(parsed.featureSpec, [scored], anchors);
      const explanation: RepoPatternExplanation = {
        repo,
        evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
        evidenceOrigin:
          anchors.some((anchor) => anchor.provider === "mock") || out.provider === "mock"
            ? "synthetic_mock"
            : "repository_observation",
        source: sourceFromProvider(out.provider),
        ...(out.freshness
          ? {
              freshness: {
                checkedAt,
                lastIndexedAt: out.freshness.lastIndexedAt,
                indexedCommit: out.freshness.indexedCommit,
                stale: out.freshness.stale,
              },
            }
          : {}),
        answers: out.answers.map((answer) => ({ ...answer, verified: false, confidence: Math.min(answer.confidence, 0.5) })),
        implementationMap: pattern.implementationMap,
        warnings: scored.missingProof.map((message) => `missingProof: ${message}`),
      };
      explanations.push(explanation);
      candidates.push(candidate);
      scoredCandidates.push(scored);
      explanationResults.push({ repo, status: "succeeded", explanation });
    } catch (error) {
      const message = (error as Error).message || "Repository explanation failed.";
      warnings.push(`Explanation failed for ${repo}: ${message}`);
      explanationResults.push({ repo, status: "failed", error: message, errorClass: (error as Error).name });
      const [owner = "unknown", name = repo] = repo.split("/");
      candidates.push({ repo, owner, name, discoveredBy: [], matchedPaths: [], candidateSignals: [] });
    }
  }
  const candidateStates = candidates.map((candidate) => ({
    repo: candidate.repo,
    state: explanationResults.find((result) => result.repo === candidate.repo)?.status === "failed" ? "unavailable" as const : "inspected" as const,
  }));
  const { coverage, outcome } = deriveCoverage({
    spec: parsed.featureSpec, candidates: candidates.map((candidate) => candidate.repo), states: candidateStates,
    observations, assessments: [],
  });
  const now = new Date();
  const runId = `run_explain_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
  const run: ResearchRunV2 = {
    id: runId, schemaVersion: 2 as const, evidencePolicyVersion: RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION,
    providerName: provider.name,
    evidenceOrigin: mode === "mock" ? "synthetic_mock" as const : "repository_observation" as const,
    createdAt: now.toISOString(), goal: parsed.featureSpec.goal, featureSpec: parsed.featureSpec,
    probes: [], candidates, scoredCandidates, selectedRepos: parsed.repos,
    explanations, artifacts: [], warnings: [...new Set(warnings)], observations,
    assessments: [], coverage, outcome, candidateStates, explanationResults,
  };
  await new FileResearchCache().saveRun(run);
  return { runId, explanations, explanationResults, candidateStates, coverage, outcome, warnings };
}

function sourceFromProvider(
  provider: ExplainOutput["provider"],
): RepoPatternExplanation["source"] {
  return provider === "octocode-fallback" ? "octocode_fallback" : provider;
}

const DEFAULT_QUESTIONS = [
  "Where is this feature wired from entry point to provider/client?",
  "Which files define provider/configuration?",
  "Which environment variables are required?",
];
