import type {
  CandidateRepo,
  EvidenceAnchor,
  FeatureSpec,
  RepoQuestionAnswer,
} from "../schemas/index.js";
import type {
  CapabilityResult,
  EvidenceProvider,
  ExplainInput,
  ExplainOutput,
  RepoExplainer,
  RepoRef,
} from "./EvidenceProvider.js";
import { candidateShell } from "./EvidenceProvider.js";
import { collectEvidence, lineHasSignal } from "../core/collectEvidence.js";
import { applyFreshnessPolicy } from "./DeepWikiExplainer.js";

export interface HybridRepoExplainerConfig {
  /** Evidence provider used for exact verification and the fallback flow. */
  provider: EvidenceProvider;
  /** Optional enrichment explainer (typically a DeepWikiExplainer). */
  explainer?: RepoExplainer;
  /** Freshness window for the enrichment explainer (docs/05). Default 30. */
  maxAgeDays?: number;
  /** Fall back to exact evidence when the enrichment index is stale. Default true. */
  fallbackWhenStale?: boolean;
  /** Custom candidate resolution (e.g. reuse candidates from a research run). */
  resolveCandidate?: (repo: RepoRef) => Promise<CandidateRepo | undefined>;
  /** Cap on repo-tree paths read during default candidate resolution. */
  maxFiles?: number;
  now?: () => Date;
}

/**
 * Hybrid repo explainer (docs/05_deepwiki_adapter.md, "Hybrid output model").
 *
 * DeepWiki explains; exact evidence verifies. Every enrichment answer is
 * cross-checked against proved evidence anchors collected through the
 * injected EvidenceProvider — an answer becomes verified:true only when it
 * mentions a proof-requirement signal that a proved anchor backs. When the
 * enrichment explainer is unavailable or its index is stale, the flow falls
 * back to the Octocode-style exact-evidence explainer (docs/05, "Fallback
 * flow"). DeepWiki is never sole proof.
 */
export class HybridRepoExplainer implements RepoExplainer {
  private readonly config: HybridRepoExplainerConfig;
  private readonly now: () => Date;

  constructor(config: HybridRepoExplainerConfig) {
    this.config = config;
    this.now = config.now ?? (() => new Date());
  }

  async canExplain(repo: RepoRef): Promise<CapabilityResult> {
    if (this.config.explainer) {
      return applyFreshnessPolicy(
        await this.config.explainer.canExplain(repo),
        { maxAgeDays: this.config.maxAgeDays },
        this.now,
      );
    }
    // The exact-evidence fallback is always available.
    return { provider: "octocode-fallback", available: true };
  }

  async explain(input: ExplainInput): Promise<ExplainOutput> {
    const warnings: string[] = [];
    const repo = input.repo.repo;

    const candidate = await this.buildCandidate(input.repo, input.feature);
    const { anchors, warnings: evidenceWarnings } = await collectEvidence(
      this.config.provider,
      input.feature,
      candidate,
    );
    warnings.push(...evidenceWarnings);

    if (!this.config.explainer) {
      return this.fallback(input, anchors, warnings, undefined);
    }

    let capability = await this.config.explainer.canExplain(input.repo);
    capability = applyFreshnessPolicy(
      capability,
      {
        maxAgeDays: input.freshnessPolicy?.maxAgeDays ?? this.config.maxAgeDays,
        requireCommitCheck: input.freshnessPolicy?.requireCommitCheck,
      },
      this.now,
    );

    const fallbackWhenStale = this.config.fallbackWhenStale ?? true;
    if (!capability.available || (capability.stale && fallbackWhenStale)) {
      warnings.push(
        `Enrichment ${capability.available ? "index is stale" : "unavailable"} for ${repo}` +
          `${capability.reason ? ` (${capability.reason})` : ""}; using the exact-evidence fallback.`,
      );
      return this.fallback(input, anchors, warnings, capability);
    }

    let enriched: ExplainOutput;
    try {
      enriched = await this.config.explainer.explain(input);
    } catch (error) {
      warnings.push(
        `Enrichment explain failed for ${repo} (${(error as Error).message}); using the exact-evidence fallback.`,
      );
      return this.fallback(input, anchors, warnings, capability);
    }

    const answers = enriched.answers.map((answer) =>
      verifyAnswerAgainstAnchors(answer, input.feature, anchors),
    );
    const verifiedCount = answers.filter((a) => a.verified).length;
    warnings.push(...enriched.warnings.filter((w) => !w.includes("unverified enrichment")));
    if (capability.stale) {
      warnings.push(
        `Enrichment index for ${repo} is stale; only claims verified against exact evidence should be trusted.`,
      );
    }
    warnings.push(
      `Hybrid verification: ${verifiedCount}/${answers.length} enrichment answer(s) verified against exact evidence anchors.`,
    );
    if (verifiedCount < answers.length) {
      warnings.push(
        "Unverified enrichment answers must not be treated as proof — collect exact evidence before relying on them.",
      );
    }

    return { provider: "hybrid", repo, answers, freshness: capability, warnings, anchors };
  }

  /** Exact-evidence explainer (the docs/05 fallback flow). */
  private fallback(
    input: ExplainInput,
    anchors: EvidenceAnchor[],
    warnings: string[],
    freshness: CapabilityResult | undefined,
  ): ExplainOutput {
    const repo = input.repo.repo;
    const proved = anchors.filter((a) => a.proofLevel === "proved");
    const answers: RepoQuestionAnswer[] = input.questions.map((question) => ({
      question,
      answer:
        anchors.length === 0
          ? `No exact evidence available to answer "${question}" — run a proof pass first.`
          : `Answered from ${anchors.length} exact evidence anchor(s) (${proved.length} proved) in ${repo}; see the evidence entries.`,
      evidence: anchors.slice(0, 5),
      confidence: anchors.length > 0 ? 0.75 : 0.2,
      verified: proved.length > 0,
    }));
    return {
      provider: this.config.provider.name === "mock" ? "mock" : "octocode-fallback",
      repo,
      answers,
      ...(freshness ? { freshness } : {}),
      warnings,
      anchors,
    };
  }

  /**
   * Default candidate resolution: metadata + repo tree, prioritizing the
   * spec's likely files and dependency manifests, capped at maxFiles.
   */
  private async buildCandidate(ref: RepoRef, spec: FeatureSpec): Promise<CandidateRepo> {
    if (this.config.resolveCandidate) {
      const resolved = await this.config.resolveCandidate(ref);
      if (resolved) return resolved;
    }

    const shell = candidateShell(ref.repo);
    const candidate: CandidateRepo = {
      ...shell,
      discoveredBy: [],
      matchedPaths: [],
      candidateSignals: [],
    };
    try {
      const metadata = await this.config.provider.getRepoMetadata(ref);
      candidate.defaultBranch = metadata.defaultBranch;
      candidate.url = metadata.url;
      candidate.archived = metadata.archived;
      candidate.stars = metadata.stars;
      candidate.pushedAt = metadata.pushedAt;
    } catch {
      // Metadata is optional for evidence reads.
    }

    let paths: string[] = [];
    if (this.config.provider.getRepoTree) {
      try {
        paths = (await this.config.provider.getRepoTree(ref)).paths;
      } catch {
        // Missing tree becomes missingProof warnings downstream.
      }
    }
    const likely = new Set(
      spec.likelyFiles.filter((f) => !f.includes("*")).map((f) => normalizePath(f)),
    );
    const priority = (path: string): number => {
      if (likely.has(normalizePath(path))) return 0;
      if (/(^|\/)package\.json$/i.test(path)) return 1;
      return 2;
    };
    candidate.matchedPaths = [...new Set(paths)]
      .sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))
      .slice(0, this.config.maxFiles ?? 12);
    return candidate;
  }
}

/**
 * Cross-check one enrichment answer against exact evidence anchors: the
 * answer becomes verified:true only when it mentions a proof-requirement
 * signal (identifier-boundary aware) for which a proved anchor exists. The
 * matching proved anchors are attached as the answer's evidence.
 */
export function verifyAnswerAgainstAnchors(
  answer: RepoQuestionAnswer,
  spec: FeatureSpec,
  anchors: EvidenceAnchor[],
): RepoQuestionAnswer {
  const text = `${answer.question}\n${answer.answer}`;
  const matched: EvidenceAnchor[] = [];
  for (const req of spec.proofRequirements) {
    const proved = anchors.filter((a) => a.role === req.key && a.proofLevel === "proved");
    if (proved.length === 0) continue;
    const mentioned = req.signals.some((signal) =>
      text.split("\n").some((line) => lineHasSignal(line, signal)),
    );
    if (mentioned) matched.push(...proved);
  }
  const seen = new Set<string>();
  const evidence = matched.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
  if (evidence.length === 0) {
    return { ...answer, verified: false };
  }
  return {
    ...answer,
    verified: true,
    evidence: evidence.slice(0, 5),
    confidence: Math.max(answer.confidence, 0.85),
  };
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").toLowerCase();
}
