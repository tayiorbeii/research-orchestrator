import { describe, expect, it } from "vitest";
import { assessBriefClaims, assessmentMatchesFact, briefFacts, claimIdFor } from "../src/core/assessment/claimLedger.js";
import { obligationSatisfied } from "../src/core/assessment/briefCoverage.js";
import { claimAssessorRegistry, type ClaimSpec } from "../src/core/assessment/types.js";
import type { ResearchBrief } from "../src/schemas/researchBrief.js";
import type { SourceObservation } from "../src/schemas/researchContracts.js";

const budgets = { maxQuestions: 6, queryUnits: 16, reconnaissanceReads: 4, fileReads: 48, fileReadsPerRepo: 12, refinementRounds: 1, refinementProbes: 4, deadlineMs: 60_000 };
const brief: ResearchBrief = {
  id: "ledger", revision: 1, goal: "n8n deployments", mechanisms: [], vocabulary: [], seeds: [], allowedSourceKinds: ["repository_file"], budgets, readiness: { status: "ready" }, lookupOutcomes: [],
  questions: [
    { id: "q1", statement: "image", intentHints: ["architecture_pattern"], required: true, answerScope: "one", obligations: [{ combine: "any", scope: "same_repository", facts: [
      { kind: "quotation", signals: ["docker.n8n.io/n8nio/n8n"], claimScope: "implemented" },
      { kind: "quotation", signals: ["N8N_ENCRYPTION_KEY"], claimScope: "implemented" },
    ] }] },
    { id: "q2", statement: "manifest", intentHints: ["library_usage"], required: false, answerScope: "one", obligations: [{ combine: "all", scope: "same_repository", facts: [{ kind: "dependency", packageName: "n8n" }] }] },
  ],
};

function file(id: string, repo: string, path: string, excerpt: string): SourceObservation {
  const lines = excerpt.split("\n");
  return {
    id, kind: "repository_file", repo, path, revisionStatus: "unknown", excerpt, startLine: 1, endLine: lines.length,
    retrievedAt: "2026-01-01T00:00:00.000Z", retrievalMethod: "getFile", readStatus: "complete", origin: "engine",
    anchor: { id: `a_${id}`, provider: "github", repo, path, startLine: 1, endLine: 1, matchText: lines[0]!, role: "q1_0_0", proofLevel: "partial", evidencePolicyVersion: "phase1_exact_quotation_v1", supportMethod: "exact_source_quotation" },
  };
}

describe("claim ledger", () => {
  it("mints claims only for repositories that were read", () => {
    const observations = [file("o1", "a/deploy", "Dockerfile", "FROM docker.n8n.io/n8nio/n8n:latest")];
    const assessments = assessBriefClaims(brief, ["a/deploy", "b/never-read", "c/never-read"], observations);
    expect(new Set(assessments.map((item) => item.subject.repo))).toEqual(new Set(["a/deploy"]));
    expect(assessments).toHaveLength(briefFacts(brief).length);
    expect(assessments.find((item) => item.fact?.factIndex === 0 && item.questionId === "q1")?.status).toBe("supported");
  });

  it("carries the fact reference as data and coverage reads it, not the id", () => {
    const observations = [file("o1", "a/deploy", "Dockerfile", "FROM docker.n8n.io/n8nio/n8n:latest")];
    const assessments = assessBriefClaims(brief, ["a/deploy"], observations).map((item) => ({ ...item, claimId: `renamed-${item.claimId}` }));
    expect(assessments[0]?.fact).toEqual({ questionId: "q1", obligationIndex: 0, factIndex: 0, kind: "quotation" });
    expect(obligationSatisfied("q1", brief.questions[0]!.obligations[0]!, 0, ["a/deploy"], assessments)).toBe(true);
    expect(obligationSatisfied("q2", brief.questions[1]!.obligations[0]!, 0, ["a/deploy"], assessments)).toBe(false);
  });

  it("matches legacy assessments without a fact reference by their id convention", () => {
    const ref = { questionId: "q1", obligationIndex: 0, factIndex: 1, kind: "quotation" as const };
    expect(assessmentMatchesFact({ claimId: claimIdFor(ref, "a/deploy"), questionId: "q1" }, ref)).toBe(true);
    expect(assessmentMatchesFact({ claimId: claimIdFor({ ...ref, factIndex: 0 }, "a/deploy"), questionId: "q1" }, ref)).toBe(false);
  });

  it("gives every assessor the same envelope through the shared verdict", () => {
    const claim: ClaimSpec = { claimId: "c", questionId: "q", fact: { questionId: "q", obligationIndex: 0, factIndex: 0, kind: "dependency" }, subject: { repo: "a/b" }, assertion: "x" };
    for (const [method, assessor] of Object.entries(claimAssessorRegistry)) {
      const result = assessor!(claim, []);
      expect(result, method).toMatchObject({ claimId: "c", questionId: "q", fact: claim.fact, subject: { repo: "a/b" }, method, assessorOrigin: "engine", evidencePolicyVersion: "phase2_claim_evidence_v2" });
      expect(Array.isArray(result.limitations) && Array.isArray(result.remainingObligations), method).toBe(true);
    }
  });
});
