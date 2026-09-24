import { z } from "zod";
import { FeatureSpecSchema, type RepoPatternExplanation } from "../../schemas/index.js";
import { extractPattern } from "../../core/extractPattern.js";
import { scoreCandidate } from "../../core/scoreCandidate.js";
import { MockEvidenceProvider } from "../../adapters/MockEvidenceProvider.js";
import { HybridRepoExplainer } from "../../adapters/HybridRepoExplainer.js";
import { candidateShell, type EvidenceProvider, type ExplainOutput } from "../../adapters/EvidenceProvider.js";
import { resolveDeepWikiExplainer, resolveOctocodeProvider } from "../../adapters/bridge.js";

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
 * is configured) is verified against exact evidence anchors; stale or
 * unavailable DeepWiki falls back to the exact-evidence explainer. DeepWiki
 * answers stay unverified until exact evidence confirms them.
 */
export async function explainRepoPattern(input: ExplainRepoPatternInput) {
  const parsed = InputSchema.parse(input);
  const warnings: string[] = [];
  const explanations: RepoPatternExplanation[] = [];

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
    const out = await hybrid.explain({
      repo: { repo },
      feature: parsed.featureSpec,
      questions,
      freshnessPolicy: parsed.freshnessPolicy,
    });
    warnings.push(...out.warnings);

    const anchors = out.anchors ?? [];
    const candidate =
      mockCandidates.find((c) => c.repo === repo) ??
      ({
        ...candidateShell(repo),
        discoveredBy: [],
        matchedPaths: anchors.map((a) => a.path),
        candidateSignals: [],
      } as (typeof mockCandidates)[number]);

    const scored = scoreCandidate(parsed.featureSpec, candidate, anchors);
    const pattern = extractPattern(parsed.featureSpec, [scored], anchors);

    explanations.push({
      repo,
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
      answers: out.answers,
      implementationMap: pattern.implementationMap,
      warnings: scored.missingProof.map((m) => `missingProof: ${m}`),
    });
  }

  return { explanations, warnings };
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
