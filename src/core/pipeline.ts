import type {
  CandidateRepo,
  EvidenceAnchor,
  FeatureSpec,
  ResearchRun,
  ScoredCandidate,
  SearchProbe,
} from "../schemas/index.js";
import type { EvidenceProvider, NormalizedSearchResult, RepoSearchResult } from "../adapters/EvidenceProvider.js";
import { normalizeFeatureSpec } from "./normalizeFeatureSpec.js";
import { generateSearchProbes } from "./generateSearchProbes.js";
import { collectEvidence } from "./collectEvidence.js";
import { scoreCandidate } from "./scoreCandidate.js";
import { extractPattern, type ExtractedPattern } from "./extractPattern.js";

export interface RunResearchOptions {
  goal: string;
  provider: EvidenceProvider;
  hints?: Partial<FeatureSpec>;
  maxCandidates?: number;
  maxReposToProve?: number;
  /** Fixed id/createdAt for reproducible mock runs. */
  deterministic?: boolean;
  now?: () => Date;
}

export interface RunResearchResult {
  run: ResearchRun;
  evidence: EvidenceAnchor[];
  pattern: ExtractedPattern;
}

const DETERMINISTIC_CREATED_AT = "2026-06-30T00:00:00.000Z";

/**
 * The vertical slice:
 * goal -> FeatureSpec -> SearchProbe[] -> CandidateRepo[] -> ScoredCandidate[]
 *      -> (evidence anchors + extracted pattern) ready for artifact writing.
 */
export async function runResearch(options: RunResearchOptions): Promise<RunResearchResult> {
  const warnings: string[] = [];
  const now = options.now ?? (() => new Date());
  const featureSpec = normalizeFeatureSpec(options.goal, options.hints);
  const probes = generateSearchProbes(featureSpec);

  // Split probes: code search vs. repo discovery. Repo-search probes target
  // ghSearchRepos (name/topic/readme); the rest target ghSearchCode. Routing
  // matters: a repo-discovery phrase sent to code search AND-matches source
  // text and routinely returns nothing.
  const codeProbes = probes.filter((p) => p.kind !== "repo_search");
  const repoProbes = probes.filter((p) => p.kind === "repo_search");

  // Collect candidates.
  let searchResults: NormalizedSearchResult[] = [];
  let providerSearchFailed = false;
  if (codeProbes.length > 0) {
    try {
      searchResults = await options.provider.searchCode(codeProbes);
    } catch (error) {
      providerSearchFailed = true;
      warnings.push(
        `[provider_search_failed] Provider code search failed (transport/config): ${(error as Error).message}`,
      );
    }
  }
  if (codeProbes.length > 0 && searchResults.length === 0 && !providerSearchFailed) {
    warnings.push(`Code search returned no results across ${codeProbes.length} probe(s).`);
  }

  // Repo discovery finds official project repositories by name/topic/readme
  // (ghSearchRepos) — the right tool for research/migration goals. For research
  // goals it runs as a primary discovery method alongside code search; for
  // application goals it is a fallback when code search misses.
  const isResearchSpec = featureSpec.goalKind === "research";
  const needRepoDiscovery =
    (isResearchSpec || searchResults.length === 0) && repoProbes.length > 0;
  if (needRepoDiscovery) {
    const discovered = await discoverReposViaSearch(options.provider, repoProbes, warnings);
    const existing = new Set(searchResults.map((r) => `${r.repo}:${r.path}`));
    for (const d of discovered) {
      if (!existing.has(`${d.repo}:${d.path}`)) searchResults.push(d);
    }
    const distinctRepos = new Set(discovered.map((d) => d.repo)).size;
    warnings.push(
      distinctRepos > 0
        ? `Repo discovery returned ${distinctRepos} repo(s) across ${repoProbes.length} repo_search probe(s).`
        : `Repo discovery returned no repos across ${repoProbes.length} repo_search probe(s); verify product names, provider config, or rate limits.`,
    );
  } else if (codeProbes.length === 0 && repoProbes.length === 0) {
    warnings.push("No search probes were generated; cannot collect candidates.");
  }

  const candidates = await collectCandidates(
    options.provider,
    searchResults,
    warnings,
    isResearchSpec,
  );
  const limited = candidates.slice(0, options.maxCandidates ?? 25);

  // Evidence + scoring.
  const evidence: EvidenceAnchor[] = [];
  const scoredCandidates: ScoredCandidate[] = [];
  const proveLimit = options.maxReposToProve ?? limited.length;
  for (let i = 0; i < limited.length; i += 1) {
    const candidate = limited[i]!;
    let anchors: EvidenceAnchor[] = [];
    if (i < proveLimit) {
      const collected = await collectEvidence(options.provider, featureSpec, candidate);
      anchors = collected.anchors;
      warnings.push(...collected.warnings);
      evidence.push(...anchors);
    } else {
      warnings.push(`missingProof: ${candidate.repo} was not proof-read (maxReposToProve reached).`);
    }
    scoredCandidates.push(scoreCandidate(featureSpec, candidate, anchors, { now: now() }));
  }
  scoredCandidates.sort((a, b) => b.score - a.score);

  const selectedRepos = scoredCandidates
    .filter((s) => s.nextAction !== "reject")
    .map((s) => s.repo);

  const pattern = extractPattern(featureSpec, scoredCandidates, evidence);

  const run: ResearchRun = {
    id: options.deterministic
      ? `run_mock_${featureSpec.featureKey.replace(/-/g, "_")}`
      : `run_${featureSpec.featureKey.replace(/-/g, "_")}_${now().getTime()}`,
    createdAt: options.deterministic ? DETERMINISTIC_CREATED_AT : now().toISOString(),
    goal: options.goal,
    featureSpec,
    probes,
    candidates: limited,
    scoredCandidates,
    selectedRepos,
    explanations: [],
    artifacts: [],
    warnings: [...new Set(warnings)],
  };

  return { run, evidence, pattern };
}

async function collectCandidates(
  provider: EvidenceProvider,
  results: NormalizedSearchResult[],
  warnings: string[],
  prioritizeRepoDiscovery = false,
): Promise<CandidateRepo[]> {
  const byRepo = new Map<string, { probes: Set<string>; paths: Set<string> }>();
  for (const result of results) {
    const entry = byRepo.get(result.repo) ?? { probes: new Set(), paths: new Set() };
    entry.probes.add(result.probeId);
    entry.paths.add(result.path);
    byRepo.set(result.repo, entry);
  }

  const candidates: CandidateRepo[] = [];
  for (const [repo, entry] of byRepo) {
    let metadata;
    try {
      metadata = await provider.getRepoMetadata({ repo });
    } catch (error) {
      warnings.push(`Metadata read failed for ${repo}: ${(error as Error).message}`);
      const [owner = "unknown", name = repo] = repo.split("/");
      metadata = { repo, owner, name };
    }
    candidates.push({
      repo,
      owner: metadata.owner,
      name: metadata.name,
      defaultBranch: metadata.defaultBranch,
      url: metadata.url,
      archived: metadata.archived,
      stars: metadata.stars,
      pushedAt: metadata.pushedAt,
      discoveredBy: [...entry.probes].sort(),
      matchedPaths: [...entry.paths].sort(),
      candidateSignals: [
        {
          key: "multi_probe_match",
          label: `Matched by ${entry.probes.size} independent probe(s).`,
          source: "search",
          confidence: Math.min(0.3 + entry.probes.size * 0.2, 0.9),
        },
      ],
    });
  }
  // Deterministic ordering. For research goals, repos discovered by a
  // repo_search probe (official projects) come first so the candidate cap does
  // not evict them when code search also returns noise. Application goals keep
  // the original most-probes-then-name ordering (golden stability).
  return candidates.sort((a, b) => {
    if (prioritizeRepoDiscovery) {
      const aRepoSearch = a.discoveredBy.some((p) => p.startsWith("repo_"));
      const bRepoSearch = b.discoveredBy.some((p) => p.startsWith("repo_"));
      if (aRepoSearch !== bRepoSearch) return aRepoSearch ? -1 : 1;
    }
    const diff = b.discoveredBy.length - a.discoveredBy.length;
    return diff !== 0 ? diff : a.repo.localeCompare(b.repo);
  });
}

const DOC_OR_CONFIG_PATTERN =
  /(^|\/)(readme|docs|documentation|guide|configuration|config)(\/|\.)|\.md$|\.markdown$|\.toml$|\.yaml$|\.yml$|\.lua$|\.json$|\.rst$/i;

/**
 * Repo-discovery fallback: run each repo_search probe through ghSearchRepos and
 * normalize finds into search results. For each discovered repo, also pull the
 * tree so evidence collection reads real doc/config paths (not just README).
 * Only invoked when code search returned nothing, so known-feature mock/live
 * runs that hit code search are unaffected.
 */
async function discoverReposViaSearch(
  provider: EvidenceProvider,
  repoProbes: SearchProbe[],
  warnings: string[],
): Promise<NormalizedSearchResult[]> {
  const results: NormalizedSearchResult[] = [];
  const seenRepos = new Set<string>();
  // Bound expensive tree fetches: only orient the first few discovered repos.
  let treeBudget = 4;
  for (const probe of repoProbes) {
    let repos: RepoSearchResult[];
    try {
      repos = await provider.searchRepos({ query: probe.query });
    } catch (error) {
      warnings.push(
        `[provider_search_failed] Repo discovery failed for "${probe.query}": ${(error as Error).message}`,
      );
      continue;
    }
    for (const repo of repos.slice(0, 3)) {
      if (seenRepos.has(repo.repo)) continue;
      seenRepos.add(repo.repo);
      const paths = await docPathsFor(provider, repo.repo, warnings, treeBudget > 0);
      if (paths.length > 1) treeBudget -= 1;
      for (const path of paths) {
        results.push({
          repo: repo.repo,
          path,
          probeId: probe.id,
          snippet: repo.description,
          raw: repo,
        });
      }
    }
  }
  return results;
}

async function docPathsFor(
  provider: EvidenceProvider,
  repo: string,
  warnings: string[],
  fetchTree: boolean,
): Promise<string[]> {
  const paths = ["README.md"];
  if (!fetchTree || typeof provider.getRepoTree !== "function") return paths;
  let tree: { paths: string[] };
  try {
    tree = await provider.getRepoTree({ repo });
  } catch (error) {
    warnings.push(`Tree read failed for ${repo}: ${(error as Error).message}`);
    return paths;
  }
  const extra = tree.paths.filter((p) => DOC_OR_CONFIG_PATTERN.test(p)).slice(0, 6);
  for (const p of extra) {
    if (!paths.includes(p)) paths.push(p);
  }
  return paths;
}

export type { SearchProbe };
