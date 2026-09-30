import type {
  CandidateRepo,
  EvidenceAnchor,
  FeatureSpec,
  ResearchRunV2,
  ScoredCandidate,
  SearchProbe,
} from "../schemas/index.js";
import type { EvidenceProvider, NormalizedSearchResult, RepoSearchResult } from "../adapters/EvidenceProvider.js";
import { normalizeFeatureSpec } from "./normalizeFeatureSpec.js";
import { generateSearchProbes } from "./generateSearchProbes.js";
import { collectEvidence } from "./collectEvidence.js";
import { scoreCandidate } from "./scoreCandidate.js";
import { extractPattern, type ExtractedPattern } from "./extractPattern.js";
import { RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION } from "./evidencePolicy.js";
import { candidateClaims, deriveCoverage, questionsFromFeatureSpec } from "./assessment/coverage.js";
import { renderTargetAssertion } from "./assessment/types.js";
import { claimAssessorRegistry } from "./assessment/types.js";
import type { CandidateState, ClaimAssessment, SourceObservation } from "../schemas/researchContracts.js";
import type { ResearchBrief } from "../schemas/researchBrief.js";
import { draftBriefFromGoal } from "./brief/draftBriefFromGoal.js";
import { validateBrief } from "./brief/validateBrief.js";
import { executeBrief } from "./brief/executeBrief.js";

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
  run: ResearchRunV2;
  evidence: EvidenceAnchor[];
  pattern: ExtractedPattern;
}

/** The shared legacy goal adapter used by CLI and MCP goal inputs. */
export async function runPipeline(options: Omit<RunResearchOptions, "hints"> & { hints?: Partial<ResearchBrief> }): Promise<ResearchRunV2> {
  const draft = draftBriefFromGoal(options.goal, options.hints);
  const validated = validateBrief(draft);
  return executeBrief(validated.brief, { provider: options.provider, now: options.now, deterministic: options.deterministic, maxCandidates: options.maxCandidates, maxReposToProve: options.maxReposToProve });
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
  const observationClock = options.deterministic ? () => new Date(DETERMINISTIC_CREATED_AT) : now;
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
  const observations: SourceObservation[] = [];
  const scoredCandidates: ScoredCandidate[] = [];
  const proveLimit = options.maxReposToProve ?? limited.length;
  for (let i = 0; i < limited.length; i += 1) {
    const candidate = limited[i]!;
    let anchors: EvidenceAnchor[] = [];
    if (i < proveLimit) {
      const collected = await collectEvidence(options.provider, featureSpec, candidate, observationClock);
      anchors = collected.anchors;
      observations.push(...collected.observations);
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

  const candidateStates: CandidateState[] = limited.map((candidate) => {
    const repoObservations = observations.filter((observation) => observation.repo === candidate.repo);
    const assessed = repoObservations.length > 0;
    return {
      repo: candidate.repo,
      state: !assessed ? "uninspected" as const
        : repoObservations.some((observation) => observation.readStatus === "complete" || observation.readStatus === "partial")
          ? "inspected" as const : "unavailable" as const,
      ...(!assessed && limited.indexOf(candidate) >= proveLimit ? { reason: "Proof-read limit reached." } : {}),
    };
  });
  const assessments: ClaimAssessment[] = candidateClaims(featureSpec, limited.map((candidate) => candidate.repo)).flatMap((baseClaim) => {
    const requirement = featureSpec.proofRequirements.find((item) => `question_${item.key}` === baseClaim.questionId)!;
    const repoObservations = observations.filter((observation) => observation.repo === baseClaim.subject.repo);
    const roleAnchors = evidence.filter((anchor) => anchor.repo === baseClaim.subject.repo && anchor.role === requirement.key);
    const supportingPath = repoObservations.find((observation) =>
      requirement.signals.length > 0 && requirement.signals.every((signal) => observation.excerpt?.includes(signal)),
    )?.path;
    const projectedAnchor = roleAnchors.find((anchor) => anchor.path === supportingPath) ?? roleAnchors[0];
    const quotationPath = supportingPath ?? projectedAnchor?.path;
    const evidenceObservation = projectedAnchor && repoObservations.find((observation) => observation.path === projectedAnchor.path);
    const method = requirement.key === "dependency_proof" ? "dependency_declaration" : "exact_source_quotation";
    const packageNames = [...new Set(requirement.signals.length > 0 ? requirement.signals : featureSpec.libraries)];
    const targets = method === "dependency_declaration" && packageNames.length > 0
      ? packageNames.map((packageName) => ({ kind: "dependency" as const, packageName, file: "package.json" }))
      : [{ kind: "quotation" as const, path: quotationPath, signals: requirement.signals }];
    return targets.map((target) => {
      const claim = {
        ...baseClaim,
        ...(target?.kind === "dependency" ? { claimId: `${baseClaim.claimId}_${target.packageName.replace(/[^a-zA-Z0-9_-]/g, "_")}` } : {}),
        ...(evidenceObservation?.resolvedRevision ? { subject: { ...baseClaim.subject, revision: evidenceObservation.resolvedRevision } } : {}),
        assertion: target ? renderTargetAssertion(target) : baseClaim.assertion,
        ...(target ? { target } : {}),
      };
      const assessor = claimAssessorRegistry[method];
      if (assessor) return assessor(claim, evidenceObservation && projectedAnchor
        ? repoObservations.map((observation) => observation.id === evidenceObservation.id ? { ...observation, anchor: projectedAnchor } : observation)
        : repoObservations);
      return {
        claimId: claim.claimId, questionId: claim.questionId, subject: claim.subject, assertion: claim.assertion,
        requiredObservationIds: repoObservations.map((observation) => observation.id), status: "not_assessed", method: method as ClaimAssessment["method"],
        assessorOrigin: "engine", evidencePolicyVersion: RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION,
        rationale: `No engine assessor is registered for ${method}.`,
        remainingObligations: ["Register a bounded assessor for this claim method."], limitations: [],
      };
    });
  });
  for (const state of candidateStates) {
    if (state.state === "inspected") {
      const requiredQuestions = questionsFromFeatureSpec(featureSpec);
      state.state = requiredQuestions.length > 0 && requiredQuestions.every((question) =>
        assessments.some((assessment) => assessment.subject.repo === state.repo && assessment.questionId === question.questionId && assessment.status === "supported" && assessment.assessorOrigin === "engine"),
      )
        ? "eligible" : "ineligible";
    }
  }
  const { coverage, outcome: baseOutcome } = deriveCoverage({
    spec: featureSpec, candidates: limited.map((candidate) => candidate.repo), states: candidateStates,
    observations, assessments,
  });
  const outcome = {
    ...baseOutcome,
    reasons: [...baseOutcome.reasons,
      ...(limited.length === 0 ? ["no_candidates"] : []),
      ...(selectedRepos.length === 0 ? ["no_selected_repositories"] : []),
      ...(observations.length === 0 ? ["no_evidence_anchors"] : []),
      ...(warnings.some((warning) => /\[provider_search_failed\]|Provider code search failed/i.test(warning)) ? ["provider_search_failed"] : []),
    ],
  };

  const run: ResearchRunV2 = {
    schemaVersion: 2,
    evidencePolicyVersion: RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION,
    providerName: options.provider.name,
    evidenceOrigin: options.provider.name === "mock" ? "synthetic_mock" : "repository_observation",
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
    observations,
    assessments,
    coverage,
    outcome,
    candidateStates,
    explanationResults: [],
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
