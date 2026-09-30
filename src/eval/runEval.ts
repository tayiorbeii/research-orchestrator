import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MockEvidenceProvider } from "../adapters/MockEvidenceProvider.js";
import type { EvidenceProvider, FileReadRequest, NormalizedSearchResult, RepoRef, RepoSearchQuery } from "../adapters/EvidenceProvider.js";
import { executeBrief } from "../core/brief/executeBrief.js";
import { draftBriefFromGoal } from "../core/brief/draftBriefFromGoal.js";
import { ResearchRunSchema, detectRunVersion, type ResearchRunV2 } from "../schemas/index.js";
import { BENCHMARK_TASKS, corpusFor, type BenchmarkTask } from "./benchmarkTasks.js";

export interface TaskEvalMetrics {
  taskId: string;
  split: "tuning" | "held_out";
  surface: "brief" | "goal";
  intentGroups: Array<{ questionId: string; intent: string; usefulSourcesFound: number; relevantSourcesLabeled: number }>;
  supportedClaimPrecision: { trueSupported: number; falseSupported: number; labeledSupported: number; precision: number | null };
  unsupportedVerificationCount: { claimOverclaims: number; answerLevelOverclaims: number; total: number };
  questionCoverage: {
    expected: number;
    satisfied: number;
    byQuestion: Array<{ questionId: string; expected: string; actual: string }>;
    coverageMatch: boolean;
    coverageMismatchQuestionIds: string[];
    untouchedRequired: string[];
    expectedUntouched: string[];
    untouchedMatch: boolean;
  };
  cost: { queryCount: number; fileReadCount: number; msToFirstUsefulObservation: number | null; msToOutcome: number };
  events: { providerFailures: number; partialReads: number; budgetStops: number; clarificationOrAbstention: number };
  legacyRoundTripLosses: { count: number; fields: string[] };
  knownDefect?: string;
}

export interface EvalReport {
  evaluationKind: "mock_replay";
  synthetic: true;
  note: string;
  createdAt: string;
  corpus: { fixtureCount: number; tuningFixtures: string[]; heldOutFixtures: string[] };
  metrics: TaskEvalMetrics[];
  totals: {
    supportedClaimPrecision: { trueSupported: number; falseSupported: number; labeledSupported: number; precision: number | null };
    unsupportedVerificationCount: { claimOverclaims: number; answerLevelOverclaims: number; total: number };
    questionCoverage: { expected: number; satisfied: number; untouchedRequired: number };
    cost: { queryCount: number; fileReadCount: number; msToFirstUsefulObservation: number | null; msToOutcome: number };
    events: { providerFailures: number; partialReads: number; budgetStops: number; clarificationOrAbstention: number };
    legacyRoundTripLosses: { count: number; fields: string[] };
  };
}

export interface RunEvalOptions { tasks?: BenchmarkTask[]; outFile?: string; }

/** Run only the frozen, fully synthetic fixture corpus. This never selects a live provider. */
export async function runEval(options: RunEvalOptions = {}): Promise<EvalReport> {
  const tasks = options.tasks ?? BENCHMARK_TASKS;
  const metrics: TaskEvalMetrics[] = [];
  for (const task of tasks) metrics.push(await evaluateTask(task));
  const report: EvalReport = {
    evaluationKind: "mock_replay", synthetic: true,
    note: "Mock replay over frozen synthetic corpora; not a live provider evaluation and no live calls were made.",
    createdAt: new Date().toISOString(),
    corpus: {
      fixtureCount: tasks.length,
      tuningFixtures: tasks.filter((task) => task.split === "tuning").map((task) => task.id),
      heldOutFixtures: tasks.filter((task) => task.split === "held_out").map((task) => task.id),
    },
    metrics,
    totals: totalMetrics(metrics),
  };
  if (options.outFile) {
    await mkdir(dirname(options.outFile), { recursive: true });
    await writeFile(options.outFile, JSON.stringify(report, null, 2), "utf8");
  }
  return report;
}

async function evaluateTask(task: BenchmarkTask): Promise<TaskEvalMetrics> {
  const corpus = corpusFor(task);
  const provider = new ReplayProvider(corpus.candidates, corpus.fileContents, corpus.issues);
  const start = Date.now();
  const requestedBrief = task.surface === "goal" ? draftBriefFromGoal(task.goal) : task.brief;
  const run = await executeBrief(requestedBrief, { provider, deterministic: true });
  const elapsed = Date.now() - start;
  const labeled = task.labels.supportedFacts;
  const supported = run.assessments.filter((assessment) => assessment.status === "supported");
  const matched = supported.filter((assessment) => labeled.some((fact) =>
    assessment.questionId === fact.questionId && assessment.subject.repo === task.sources.find((source) => source.id === fact.sourceId)?.repo && assessment.assertion.includes(fact.assertionIncludes),
  ));
  const claimOverclaims = supported.length - matched.length;
  const answerLevelOverclaims = run.explanations.flatMap((explanation) => explanation.answers).filter((answer) =>
    answer.verified && !answer.evidence.some((anchor) => anchor.proofLevel === "proved" && labeled.some((fact) => fact.questionId === task.brief.questions.find((question) => question.statement === answer.question)?.id)),
  ).length;
  const precisionDenominator = supported.length;
  const relevantSources = task.sources.filter((source) => task.labels.relevantSourceIds.includes(source.id));
  const firstUseful = provider.readEvents.find((read) => relevantSources.some((source) => source.repo === read.repo && source.path === read.path));
  const totalByIntent = task.brief.questions.map((question) => {
    const relevantForQuestion = task.labels.supportedFacts.filter((fact) => fact.questionId === question.id).map((fact) => task.sources.find((source) => source.id === fact.sourceId)).filter((source) => source && task.labels.relevantSourceIds.includes(source.id));
    const found = relevantForQuestion.filter((source) => source!.kind === "issue_proposal"
      ? run.observations.some((observation) => observation.kind === "issue_proposal" && observation.repo === source!.repo && observation.path === source!.path)
      : run.candidates.some((candidate) => candidate.repo === source!.repo && candidate.matchedPaths.includes(source!.path))).length;
    return { questionId: question.id, intent: question.intentHints.join("+"), usefulSourcesFound: found, relevantSourcesLabeled: new Set(relevantForQuestion.map((source) => source!.id)).size };
  });
  const coverage = run.coverage;
  const byQuestion = Object.entries(task.labels.expectedQuestionCoverage).map(([questionId, expected]) => ({
    questionId, expected,
    actual: coverage.find((item) => item.questionId === questionId)?.status ?? "missing",
  }));
  const coverageMismatchQuestionIds = byQuestion.filter((item) => item.actual !== item.expected).map((item) => item.questionId);
  const untouchedRequired = coverage.filter((item) => task.brief.questions.some((question) => question.id === item.questionId && question.required) && item.status === "not_attempted").map((item) => item.questionId);
  const losses = legacyLosses(run);
  return {
    taskId: task.id, split: task.split, surface: task.surface, intentGroups: totalByIntent,
    supportedClaimPrecision: { trueSupported: matched.length, falseSupported: claimOverclaims, labeledSupported: labeled.length, precision: precisionDenominator ? matched.length / precisionDenominator : null },
    unsupportedVerificationCount: { claimOverclaims, answerLevelOverclaims, total: claimOverclaims + answerLevelOverclaims },
    questionCoverage: {
      expected: Object.keys(task.labels.expectedQuestionCoverage).length,
      satisfied: coverage.filter((item) => item.status === "satisfied").length,
      byQuestion,
      coverageMatch: coverageMismatchQuestionIds.length === 0,
      coverageMismatchQuestionIds,
      untouchedRequired, expectedUntouched: task.labels.expectedUntouchedQuestions,
      untouchedMatch: [...untouchedRequired].sort().join("|") === [...task.labels.expectedUntouchedQuestions].sort().join("|"),
    },
    cost: {
      queryCount: run.budgetLedger?.consumed.queryUnits ?? run.probeOutcomes?.filter((item) => item.queryUnits > 0).length ?? 0,
      fileReadCount: run.budgetLedger?.consumed.fileReads ?? provider.readEvents.length,
      msToFirstUsefulObservation: firstUseful ? Math.max(0, firstUseful.at - start) : null,
      msToOutcome: elapsed,
    },
    events: {
      providerFailures: run.probeOutcomes?.filter((outcome) => outcome.status === "failed").length ?? 0,
      partialReads: run.observations.filter((observation) => observation.readStatus === "partial").length,
      budgetStops: (run.budgetLedger?.exhaustion?.questions.length ?? 0) + (run.budgetLedger?.exhaustion?.repositories.length ?? 0) + (run.budgetLedger?.exhaustion?.referencedFiles.length ?? 0),
      clarificationOrAbstention: run.outcome.status === "needs_input" || run.outcome.status === "inconclusive" ? 1 : 0,
    },
    legacyRoundTripLosses: losses,
    ...(task.knownDefect ? { knownDefect: task.knownDefect } : {}),
  };
}

/** The compatibility projection intentionally does not claim to preserve v2-only ledger fields. */
function legacyLosses(run: ResearchRunV2): { count: number; fields: string[] } {
  const projection = {
    id: run.id, createdAt: run.createdAt, goal: run.goal, featureSpec: run.featureSpec, probes: run.probes,
    candidates: run.candidates, scoredCandidates: run.scoredCandidates, selectedRepos: run.selectedRepos,
    explanations: run.explanations, artifacts: run.artifacts, warnings: run.warnings,
  };
  const parsed = ResearchRunSchema.safeParse(projection);
  if (!parsed.success || detectRunVersion(projection) !== "v1") return { count: 1, fields: ["legacy_projection_invalid"] };
  const v2Values: Record<string, unknown> = {
    evidencePolicyVersion: run.evidencePolicyVersion, evidenceOrigin: run.evidenceOrigin, observations: run.observations,
    assessments: run.assessments, coverage: run.coverage, outcome: run.outcome, candidateStates: run.candidateStates,
    explanationResults: run.explanationResults, brief: run.brief, compiledProbes: run.compiledProbes,
    probeOutcomes: run.probeOutcomes, budgetLedger: run.budgetLedger,
  };
  const fields = Object.entries(v2Values).filter(([, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true)).map(([key]) => key);
  return { count: fields.length, fields };
}

function totalMetrics(metrics: TaskEvalMetrics[]): EvalReport["totals"] {
  const sum = (selector: (item: TaskEvalMetrics) => number) => metrics.reduce((total, item) => total + selector(item), 0);
  const supported = sum((item) => item.supportedClaimPrecision.trueSupported);
  const falseSupported = sum((item) => item.supportedClaimPrecision.falseSupported);
  const denominator = supported + falseSupported;
  const fields = [...new Set(metrics.flatMap((item) => item.legacyRoundTripLosses.fields))];
  const firstObservation = metrics.map((item) => item.cost.msToFirstUsefulObservation).filter((value): value is number => value !== null);
  return {
    supportedClaimPrecision: { trueSupported: supported, falseSupported, labeledSupported: sum((item) => item.supportedClaimPrecision.labeledSupported), precision: denominator ? supported / denominator : null },
    unsupportedVerificationCount: { claimOverclaims: sum((item) => item.unsupportedVerificationCount.claimOverclaims), answerLevelOverclaims: sum((item) => item.unsupportedVerificationCount.answerLevelOverclaims), total: sum((item) => item.unsupportedVerificationCount.total) },
    questionCoverage: { expected: sum((item) => item.questionCoverage.expected), satisfied: sum((item) => item.questionCoverage.satisfied), untouchedRequired: sum((item) => item.questionCoverage.untouchedRequired.length) },
    cost: { queryCount: sum((item) => item.cost.queryCount), fileReadCount: sum((item) => item.cost.fileReadCount), msToFirstUsefulObservation: firstObservation.length ? Math.round(firstObservation.reduce((a, b) => a + b, 0) / firstObservation.length) : null, msToOutcome: sum((item) => item.cost.msToOutcome) },
    events: { providerFailures: sum((item) => item.events.providerFailures), partialReads: sum((item) => item.events.partialReads), budgetStops: sum((item) => item.events.budgetStops), clarificationOrAbstention: sum((item) => item.events.clarificationOrAbstention) },
    legacyRoundTripLosses: { count: sum((item) => item.legacyRoundTripLosses.count), fields },
  };
}

class ReplayProvider extends MockEvidenceProvider implements EvidenceProvider {
  readonly readEvents: Array<{ repo: string; path: string; at: number }> = [];
  constructor(private readonly candidates: ReturnType<typeof corpusFor>["candidates"], private readonly files: Record<string, Record<string, string>>, private readonly issues: ReturnType<typeof corpusFor>["issues"]) { super(); }
  override async getCandidates() { return this.candidates; }
  override async searchCode(probes: Parameters<EvidenceProvider["searchCode"]>[0]): Promise<NormalizedSearchResult[]> {
    return this.candidates.flatMap((candidate) => candidate.matchedPaths.map((path) => ({ repo: candidate.repo, path, probeId: probes[0]?.id ?? "replay", snippet: candidate.candidateSignals[0]?.label })));
  }
  override async searchRepos(_query: RepoSearchQuery) { return this.candidates.map((candidate) => ({ repo: candidate.repo, url: candidate.url })); }
  override async searchIssues(input: { query: string; repo?: string; maxResults: number }) {
    const terms = input.query.toLowerCase().split(/\s+/).filter((term) => term.length > 2);
    return Object.values(this.issues).flat().filter((issue) => (!input.repo || issue.repo === input.repo) && terms.some((term) => `${issue.title} ${issue.body}`.toLowerCase().includes(term))).slice(0, input.maxResults);
  }
  override async getIssue(input: { repo: string; number: number }) {
    this.readEvents.push({ repo: input.repo, path: `issues/${input.number}`, at: Date.now() });
    const issue = (this.issues[input.repo] ?? []).find((candidate) => candidate.number === input.number);
    if (!issue) throw new Error(`frozen replay has no issue ${input.repo}#${input.number}`);
    return issue;
  }
  override async getRepoMetadata({ repo }: RepoRef) {
    const candidate = this.candidates.find((item) => item.repo === repo);
    const [owner = "synthetic", name = "candidate"] = repo.split("/");
    return { repo, owner: candidate?.owner ?? owner, name: candidate?.name ?? name, defaultBranch: candidate?.defaultBranch };
  }
  override async getRepoTree({ repo }: RepoRef) { return { repo, paths: Object.keys(this.files[repo] ?? {}) }; }
  override async getFile(input: FileReadRequest) {
    this.readEvents.push({ repo: input.repo, path: input.path, at: Date.now() });
    const content = this.files[input.repo]?.[input.path];
    return content === undefined
      ? { provider: "mock" as const, repo: input.repo, path: input.path, unavailableReason: "frozen replay has no content for this path" }
      : { provider: "mock" as const, repo: input.repo, path: input.path, readStatus: "complete" as const, content };
  }
}

/** Compatibility rubric retained for callers of the original benchmark API. */
export function completenessScore(researchMd: string, anchorCount: number, selectedCount: number): number {
  const required = ["## Selected repositories", "## Candidate analysis", "## Implementation pattern", "## Evidence map", "## Pitfalls", "## Open questions"];
  const present = required.filter((section) => researchMd.includes(section)).length;
  return Math.min((present >= 4 ? 2 : present >= 2 ? 1 : 0) + (anchorCount >= 3 ? 2 : anchorCount > 0 ? 1 : 0) + (selectedCount > 0 ? 1 : 0), 5);
}
