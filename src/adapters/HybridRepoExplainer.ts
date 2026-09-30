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
import { collectEvidence } from "../core/collectEvidence.js";
import { downgradeImportedAnchor, EVIDENCE_POLICY_VERSION } from "../core/evidencePolicy.js";
import { applyFreshnessPolicy } from "./DeepWikiExplainer.js";
import { selectSourceReads } from "../core/sourceSelection.js";

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
 * DeepWiki explains; its free-form answers remain unverified in Phase 1.
 * Read excerpts support only narrow source-statement claims. When the
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
    const { anchors, observations, warnings: evidenceWarnings } = await collectEvidence(
      this.config.provider,
      input.feature,
      candidate,
      this.now,
    );
    warnings.push(...evidenceWarnings);

    if (!this.config.explainer) {
      return this.fallback(input, anchors, observations, warnings, undefined);
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
      return this.fallback(input, anchors, observations, warnings, capability);
    }

    let enriched: ExplainOutput;
    try {
      enriched = await this.config.explainer.explain(input);
    } catch (error) {
      warnings.push(
        `Enrichment explain failed for ${repo} (${(error as Error).message}); using the exact-evidence fallback.`,
      );
      return this.fallback(input, anchors, observations, warnings, capability);
    }

    const answers = enriched.answers.map((answer) =>
      verifyAnswerAgainstAnchors(answer, input.feature, anchors),
    );
    const verifiedCount = answers.filter((a) => a.verified).length;
    warnings.push(...enriched.warnings.filter((w) => !w.includes("unverified enrichment")));
    if (capability.stale) {
      warnings.push(
        `Enrichment index for ${repo} is stale; its unassessed claims should not be treated as source support.`,
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

    return {
      provider: "hybrid",
      repo,
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      answers,
      freshness: capability,
      warnings,
      anchors,
      observations,
    };
  }

  /** Exact-evidence explainer (the docs/05 fallback flow). */
  private fallback(
    input: ExplainInput,
    anchors: EvidenceAnchor[],
    observations: import("../schemas/researchContracts.js").SourceObservation[],
    warnings: string[],
    freshness: CapabilityResult | undefined,
  ): ExplainOutput {
    const repo = input.repo.repo;
    const answers: RepoQuestionAnswer[] = input.questions.map((question) => ({
      question,
      answer:
        anchors.length === 0
          ? `No exact evidence available to answer "${question}" — run a proof pass first.`
          : `Observed ${anchors.length} source excerpt(s) in ${repo}; they do not answer this question without claim-specific assessment.`,
      evidence: anchors.slice(0, 5),
      confidence: 0.2,
      verified: false,
    }));
    return {
      provider: this.config.provider.name === "mock" ? "mock" : "octocode-fallback",
      repo,
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      answers,
      ...(freshness ? { freshness } : {}),
      warnings,
      anchors,
      observations,
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
    const concreteCallerPaths = spec.likelyFiles.filter((path) => !path.includes("*"));
    const selected = selectSourceReads({
      question: spec.goal,
      obligations: spec.proofRequirements.map((requirement) => requirement.description),
      callerPaths: concreteCallerPaths,
      treeSample: paths,
      ecosystem: spec.stack,
      budget: { total: this.config.maxFiles ?? 12, perRepo: this.config.maxFiles ?? 12 },
    });
    candidate.matchedPaths = selected.reads.map((read) => read.path);
    return candidate;
  }
}

/**
 * Free prose remains unverified in Phase 1. Exact source quotations support
 * only the narrow "this source states X" statement, not an answer as a whole.
 */
export function verifyAnswerAgainstAnchors(
  answer: RepoQuestionAnswer,
  spec: FeatureSpec,
  anchors: EvidenceAnchor[],
): RepoQuestionAnswer {
  void spec;
  void anchors;
  return {
    ...answer,
    evidence: answer.evidence.map(downgradeImportedAnchor),
    verified: false,
    confidence: Math.min(answer.confidence, 0.5),
  };
}
