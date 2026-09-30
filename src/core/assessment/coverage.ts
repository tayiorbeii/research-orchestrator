import type { ClaimAssessment, QuestionCoverage, RunOutcome, CandidateState, SourceObservation } from "../../schemas/researchContracts.js";
import type { FeatureSpec } from "../../schemas/featureSpec.js";
import type { ClaimSpec } from "./types.js";

export interface RequiredQuestion {
  questionId: string;
  statement: string;
  requirementKey: string;
  required: boolean;
}

/** Phase 2 adapts each required FeatureSpec proof requirement into one question. */
export function questionsFromFeatureSpec(spec: FeatureSpec): RequiredQuestion[] {
  return spec.proofRequirements.filter((requirement) => requirement.required).map((requirement) => ({
    questionId: `question_${requirement.key}`,
    statement: requirement.description || requirement.key,
    requirementKey: requirement.key,
    required: true,
  }));
}

/** Build independent claims; each claim is bound to exactly one candidate repository. */
export function candidateClaims(
  spec: FeatureSpec,
  repos: readonly string[],
): ClaimSpec[] {
  return questionsFromFeatureSpec(spec).flatMap((question) => repos.map((repo) => ({
    claimId: `claim_${question.requirementKey}_${repo.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    questionId: question.questionId,
    subject: { repo },
    assertion: question.statement,
  })));
}

/** Pure coverage/outcome derivation from persisted candidate and evidence state. */
export function deriveCoverage(input: {
  spec: FeatureSpec;
  candidates: readonly string[];
  states: readonly CandidateState[];
  observations: readonly SourceObservation[];
  assessments: readonly ClaimAssessment[];
}): { coverage: QuestionCoverage[]; outcome: RunOutcome } {
  const questions = questionsFromFeatureSpec(input.spec);
  const coverage = questions.map((question): QuestionCoverage => {
    const claims = input.assessments.filter((claim) => claim.questionId === question.questionId);
    const supported = claims.filter((claim) => claim.status === "supported" && claim.assessorOrigin === "engine").map((claim) => claim.claimId);
    const partial = claims.filter((claim) => claim.status === "partial").map((claim) => claim.claimId);
    const contradicted = claims.filter((claim) => claim.status === "contradicted").map((claim) => claim.claimId);
    const inspected = new Set(input.states.filter((state) => state.state !== "uninspected").map((state) => state.repo));
    const attempted = input.observations.some((observation) => observation.repo !== undefined && input.candidates.includes(observation.repo));
    const unavailable = input.observations
      .filter((observation) => observation.readStatus === "unavailable" || observation.readStatus === "failed")
      .map((observation) => `${observation.repo ?? "unknown"}:${observation.path ?? "unknown"}`);
    const status = supported.length > 0 ? "satisfied" : partial.length > 0 ? "partial"
      : attempted ? "unresolved" : "not_attempted";
    return {
      questionId: question.questionId,
      status,
      supportedClaimIds: supported,
      partialClaimIds: partial,
      contradictedClaimIds: contradicted,
      unsatisfiedObligations: status === "satisfied" ? [] : [question.statement],
      uninspectedCandidates: input.candidates.filter((repo) => !inspected.has(repo)),
      unavailableSources: [...new Set(unavailable)],
      suggestedNextActions: status === "satisfied" ? [] : [`Inspect a relevant source for: ${question.statement}`],
    };
  });
  const required = questions.length;
  const satisfied = coverage.filter((item) => item.status === "satisfied").length;
  const attempted = coverage.filter((item) => item.status !== "not_attempted").length;
  const supportedReposByQuestion = questions.map((question) => new Set(
    input.assessments
      .filter((assessment) => assessment.questionId === question.questionId && assessment.status === "supported" && assessment.assessorOrigin === "engine")
      .map((assessment) => assessment.subject.repo),
  ));
  // Phase 3: per-obligation same-repo/any-repo scope from ResearchBrief.
  const completeCandidate = input.states.some((state) => state.state === "eligible" && questions.every((question) =>
    input.assessments.some((assessment) => assessment.questionId === question.questionId && assessment.subject.repo === state.repo && assessment.status === "supported" && assessment.assessorOrigin === "engine"),
  ));
  const allQuestionsSupported = coverage.length > 0 && coverage.every((item) => item.status === "satisfied");
  const supportedByOneRepo = input.candidates.some((repo) => supportedReposByQuestion.every((repos) => repos.has(repo)));
  const baseOutcome: RunOutcome = required === 0 || attempted === 0
    ? { status: "inconclusive", reasons: ["No required proof questions received an assessment."] }
    : allQuestionsSupported && completeCandidate ? { status: "complete", reasons: [] }
      : allQuestionsSupported && !supportedByOneRepo ? { status: "partial", reasons: ["required questions satisfied only across different repositories"] }
      : allQuestionsSupported ? { status: "partial", reasons: ["no eligible candidate satisfies every required question"] }
      : satisfied > 0 ? { status: "partial", reasons: [`${required - satisfied} required question(s) remain unsatisfied.`] }
        : { status: "inconclusive", reasons: ["Required questions remain unassessed."] };
  const hasSyntheticSupport = input.assessments.some((assessment) =>
    assessment.status === "supported" && assessment.assessorOrigin === "engine" && assessment.evidenceOrigin === "synthetic",
  );
  const outcome: RunOutcome = hasSyntheticSupport
    ? { ...baseOutcome, reasons: [...new Set([...baseOutcome.reasons, "synthetic_evidence"])] }
    : baseOutcome;
  return { coverage, outcome };
}
