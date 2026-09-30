import type { EvidenceProvider, FileEvidence, FileReadRequest, NormalizedSearchResult, RepoSearchResult } from "../../adapters/EvidenceProvider.js";
import { randomUUID } from "node:crypto";
import { candidateShell } from "../../adapters/EvidenceProvider.js";
import type { ResearchBrief, BriefFact } from "../../schemas/researchBrief.js";
import type { ResearchRunV2 } from "../../schemas/researchRun.js";
import type { BudgetLedger, ProbeOutcome, SearchProbeV2 } from "../../schemas/searchProbeV2.js";
import type { CandidateRepo, FeatureSpec, ProofRequirement, ScoredCandidate } from "../../schemas/index.js";
import { collectEvidence } from "../collectEvidence.js";
import { normalizeFeatureSpec } from "../normalizeFeatureSpec.js";
import { scoreCandidate } from "../scoreCandidate.js";
import { claimAssessorRegistry, renderTargetAssertion, type ClaimTarget } from "../assessment/types.js";
import { RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION } from "../evidencePolicy.js";
import { compileProbes } from "./compileProbes.js";
import { draftBriefFromGoal } from "./draftBriefFromGoal.js";
import { validateBrief } from "./validateBrief.js";
import { deriveBriefCoverage, factLabel, obligationSatisfied } from "../assessment/briefCoverage.js";

export interface ExecuteBriefDeps {
  provider: EvidenceProvider;
  now?: () => Date;
  deterministic?: boolean;
  maxCandidates?: number;
  maxReposToProve?: number;
  validateBrief?: typeof validateBrief;
  draftBriefFromGoal?: typeof draftBriefFromGoal;
  compileProbes?: typeof compileProbes;
  resumeLedger?: BudgetLedger;
  resumeRun?: ResearchRunV2;
  parentRunId?: string;
}

const DEFAULT_TIME = "2026-06-30T00:00:00.000Z";

/** Executes only validated, ready briefs. Seeds skip search while retaining reads and assessment. */
export async function executeBrief(input: ResearchBrief, deps: ExecuteBriefDeps): Promise<ResearchRunV2> {
  const validate = deps.validateBrief ?? validateBrief;
  const brief = validate(input).brief;
  if (deps.resumeRun && (deps.resumeRun.providerName !== deps.provider.name || deps.resumeRun.evidencePolicyVersion !== RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION || deps.resumeRun.brief?.id !== brief.id)) {
    throw new Error(`Resume requires the same brief identity, provider, and evidence policy as its parent (${deps.resumeRun.providerName ?? "unknown"} → ${deps.provider.name}).`);
  }
  const now = deps.now ?? (() => new Date());
  const createdAt = deps.deterministic ? DEFAULT_TIME : now().toISOString();
  const ledger: BudgetLedger = {
    limits: { ...brief.budgets },
    consumed: deps.resumeLedger ? {
      ...deps.resumeLedger.consumed,
      fileReadsByRepo: { ...deps.resumeLedger.consumed.fileReadsByRepo },
    } : { queryUnits: 0, rpcCount: 0, unbudgetedMetadataCalls: 0, metadataCallBreakdown: {}, reconnaissanceReads: 0, fileReads: 0, fileReadsByRepo: {}, refinementRounds: 0, refinementProbes: 0 },
    startedAt: now().toISOString(),
    deadlineAt: new Date(now().getTime() + brief.budgets.deadlineMs).toISOString(),
    cancelled: false,
  };
  const emptyRun = (status: "needs_input" | "inconclusive", reasons: string[]): ResearchRunV2 => ({
    schemaVersion: 2, evidencePolicyVersion: RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION,
    providerName: deps.provider.name,
    evidenceOrigin: deps.provider.name === "mock" ? "synthetic_mock" : "repository_observation",
    id: runId(legacyRunKey(brief), now, deps.deterministic, deps.parentRunId), createdAt, goal: brief.goal,
    featureSpec: makeFeatureSpec(brief), probes: [], probesV2: [], compiledProbes: [], probeOutcomes: [], budgetLedger: ledger,
    brief, candidates: [], scoredCandidates: [], selectedRepos: [], explanations: [], artifacts: [], warnings: [],
    observations: [], assessments: [], coverage: brief.questions.map((question) => ({
      questionId: question.id, status: "not_attempted", supportedClaimIds: [], partialClaimIds: [], contradictedClaimIds: [],
      unsatisfiedObligations: question.obligations.flatMap((obligation) => obligation.facts.map(factLabel)),
      uninspectedCandidates: [], unavailableSources: [], suggestedNextActions: [],
    })),
    outcome: { status, reasons }, candidateStates: [], explanationResults: [],
    ...(deps.parentRunId ? { parentRunId: deps.parentRunId } : {}),
  });
  if (brief.readiness.status === "needs_input") {
    return emptyRun("needs_input", brief.readiness.reasons.map((reason) => reason.code));
  }

  const compiled = (deps.compileProbes ?? compileProbes)(brief, deps.provider.searchCapabilities(), ledger, { allowDegraded: true });
  Object.assign(ledger, compiled.ledger);
  const previous = deps.resumeRun;
  const previousCompleted = new Set((previous?.probeOutcomes ?? []).filter((outcome) => outcome.status !== "not_attempted").map((outcome) => outcome.probeId));
  const previousProbes = new Map((previous?.compiledProbes ?? []).map((probe) => [probe.id, probe]));
  const sameProbe = (left: SearchProbeV2, right: SearchProbeV2 | undefined) => Boolean(right && left.providerQuery === right.providerQuery && JSON.stringify(left.providerArgs) === JSON.stringify(right.providerArgs) && JSON.stringify(left.questionIds) === JSON.stringify(right.questionIds));
  const compiledFresh = compiled.probes.filter((probe) => !previousCompleted.has(probe.id) || !sameProbe(probe, previousProbes.get(probe.id)));
  const reusedProbeCount = compiled.probes.length - compiledFresh.length;
  if (reusedProbeCount) ledger.reserved = { queryUnits: Math.max(0, (ledger.reserved?.queryUnits ?? 0) - reusedProbeCount) };
  const firstByQuestion = new Set<string>();
  const firstPass: SearchProbeV2[] = [];
  const additionalPass: SearchProbeV2[] = [];
  for (const probe of compiledFresh) {
    const requiredIds = probe.questionIds.filter((id) => brief.questions.some((question) => question.id === id && question.required));
    if (requiredIds.some((id) => !firstByQuestion.has(id))) {
      firstPass.push(probe);
      for (const id of requiredIds) firstByQuestion.add(id);
    } else additionalPass.push(probe);
  }
  const scheduled: SearchProbeV2[] = [...firstPass];
  const historyProbes = previous?.compiledProbes ?? [];
  const outcomes: ProbeOutcome[] = [...(previous?.probeOutcomes ?? [])];
  const results: NormalizedSearchResult[] = [];
  const warnings = compiled.failures.map((failure) => `Probe ${failure.questionId} could not compile: ${failure.reason}`);

  const attemptProbe = async (probe: SearchProbeV2): Promise<void> => {
    const started = Date.now();
    if ((ledger.reserved?.queryUnits ?? 0) > 0) ledger.reserved = { queryUnits: ledger.reserved!.queryUnits - 1 };
    const remaining = ledger.limits.queryUnits - ledger.consumed.queryUnits;
    if (remaining <= 0 || now().getTime() >= Date.parse(ledger.deadlineAt ?? createdAt)) {
      const reason = remaining <= 0 ? "query budget exhausted" : "deadline exceeded";
      if (reason === "deadline exceeded") ledger.cancelled = true;
      outcomes.push({ probeId: probe.id, status: "not_attempted", resultIds: [], queryUnits: 0, requestCount: 0, reason, predecessorProbeIds: probe.predecessorProbeIds });
      return;
    }
    try {
      let found: NormalizedSearchResult[];
      let requestCount = 1;
      if (probe.providerArgs.endpoint === "repoSearch") {
        const repos: RepoSearchResult[] = await deps.provider.searchRepos({ query: probe.providerQuery });
        found = repos.map((repo) => ({ repo: repo.repo, path: typeof probe.providerArgs.path === "string" ? probe.providerArgs.path : "README.md", probeId: probe.id, snippet: repo.description, raw: repo }));
      } else if (probe.providerArgs.endpoint === "issueSearch") {
        if (!deps.provider.searchIssues) throw new Error("source_access_unavailable: provider does not implement issue search; no absence claim was made.");
        const issues = await deps.provider.searchIssues({ query: probe.providerQuery, maxResults: 10 });
        found = issues.map((issue) => ({ repo: issue.repo, path: `issues/${issue.number}`, probeId: probe.id, snippet: `${issue.title} ${issue.body}`.slice(0, 200) }));
      } else {
        const legacyProbe = { id: probe.id, kind: probe.purpose === "source_location" ? "path_targeted" as const : "high_precision" as const, query: probe.providerQuery, rationale: probe.rationale, expectedSignals: brief.vocabulary.filter((term) => probe.termIds.includes(term.id)).map((term) => term.text) };
        found = await deps.provider.searchCode([legacyProbe]);
        found = found.map((result) => ({ ...result, probeId: probe.id }));
      }
      ledger.consumed.queryUnits += 1;
      ledger.consumed.rpcCount += requestCount;
      results.push(...found);
      const resultIds = found.map((result) => `${result.repo}:${result.path}`);
      const truncated = found.some((result) => result.truncated);
      outcomes.push({ probeId: probe.id, status: "succeeded", resultClass: truncated ? "pagination_limit" : found.length === 0 ? "empty" : "relevant_leads", basis: truncated ? `Provider marked results incomplete (${found.length} lead(s) returned).` : found.length === 0 ? "Provider returned zero results for this query." : `Provider returned ${found.length} result(s).`, ...(truncated ? { truncated: true } : {}), resultIds, queryUnits: 1, requestCount, durationMs: Date.now() - started, predecessorProbeIds: probe.predecessorProbeIds });
    } catch (error) {
      ledger.consumed.queryUnits += 1;
      ledger.consumed.rpcCount += 1;
      const failureKind = error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "access_denied" ? "access_denied" as const : "transport_failure" as const;
      outcomes.push({ probeId: probe.id, status: "failed", errorClass: error instanceof Error ? error.name : "ProviderError", failureKind, reason: error instanceof Error ? error.message : String(error), resultIds: [], queryUnits: 1, requestCount: 1, durationMs: Date.now() - started, predecessorProbeIds: probe.predecessorProbeIds });
      warnings.push(`Probe ${probe.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (const probe of firstPass) await attemptProbe(probe);
  const leadCoverage = new Map<string, number>();
  for (const outcome of outcomes) {
    const linked = [...historyProbes, ...scheduled].find((probe) => probe.id === outcome.probeId);
    for (const questionId of linked?.questionIds ?? []) leadCoverage.set(questionId, (leadCoverage.get(questionId) ?? 0) + outcome.resultIds.length);
  }
  additionalPass.sort((left, right) => {
    const score = (probe: SearchProbeV2) => probe.questionIds.reduce((sum, questionId) => sum + (leadCoverage.get(questionId) ?? 0), 0);
    return score(left) - score(right);
  });
  for (const probe of additionalPass) {
    scheduled.push(probe);
    await attemptProbe(probe);
  }

  // One bounded query broadening pass can recover an empty scoped result. It
  // only removes a qualifier from a query that actually returned empty; a
  // provider failure never triggers a semantic rewrite.
  if (ledger.limits.refinementRounds > ledger.consumed.refinementRounds && ledger.limits.refinementProbes > ledger.consumed.refinementProbes) {
    const emptyOutcomes = outcomes.filter((outcome) => outcome.status === "succeeded" && outcome.resultClass === "empty");
    const refinements = emptyOutcomes.flatMap((outcome) => {
      const original = [...historyProbes, ...scheduled].find((probe) => probe.id === outcome.probeId);
      if (!original || !/\b(?:language|path|filename|extension|repo|org):[^\s]+/i.test(original.providerQuery)) return [];
      const providerQuery = original.providerQuery.replace(/\b(?:language|path|filename|extension|repo|org):[^\s]+/ig, "").replace(/\s+/g, " ").trim();
      if (!providerQuery || providerQuery === original.providerQuery || [...historyProbes, ...scheduled].some((probe) => probe.providerQuery === providerQuery)) return [];
      return [{ ...original, id: `${original.id}-refine-1`, providerQuery, providerArgs: { ...original.providerArgs, query: providerQuery }, rationale: `One bounded broadening after an empty scoped result for question ${original.questionIds.join(", ")}.`, predecessorProbeIds: [original.id], refinementReason: "empty_scoped_result" as const }];
    }).slice(0, Math.min(4, ledger.limits.refinementProbes - ledger.consumed.refinementProbes));
    if (refinements.length && ledger.consumed.queryUnits < ledger.limits.queryUnits && now().getTime() < Date.parse(ledger.deadlineAt ?? createdAt)) {
      ledger.consumed.refinementRounds += 1;
      for (const probe of refinements) {
        if (ledger.consumed.queryUnits >= ledger.limits.queryUnits || now().getTime() >= Date.parse(ledger.deadlineAt ?? createdAt)) break;
        const started = now().getTime();
        try {
          const legacyProbe = { id: probe.id, kind: "high_precision" as const, query: probe.providerQuery, rationale: probe.rationale, expectedSignals: brief.vocabulary.filter((term) => probe.termIds.includes(term.id)).map((term) => term.text) };
          const found = (await deps.provider.searchCode([legacyProbe])).map((result) => ({ ...result, probeId: probe.id }));
          ledger.consumed.queryUnits += 1;
          ledger.consumed.rpcCount += 1;
          ledger.consumed.refinementProbes += 1;
          results.push(...found);
          outcomes.push({ probeId: probe.id, status: "succeeded", resultClass: found.some((result) => result.truncated) ? "pagination_limit" : found.length ? "relevant_leads" : "empty", basis: found.length ? `Refined provider query returned ${found.length} lead(s).` : "Refined provider query returned zero results.", ...(found.some((result) => result.truncated) ? { truncated: true } : {}), resultIds: found.map((result) => `${result.repo}:${result.path}`), queryUnits: 1, requestCount: 1, durationMs: Math.max(0, now().getTime() - started), predecessorProbeIds: probe.predecessorProbeIds });
          scheduled.push(probe);
        } catch (error) {
          ledger.consumed.queryUnits += 1;
          ledger.consumed.rpcCount += 1;
          ledger.consumed.refinementProbes += 1;
          const failureKind = error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "access_denied" ? "access_denied" as const : "transport_failure" as const;
          outcomes.push({ probeId: probe.id, status: "failed", failureKind, errorClass: error instanceof Error ? error.name : "ProviderError", reason: error instanceof Error ? error.message : String(error), resultIds: [], queryUnits: 1, requestCount: 1, durationMs: Math.max(0, now().getTime() - started), predecessorProbeIds: probe.predecessorProbeIds });
        }
      }
    }
  }
  if (now().getTime() >= Date.parse(ledger.deadlineAt ?? createdAt)) ledger.cancelled = true;

  // Completed probe leads are reusable; every resumed source is re-read below
  // before it can support a current claim.

  const associations = new Map<string, Set<string>>();
  const paths = new Map<string, Set<string>>();
  for (const candidate of previous?.candidates ?? []) {
    associations.set(candidate.repo, new Set(candidate.discoveredBy));
    paths.set(candidate.repo, new Set(candidate.matchedPaths));
  }
  for (const result of results) {
    (associations.get(result.repo) ?? (associations.set(result.repo, new Set()), associations.get(result.repo)!)).add(result.probeId);
    (paths.get(result.repo) ?? (paths.set(result.repo, new Set()), paths.get(result.repo)!)).add(result.path);
  }
  for (const seed of brief.seeds) {
    if (!associations.has(seed.repo)) associations.set(seed.repo, new Set());
    if (!paths.has(seed.repo)) paths.set(seed.repo, new Set(expectedPaths(brief)));
  }
  const probeQuestions = new Map([...historyProbes, ...scheduled].map((probe) => [probe.id, probe.questionIds]));
  const repoNames = [...associations.keys()].sort((left, right) => {
    const score = (repo: string) => [...(associations.get(repo) ?? [])].flatMap((probeId) => probeQuestions.get(probeId) ?? []).reduce((sum, questionId) => sum + (leadCoverage.get(questionId) ?? 0), 0);
    return score(left) - score(right);
  }).slice(0, deps.maxCandidates ?? 25);
  const candidates: CandidateRepo[] = [];
  for (const repo of repoNames) {
    if (now().getTime() >= Date.parse(ledger.deadlineAt ?? createdAt)) {
      ledger.cancelled = true;
      break;
    }
    try {
      ledger.consumed.rpcCount += 1;
      recordMetadataCall(ledger, "repoMetadata");
      const metadata = await deps.provider.getRepoMetadata({ repo });
      const shell = candidateShell(repo);
      candidates.push({ ...shell, ...metadata, discoveredBy: [...(associations.get(repo) ?? [])], matchedPaths: [...(paths.get(repo) ?? [])], candidateSignals: [{ key: "brief_seed_or_probe", label: brief.seeds.some((seed) => seed.repo === repo) ? `Caller supplied seed (${brief.seeds.find((seed) => seed.repo === repo)!.origin}); discovery bypassed.` : "Found by a compiled brief probe; this is a lead, not proof.", source: "search", confidence: 0.25 }] });
    } catch (error) {
      warnings.push(`Metadata read failed for ${repo}: ${error instanceof Error ? error.message : String(error)}`);
      const [owner = "unknown", name = repo] = repo.split("/");
      candidates.push({ repo, owner, name, discoveredBy: [...(associations.get(repo) ?? [])], matchedPaths: [...(paths.get(repo) ?? [])], candidateSignals: [] });
    }
  }
  const observations = [] as Awaited<ReturnType<typeof collectEvidence>>["observations"];
  const anchors = [] as Awaited<ReturnType<typeof collectEvidence>>["anchors"];
  const readProvider = budgetedReadProvider(deps.provider, ledger, now);
  for (const [index, candidate] of candidates.entries()) {
    if (index >= (deps.maxReposToProve ?? candidates.length)) continue;
    const collected = await collectEvidence(readProvider, makeFeatureSpec(brief), candidate, deps.deterministic ? () => new Date(DEFAULT_TIME) : now, { allowedSourceKinds: brief.allowedSourceKinds });
    observations.push(...collected.observations);
    anchors.push(...collected.anchors);
    warnings.push(...collected.warnings);
    for (const untouched of collected.untouched) {
      const receipt = ledger.exhaustion ?? { questions: [], repositories: [], referencedFiles: [] };
      if (!receipt.referencedFiles.some((file) => file.repo === candidate.repo && file.path === untouched.path)) {
        receipt.referencedFiles.push({ repo: candidate.repo, path: untouched.path, reason: untouched.reason });
      }
      ledger.exhaustion = receipt;
    }
  }
  for (const candidate of candidates) {
    const repoAnchors = anchors.filter((anchor) => anchor.repo === candidate.repo);
    if (repoAnchors.length) candidate.candidateSignals.push({ key: "source_observation", label: `${repoAnchors.length} source anchor(s) collected for assessment.`, source: "file", confidence: 0.5, evidence: repoAnchors });
  }

  const allowedObservations = observations.filter((observation) => brief.allowedSourceKinds.includes(observation.kind));
  const assessments = assessBrief(brief, candidates, allowedObservations);
  const { coverage, outcome } = deriveBriefCoverage({
    brief, candidateRepos: candidates.map((candidate) => candidate.repo), observations, assessments,
    probes: [...historyProbes, ...scheduled], probeOutcomes: outcomes, providerName: deps.provider.name,
  });
  const scoredCandidates: ScoredCandidate[] = candidates.map((candidate) => scoreCandidate(makeFeatureSpec(brief), candidate, anchors.filter((anchor) => anchor.repo === candidate.repo), { now: now() }));
  const candidateStates = candidates.map((candidate) => {
    const inspected = observations.some((observation) => observation.repo === candidate.repo);
    const eligible = brief.questions.filter((question) => question.required).every((question) => question.obligations.every((obligation, obligationIndex) => obligationSatisfied(question.id, obligation, obligationIndex, [candidate.repo], assessments)));
    return { repo: candidate.repo, state: eligible ? "eligible" as const : inspected ? "ineligible" as const : "uninspected" as const, ...(brief.seeds.some((seed) => seed.repo === candidate.repo) ? { reason: `Caller supplied seed (${brief.seeds.find((seed) => seed.repo === candidate.repo)!.origin}); no proof credit without source assessment.` } : {}) };
  });
  ledger.elapsedMs = (deps.resumeLedger?.elapsedMs ?? 0) + Math.max(0, now().getTime() - Date.parse(ledger.startedAt ?? createdAt));
  const untouchedQuestions = coverage.filter((item) => brief.questions.find((question) => question.id === item.questionId)?.required && item.status !== "satisfied").map((item) => ({ questionId: item.questionId, reason: item.status === "not_attempted" ? "No probe or source read was attempted." : "The question was attempted but remains unresolved." }));
  const untouchedRepos = candidates.filter((candidate) => {
    const repoObservations = observations.filter((observation) => observation.repo === candidate.repo);
    return repoObservations.length === 0 || repoObservations.every((observation) => observation.readStatus === "unavailable" && /budget|deadline/i.test(observation.truncationNotice ?? ""));
  }).map((candidate) => ({ repo: candidate.repo, reason: ledger.consumed.fileReads >= ledger.limits.fileReads ? "file-read budget exhausted" : ledger.cancelled ? "run deadline reached" : "repository was not inspected within the candidate/proof cap" }));
  const referencedFiles = (ledger.exhaustion?.referencedFiles ?? []);
  if (untouchedQuestions.length || untouchedRepos.length || referencedFiles.length) ledger.exhaustion = { questions: untouchedQuestions, repositories: untouchedRepos, referencedFiles };
  const allProbes = [...historyProbes, ...scheduled];
  const legacyProbes = allProbes.map(toLegacyProbe);
  return {
    schemaVersion: 2, evidencePolicyVersion: RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION,
    providerName: deps.provider.name,
    evidenceOrigin: deps.provider.name === "mock" ? "synthetic_mock" : "repository_observation",
    id: runId(legacyRunKey(brief), now, deps.deterministic, deps.parentRunId), createdAt, goal: brief.goal, featureSpec: makeFeatureSpec(brief),
    probes: legacyProbes, probesV2: allProbes, compiledProbes: allProbes, probeOutcomes: outcomes, budgetLedger: ledger, brief,
    candidates, scoredCandidates, selectedRepos: scoredCandidates.map((candidate) => candidate.repo), explanations: [], artifacts: [],
    warnings: [...new Set(warnings)], observations, assessments, coverage, outcome, candidateStates, explanationResults: [],
    ...(deps.parentRunId ? { parentRunId: deps.parentRunId } : {}),
  };
}

function makeFeatureSpec(brief: ResearchBrief): FeatureSpec {
  const proofRequirements: ProofRequirement[] = brief.questions.flatMap((question) => question.obligations.flatMap((obligation, index) => obligation.facts.map((fact, factIndex) => ({ key: `${question.id}_${index}_${factIndex}`, description: factLabel(fact), required: question.required, signals: fact.kind === "dependency" ? [fact.packageName] : fact.kind === "config" ? [fact.keyPath, ...(fact.value === undefined ? [] : [String(fact.value)])] : fact.kind === "workflow" ? [fact.command] : fact.signals }))))
  const terms = brief.vocabulary.map((term) => term.text);
  return normalizeFeatureSpec(brief.goal, { goalKind: "research", feature: brief.goal, featureKey: legacyFeatureKey(brief), requiredConcepts: [...new Set([...terms, ...proofRequirements.flatMap((item) => item.signals)])], proofRequirements });
}

function legacyFeatureKey(brief: ResearchBrief): string | undefined {
  try {
    return normalizeFeatureSpec(brief.goal).featureKey;
  } catch {
    return undefined;
  }
}

function legacyRunKey(brief: ResearchBrief): string {
  return legacyFeatureKey(brief)?.replace(/-/g, "_") ?? brief.id;
}

function assessBrief(brief: ResearchBrief, candidates: CandidateRepo[], observations: Parameters<NonNullable<typeof claimAssessorRegistry[string]>>[1] extends readonly (infer T)[] ? T[] : never): ResearchRunV2["assessments"] {
  const assessments: ResearchRunV2["assessments"] = [];
  for (const question of brief.questions) {
    question.obligations.forEach((obligation, obligationIndex) => {
      for (const [factIndex, fact] of obligation.facts.entries()) {
        const method = fact.kind === "dependency" ? "dependency_declaration" : fact.kind === "config" ? "config_value" : fact.kind === "workflow" ? "workflow_command" : "exact_source_quotation";
        const target: ClaimTarget = fact.kind === "quotation" ? fact : fact;
        for (const candidate of candidates) {
          const repoObservations = observations.filter((observation) => observation.repo === candidate.repo);
          const revisionBoundFact = fact.kind !== "quotation" || !fact.path?.startsWith("issues/");
          const revisions = revisionBoundFact
            ? [...new Set(repoObservations.flatMap((observation) => observation.revisionStatus === "immutable" && observation.resolvedRevision ? [observation.resolvedRevision] : []))]
            : [];
          const base = { claimId: `claim_${question.id}_${obligationIndex}_${factIndex}_${fact.kind}_${candidate.repo.replace(/[^a-zA-Z0-9_-]/g, "_")}`, questionId: question.id, subject: { repo: candidate.repo, ...(revisions.length === 1 ? { revision: revisions[0] } : {}) }, assertion: renderTargetAssertion(target), target };
          const assessor = claimAssessorRegistry[method];
          if (assessor) {
            const assessment = assessor(base, observations);
            if (revisionBoundFact && revisions.length === 0 && repoObservations.some((observation) => observation.kind === "repository_file")) {
              const limitation = repoObservations.some((observation) => observation.revisionStatus === "moving_ref")
                ? "The source was read from a moving branch; its revision may change between runs."
                : "The source revision is unknown, so this assessment cannot be tied to an immutable commit.";
              assessment.limitations = [...new Set([...assessment.limitations, limitation])];
            }
            assessments.push(assessment);
          }
        }
      }
    });
  }
  return assessments;
}


function expectedPaths(brief: ResearchBrief): string[] {
  const paths = brief.questions.flatMap((question) => question.obligations.flatMap((obligation) => obligation.facts.map((fact) => {
    if (fact.kind === "dependency") return fact.file ?? "package.json";
    if (fact.kind === "config") return fact.file ?? "README.md";
    if (fact.kind === "workflow") return fact.file ?? ".github/workflows/ci.yml";
    return fact.path ?? "README.md";
  })));
  return [...new Set(paths.length ? paths : ["README.md"])];
}


function toLegacyProbe(probe: SearchProbeV2) {
  return { id: probe.id, kind: probe.purpose === "source_location" ? "path_targeted" as const : "high_precision" as const, query: probe.providerQuery, rationale: probe.rationale, expectedSignals: [] };
}

function runId(briefId: string, now: () => Date, deterministic = false, parentRunId?: string): string {
  const safeBriefId = briefId.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (deterministic && !parentRunId) return `run_mock_${safeBriefId}`;
  return `run_${deterministic ? "mock_" : ""}${safeBriefId}_${now().getTime()}_${randomUUID().slice(0, 8)}`;
}

function budgetedReadProvider(provider: EvidenceProvider, ledger: BudgetLedger, now: () => Date): EvidenceProvider {
  const base = Date.parse(ledger.startedAt ?? now().toISOString());
  return {
    name: provider.name,
    searchCapabilities: () => provider.searchCapabilities(),
    searchCode: (probes) => provider.searchCode(probes),
    searchRepos: (query) => provider.searchRepos(query),
    getRepoMetadata: (repo) => provider.getRepoMetadata(repo),
    ...(provider.resolveRevision ? { resolveRevision: async (input: Parameters<NonNullable<EvidenceProvider["resolveRevision"]>>[0]) => {
      if (provider.name !== "mock") {
        ledger.consumed.rpcCount += 1;
        recordMetadataCall(ledger, "revisionResolution");
      }
      return provider.resolveRevision!(input);
    } } : {}),
    getFile: async (input: FileReadRequest): Promise<FileEvidence> => {
      const repoReads = ledger.consumed.fileReadsByRepo[input.repo] ?? 0;
      const elapsed = Math.max(0, now().getTime() - base);
      const deadline = elapsed >= ledger.limits.deadlineMs;
      const blocked = deadline || ledger.consumed.fileReads >= ledger.limits.fileReads || repoReads >= ledger.limits.fileReadsPerRepo;
      if (blocked) {
        if (deadline) ledger.cancelled = true;
        const reason = deadline ? "run deadline reached" : repoReads >= ledger.limits.fileReadsPerRepo ? "per-repository file-read budget exhausted" : "file-read budget exhausted";
        const receipt = ledger.exhaustion ?? { questions: [], repositories: [], referencedFiles: [] };
        if (!receipt.referencedFiles.some((file) => file.repo === input.repo && file.path === input.path)) receipt.referencedFiles.push({ repo: input.repo, path: input.path, reason });
        ledger.exhaustion = receipt;
        return { provider: provider.name, repo: input.repo, path: input.path, readStatus: "unavailable", unavailableReason: reason };
      }
      ledger.consumed.fileReads += 1;
      ledger.consumed.rpcCount += 1;
      ledger.consumed.fileReadsByRepo[input.repo] = repoReads + 1;
      return provider.getFile(input);
    },
    ...(provider.getIssue ? { getIssue: async (input: { repo: string; number: number }) => {
      const repoReads = ledger.consumed.fileReadsByRepo[input.repo] ?? 0;
      const elapsed = Math.max(0, now().getTime() - base);
      const deadline = elapsed >= ledger.limits.deadlineMs;
      const blocked = deadline || ledger.consumed.fileReads >= ledger.limits.fileReads || repoReads >= ledger.limits.fileReadsPerRepo;
      if (blocked) {
        if (deadline) ledger.cancelled = true;
        const reason = deadline ? "run deadline reached" : repoReads >= ledger.limits.fileReadsPerRepo ? "per-repository file-read budget exhausted" : "file-read budget exhausted";
        const receipt = ledger.exhaustion ?? { questions: [], repositories: [], referencedFiles: [] };
        const path = `issues/${input.number}`;
        if (!receipt.referencedFiles.some((file) => file.repo === input.repo && file.path === path)) receipt.referencedFiles.push({ repo: input.repo, path, reason });
        ledger.exhaustion = receipt;
        throw new Error(reason);
      }
      ledger.consumed.fileReads += 1;
      ledger.consumed.rpcCount += 1;
      ledger.consumed.fileReadsByRepo[input.repo] = repoReads + 1;
      return provider.getIssue!(input);
    } } : {}),
    ...(provider.getRepoTree ? { getRepoTree: (repo) => provider.getRepoTree!(repo) } : {}),
    ...(provider.cloneRepo ? { cloneRepo: (repo) => provider.cloneRepo!(repo) } : {}),
  };
}

function recordMetadataCall(ledger: BudgetLedger, kind: string): void {
  ledger.consumed.unbudgetedMetadataCalls = (ledger.consumed.unbudgetedMetadataCalls ?? 0) + 1;
  const breakdown = ledger.consumed.metadataCallBreakdown ?? (ledger.consumed.metadataCallBreakdown = {});
  breakdown[kind] = (breakdown[kind] ?? 0) + 1;
}
