import { describe, expect, it } from "vitest";
import type { FeatureSpec } from "../src/schemas/featureSpec.js";
import type { ClaimAssessment, CandidateState } from "../src/schemas/researchContracts.js";
import { deriveCoverage } from "../src/core/assessment/coverage.js";

const spec: FeatureSpec = {
  featureKey: "two-proof-roles", goal: "feature", feature: "feature", goalKind: "application",
  stack: [], libraries: [], providers: [], mustHave: [], shouldHave: [], exclude: [],
  requiredConcepts: [], likelyFiles: [],
  proofRequirements: [
    { key: "q1", description: "First role", required: true, signals: [] },
    { key: "q2", description: "Second role", required: true, signals: [] },
  ],
};

function assessment(questionId: string, repo: string): ClaimAssessment {
  return {
    claimId: `${questionId}-${repo}`, questionId, subject: { repo }, assertion: questionId,
    requiredObservationIds: [], status: "supported", method: "exact_source_quotation", assessorOrigin: "engine",
    evidencePolicyVersion: "phase2_claim_evidence_v2", rationale: "supported", remainingObligations: [], limitations: [],
  };
}

function state(repo: string, state: CandidateState["state"]): CandidateState {
  return { repo, state };
}

function derive(assessments: ClaimAssessment[], states: CandidateState[]) {
  return deriveCoverage({ spec, candidates: ["org/a", "org/b"], states, observations: [], assessments });
}

describe("composite question coverage", () => {
  it("does not complete when separate repositories satisfy separate questions", () => {
    const result = derive([assessment("question_q1", "org/a"), assessment("question_q2", "org/b")], [state("org/a", "eligible"), state("org/b", "eligible")]);
    expect(result.coverage.map((item) => item.status)).toEqual(["satisfied", "satisfied"]);
    expect(result.outcome).toEqual({ status: "partial", reasons: ["required questions satisfied only across different repositories"] });
  });

  it("completes when one eligible repository satisfies every required question", () => {
    const result = derive([assessment("question_q1", "org/a"), assessment("question_q2", "org/a")], [state("org/a", "eligible")]);
    expect(result.outcome).toEqual({ status: "complete", reasons: [] });
  });

  it("never completes for an ineligible candidate, even when its claims are supported", () => {
    const result = derive([assessment("question_q1", "org/a"), assessment("question_q2", "org/a")], [state("org/a", "ineligible")]);
    expect(result.outcome.status).toBe("partial");
  });

  it("records synthetic support in the run outcome reasons", () => {
    const syntheticAssessments = [
      { ...assessment("question_q1", "org/a"), evidenceOrigin: "synthetic" as const },
      { ...assessment("question_q2", "org/a"), evidenceOrigin: "synthetic" as const },
    ];
    const result = derive(syntheticAssessments, [state("org/a", "eligible")]);
    expect(result.outcome).toEqual({ status: "complete", reasons: ["synthetic_evidence"] });
  });

});
