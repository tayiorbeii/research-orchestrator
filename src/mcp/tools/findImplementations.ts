import { z } from "zod";
import { runResearch } from "../../core/pipeline.js";
import { providerNotConfigured } from "../../core/errors.js";
import { MockEvidenceProvider } from "../../adapters/MockEvidenceProvider.js";
import { GitHubEvidenceProvider } from "../../adapters/GitHubEvidenceProvider.js";
import { resolveOctocodeProvider } from "../../adapters/bridge.js";
import type { EvidenceProvider } from "../../adapters/EvidenceProvider.js";
import { FileResearchCache } from "../../cache/FileResearchCache.js";

export const findImplementationsInputShape = {
  goal: z.string().min(1).describe("High-level implementation research goal."),
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

const InputSchema = z.object(findImplementationsInputShape);
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
export async function findImplementations(input: FindImplementationsInput) {
  const parsed = InputSchema.parse(input);
  const provider = await resolveProvider(parsed.mode);
  const { run, evidence } = await runResearch({
    goal: parsed.goal,
    provider,
    hints: {
      stack: parsed.stack,
      mustHave: parsed.mustHave,
      shouldHave: parsed.shouldHave,
      exclude: parsed.exclude,
    },
    maxCandidates: parsed.maxCandidates,
    maxReposToProve: parsed.maxReposToProve,
    deterministic: (parsed.mode ?? "mock") === "mock",
  });

  // Persist the run so research.writePlanArtifact can reference it by runId.
  const cache = new FileResearchCache();
  await cache.saveRun(run);

  return {
    runId: run.id,
    featureSpec: run.featureSpec,
    probes: run.probes,
    candidates: run.candidates,
    scoredCandidates: run.scoredCandidates,
    selectedRepos: run.selectedRepos,
    // Keep anchors in JSON for downstream agents (docs/08_mcp_tool_spec.md).
    evidence,
    warnings: run.warnings,
  };
}
