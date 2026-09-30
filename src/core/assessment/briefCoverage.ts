import type { ResearchBrief } from "../../schemas/researchBrief.js";
import type { ClaimAssessment, QuestionCoverage, RunOutcome, SourceObservation } from "../../schemas/researchContracts.js";
import type { ProbeOutcome, SearchProbeV2 } from "../../schemas/searchProbeV2.js";

type BriefFact = ResearchBrief["questions"][number]["obligations"][number]["facts"][number];

export interface BriefCoverageInput {
  brief: ResearchBrief;
  candidateRepos: readonly string[];
  observations: readonly SourceObservation[];
  assessments: readonly ClaimAssessment[];
  probes: readonly SearchProbeV2[];
  probeOutcomes: readonly ProbeOutcome[];
  providerName?: string;
}

/**
 * Question coverage and run outcome for a brief-driven run. Pure, so the engine,
 * artifact rendering, and explanations derive identical results (R14); inline runs
 * reach here with downgraded assessments, so only engine support counts.
 */
export function deriveBriefCoverage(input: BriefCoverageInput): { coverage: QuestionCoverage[]; outcome: RunOutcome } {
  const { brief, candidateRepos, observations, assessments, probes, probeOutcomes } = input;
  const coverage = brief.questions.map((question): QuestionCoverage => {
    const questionAssessments = assessments.filter((assessment) => assessment.questionId === question.id);
    const supported = questionAssessments.filter((item) => item.status === "supported" && item.assessorOrigin === "engine");
    const partial = questionAssessments.filter((item) => item.status === "partial");
    const questionAttempted = probeOutcomes.some((outcome) => {
      const probe = probes.find((item) => item.id === outcome.probeId);
      return probe?.questionIds.includes(question.id) && outcome.status !== "not_attempted";
    }) || observations.some((observation) => question.obligations.some((obligation) => obligation.facts.some((fact) => factPath(fact) === observation.path)));
    const satisfied = questionAttempted && question.obligations.every((obligation, obligationIndex) =>
      obligationSatisfied(question.id, obligation, obligationIndex, candidateRepos, assessments));
    const status = satisfied ? "satisfied" as const : partial.length || supported.length ? "partial" as const : questionAttempted ? "unresolved" as const : "not_attempted" as const;
    return {
      questionId: question.id,
      status,
      supportedClaimIds: supported.map((item) => item.claimId),
      partialClaimIds: partial.map((item) => item.claimId),
      contradictedClaimIds: questionAssessments.filter((item) => item.status === "contradicted").map((item) => item.claimId),
      unsatisfiedObligations: status === "satisfied" ? [] : question.obligations.flatMap((obligation) => obligation.facts.map(factLabel)),
      uninspectedCandidates: candidateRepos.filter((repo) => !observations.some((observation) => observation.repo === repo)),
      unavailableSources: observations.filter((observation) => observation.readStatus === "unavailable" || observation.readStatus === "failed").map((observation) => `${observation.repo}:${observation.path}`),
      suggestedNextActions: status === "satisfied" ? [] : [`Inspect evidence for: ${question.statement}`],
    };
  });
  const required = coverage.filter((item) => brief.questions.find((question) => question.id === item.questionId)?.required);
  const complete = required.length > 0 && required.every((question) => question.status === "satisfied");
  const anySatisfied = required.some((question) => question.status === "satisfied");
  const outcome: RunOutcome = {
    status: complete ? "complete" : anySatisfied ? "partial" : "inconclusive",
    reasons: [
      ...(complete ? [] : [required.every((question) => question.status === "not_attempted") ? "Required questions were not attempted." : "Required questions remain unsatisfied."]),
      ...(input.providerName === "mock" ? ["synthetic_evidence"] : []),
      ...(probeOutcomes.some((item) => item.failureKind === "transport_failure") ? ["provider_transport_failed"] : []),
      ...(probeOutcomes.some((item) => item.failureKind === "access_denied") ? ["provider_access_denied"] : []),
      ...(probeOutcomes.some((item) => item.failureKind === "pagination_limit" || item.resultClass === "pagination_limit") ? ["provider_pagination_limit"] : []),
    ],
  };
  return { coverage, outcome };
}

export function obligationSatisfied(
  questionId: string,
  obligation: ResearchBrief["questions"][number]["obligations"][number],
  obligationIndex: number,
  candidateRepos: readonly string[],
  assessments: readonly ClaimAssessment[],
): boolean {
  const factSupported = (fact: BriefFact, repo: string) => assessments.some((assessment) =>
    assessment.questionId === questionId && assessment.subject.repo === repo && assessment.status === "supported" &&
    assessment.assessorOrigin === "engine" && assessment.claimId.startsWith(`claim_${questionId}_${obligationIndex}_${obligation.facts.indexOf(fact)}_${fact.kind}_`),
  );
  if (obligation.combine === "all" && obligation.scope === "same_repository") {
    return candidateRepos.some((repo) => obligation.facts.every((fact) => factSupported(fact, repo)));
  }
  if (obligation.combine === "all") return obligation.facts.every((fact) => candidateRepos.some((repo) => factSupported(fact, repo)));
  if (obligation.scope === "same_repository") return candidateRepos.some((repo) => obligation.facts.some((fact) => factSupported(fact, repo)));
  return obligation.facts.some((fact) => candidateRepos.some((repo) => factSupported(fact, repo)));
}

export function factLabel(fact: BriefFact): string {
  return fact.kind === "dependency" ? `${fact.packageName} declared` : fact.kind === "config" ? `${fact.keyPath} configuration` : fact.kind === "workflow" ? `workflow command ${fact.command}` : fact.signals.join(" and ");
}

function factPath(fact: BriefFact): string | undefined {
  return fact.kind === "quotation" ? fact.path : fact.kind === "dependency" ? fact.file ?? "package.json" : fact.kind === "config" ? fact.file ?? "README.md" : fact.file ?? ".github/workflows/ci.yml";
}
