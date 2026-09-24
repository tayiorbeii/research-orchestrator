import type {
  CapabilityResult,
  ExplainInput,
  ExplainOutput,
  RepoExplainer,
  RepoRef,
} from "./EvidenceProvider.js";
import { providerNotConfigured } from "../core/errors.js";

export interface DeepWikiFreshness {
  lastIndexedAt?: string;
  indexedCommit?: string;
}

export interface DeepWikiExplainerConfig {
  /**
   * Injected question function bridging to DeepWiki (e.g. an MCP deepwiki
   * server's ask_question tool). Without it the explainer reports
   * unavailable and callers must use the Octocode fallback.
   */
  askQuestion?: (repo: string, question: string) => Promise<string>;
  /**
   * Optional freshness bridge returning DeepWiki index metadata for a repo
   * (lastIndexedAt / indexedCommit). When absent, the HTTP `last-modified`
   * header from the reachability probe is used as a best-effort proxy.
   */
  getFreshness?: (repo: string) => Promise<DeepWikiFreshness>;
  /** Freshness window; stale pages trigger fallback (docs/05_deepwiki_adapter.md). */
  maxAgeDays?: number;
  fetchImpl?: typeof fetch;
  /** Injectable clock for deterministic staleness tests. */
  now?: () => Date;
}

const NOT_CONFIGURED_HINT =
  "Inject an askQuestion bridge (e.g. a DeepWiki MCP client) or rely on the Octocode fallback explainer. " +
  "DeepWiki explains; Octocode verifies — no run may depend exclusively on DeepWiki.";

/**
 * Optional DeepWiki enrichment adapter. DeepWiki output is enrichment, not
 * proof: answers are returned with verified=false until exact evidence
 * confirms them.
 */
export class DeepWikiExplainer implements RepoExplainer {
  private readonly config: DeepWikiExplainerConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(config: DeepWikiExplainerConfig = {}) {
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => new Date());
  }

  get configured(): boolean {
    return typeof this.config.askQuestion === "function";
  }

  /**
   * Cheap availability probe: does a DeepWiki page exist for this repo?
   * Never throws for network issues — reports available:false with a reason
   * so callers fall back to Octocode.
   */
  async canExplain(repo: RepoRef): Promise<CapabilityResult> {
    if (!this.configured) {
      return {
        provider: "deepwiki",
        available: false,
        reason: "DeepWiki bridge not configured. " + NOT_CONFIGURED_HINT,
      };
    }
    try {
      const response = await this.fetchImpl(`https://deepwiki.com/${repo.repo}`, {
        method: "HEAD",
        redirect: "follow",
      });
      if (!response.ok) {
        return {
          provider: "deepwiki",
          available: false,
          indexed: false,
          reason: `DeepWiki page returned HTTP ${response.status}.`,
        };
      }
      const freshness = await this.collectFreshness(repo.repo, response);
      return applyFreshnessPolicy(
        {
          provider: "deepwiki",
          available: true,
          indexed: true,
          lastIndexedAt: freshness.lastIndexedAt,
          indexedCommit: freshness.indexedCommit,
        },
        { maxAgeDays: this.config.maxAgeDays },
        this.now,
      );
    } catch (error) {
      return {
        provider: "deepwiki",
        available: false,
        reason: `DeepWiki reachability check failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Collect freshness metadata: prefer the injected getFreshness bridge,
   * fall back to the HTTP last-modified header of the reachability probe.
   */
  private async collectFreshness(repo: string, response: Response): Promise<DeepWikiFreshness> {
    if (this.config.getFreshness) {
      try {
        return await this.config.getFreshness(repo);
      } catch {
        // Freshness bridge failure is non-fatal; fall through to headers.
      }
    }
    const lastModified = response.headers?.get?.("last-modified");
    if (lastModified) {
      const parsed = Date.parse(lastModified);
      if (!Number.isNaN(parsed)) return { lastIndexedAt: new Date(parsed).toISOString() };
    }
    return {};
  }

  async explain(input: ExplainInput): Promise<ExplainOutput> {
    const ask = this.config.askQuestion;
    if (!ask) throw providerNotConfigured("DeepWiki", NOT_CONFIGURED_HINT);

    // Re-apply the per-call freshness policy on top of the config default
    // (the policy only ever escalates toward stale, never un-stales).
    const capability = applyFreshnessPolicy(
      await this.canExplain(input.repo),
      input.freshnessPolicy ?? {},
      this.now,
    );
    const warnings: string[] = [];
    if (!capability.available) {
      warnings.push(
        `DeepWiki unavailable for ${input.repo.repo}: ${capability.reason ?? "unknown"}. Use the Octocode fallback.`,
      );
      return { provider: "deepwiki", repo: input.repo.repo, answers: [], freshness: capability, warnings };
    }
    if (capability.stale) {
      warnings.push(
        `DeepWiki index for ${input.repo.repo} looks stale; verify all critical claims with exact source reads.`,
      );
    }

    const answers = [];
    for (const question of input.questions) {
      const answer = await ask(input.repo.repo, question);
      answers.push({
        question,
        answer,
        evidence: [],
        confidence: 0.5,
        // DeepWiki answers are enrichment, never proof, until verified
        // against exact source anchors.
        verified: false,
      });
    }
    warnings.push(
      "DeepWiki answers are unverified enrichment. Verify critical claims with exact file evidence before planning.",
    );
    return { provider: "deepwiki", repo: input.repo.repo, answers, freshness: capability, warnings };
  }
}

export const DEFAULT_FRESHNESS_MAX_AGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Apply a freshness policy (docs/05_deepwiki_adapter.md) to a capability
 * result: mark it stale when the index is older than maxAgeDays (default 30)
 * or when a commit check is required but no indexedCommit is available.
 * Escalates only — an already-stale capability stays stale.
 */
export function applyFreshnessPolicy(
  capability: CapabilityResult,
  policy: { maxAgeDays?: number; requireCommitCheck?: boolean } = {},
  now: () => Date = () => new Date(),
): CapabilityResult {
  if (!capability.available) return capability;
  const maxAgeDays = policy.maxAgeDays ?? DEFAULT_FRESHNESS_MAX_AGE_DAYS;
  let stale = capability.stale ?? false;
  let reason = capability.reason;

  if (!stale && capability.lastIndexedAt) {
    const parsed = Date.parse(capability.lastIndexedAt);
    if (!Number.isNaN(parsed)) {
      const ageDays = (now().getTime() - parsed) / DAY_MS;
      if (ageDays > maxAgeDays) {
        stale = true;
        reason = `DeepWiki index is ~${Math.floor(ageDays)} day(s) old (freshness window: ${maxAgeDays} day(s)).`;
      }
    }
  }
  if (!stale && policy.requireCommitCheck && !capability.indexedCommit) {
    stale = true;
    reason =
      "Freshness policy requires an indexed-commit check, but DeepWiki reported no indexedCommit.";
  }

  return { ...capability, stale, ...(reason !== undefined ? { reason } : {}) };
}
