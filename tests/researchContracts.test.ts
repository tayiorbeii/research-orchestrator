import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CandidateStateSchema,
  ClaimAssessmentSchema,
  QuestionCoverageSchema,
  RepoExplanationResultSchema,
  ResearchRunSchema,
  ResearchRunV2Schema,
  RunOutcomeSchema,
  SourceObservationSchema,
  detectRunVersion,
  type SourceObservation,
} from "../src/schemas/index.js";
import { claimAssessorRegistry } from "../src/core/assessment/types.js";

async function jsonSchema(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8")) as Record<string, unknown>;
}

function conforms(schema: Record<string, unknown>, value: unknown): boolean {
  if (schema.oneOf) return (schema.oneOf as Record<string, unknown>[]).filter((item) => conforms(item, value)).length === 1;
  if (schema.const !== undefined && schema.const !== value) return false;
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return false;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if (((schema.required as string[] | undefined) ?? []).some((key) => !(key in object))) return false;
    const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    return Object.entries(properties).every(([key, child]) => !(key in object) || conforms(child, object[key]));
  }
  if (schema.type === "array") return Array.isArray(value) && value.every((item) => conforms(schema.items as Record<string, unknown>, item));
  if (schema.type === "string") return typeof value === "string" && (schema.minLength === undefined || value.length >= Number(schema.minLength));
  if (schema.type === "integer") return Number.isInteger(value);
  if (schema.type === "number") return typeof value === "number";
  if (schema.type === "boolean") return typeof value === "boolean";
  return true;
}

const observation: SourceObservation = {
  id: "obs-1", kind: "repository_file", repo: "acme/app", path: "README.md",
  resolvedRevision: "abc123", revisionStatus: "immutable", excerpt: "The source states feature X.",
  startLine: 1, endLine: 1, retrievedAt: "2026-09-29T00:00:00.000Z", provider: "mock",
  retrievalMethod: "getFile", readStatus: "complete", origin: "engine",
  anchor: {
    id: "anchor-1", provider: "mock", repo: "acme/app", ref: "abc123", path: "README.md",
    startLine: 1, endLine: 1, matchText: "The source states feature X.", role: "research",
    proofLevel: "partial", evidencePolicyVersion: "phase1_exact_quotation_v1", supportMethod: "exact_source_quotation",
  },
};

describe("Phase 2 contract schemas", () => {
  it.each([
    ["source_observation", SourceObservationSchema, observation],
    ["claim_assessment", ClaimAssessmentSchema, {
      claimId: "claim-1", questionId: "question-1", subject: { repo: "acme/app", revision: "abc123" },
      assertion: "The source states feature X.", requiredObservationIds: ["obs-1"], status: "supported",
      method: "exact_source_quotation", assessorOrigin: "engine", evidencePolicyVersion: "phase2_claim_evidence_v2",
      rationale: "Exact quote", remainingObligations: [], limitations: [],
    }],
    ["question_coverage", QuestionCoverageSchema, {
      questionId: "question-1", status: "satisfied", supportedClaimIds: ["claim-1"], partialClaimIds: [],
      contradictedClaimIds: [], unsatisfiedObligations: [], uninspectedCandidates: [], unavailableSources: [], suggestedNextActions: [],
    }],
    ["run_outcome", RunOutcomeSchema, { status: "complete", reasons: [] }],
    ["candidate_state", CandidateStateSchema, { repo: "acme/app", state: "eligible" }],
    ["repo_explanation_result", RepoExplanationResultSchema, { repo: "acme/app", status: "failed", error: "Unavailable" }],
  ])("keeps %s Zod and JSON Schema contracts aligned", async (name, zodSchema, value) => {
    const parsed = zodSchema.parse(value);
    expect(parsed).toEqual(value);
    expect(conforms(await jsonSchema(name), value)).toBe(true);
    expect(conforms(await jsonSchema(name), {})).toBe(false);
  });

  it("parses the v2 run envelope and distinguishes legacy v1 and unknown input", async () => {
    const legacy = JSON.parse(await readFile(new URL("./fixtures/research-integrity/historical-sample-run-v1.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(detectRunVersion(legacy)).toBe("v1");
    expect(detectRunVersion({ schemaVersion: 3 })).toBe("unknown");
    const run = {
      ...legacy,
      scoredCandidates: [],
      schemaVersion: 2,
      evidencePolicyVersion: "phase2_claim_evidence_v2",
      providerName: "mock",
      observations: [observation], assessments: [], coverage: [], outcome: { status: "partial", reasons: [] },
      candidateStates: [], explanationResults: [],
    };
    expect(detectRunVersion(run)).toBe("v2");
    expect(ResearchRunSchema.parse(run)).toMatchObject({ schemaVersion: 2, selectedRepos: legacy.selectedRepos });
    expect(ResearchRunV2Schema.parse(run)).toMatchObject({ schemaVersion: 2 });
    expect(ResearchRunV2Schema.parse({ ...run, parentRunId: "parent-run" })).toMatchObject({ parentRunId: "parent-run" });
    expect(ResearchRunV2Schema.safeParse({ ...run, parentRunId: 42 }).success).toBe(false);
    expect(conforms(await jsonSchema("research_run"), run)).toBe(true);
    expect(conforms(await jsonSchema("research_run"), { ...run, parentRunId: "parent-run" })).toBe(true);
    expect(() => ResearchRunSchema.parse({ ...run, coverage: undefined })).toThrow();
  });

  it("assesses only exact quotations from the same repository and revision", () => {
    const assessor = claimAssessorRegistry.exact_source_quotation!;
    const claim = { claimId: "claim-1", questionId: "question-1", subject: { repo: "acme/app", revision: "abc123" }, assertion: "The source states feature X." };
    expect(assessor(claim, [observation]).status).toBe("supported");
    expect(assessor({ ...claim, subject: { repo: "other/app", revision: "abc123" } }, [observation]).status).toBe("not_assessed");
    expect(assessor(claim, []).status).toBe("not_assessed");
    expect(assessor({ ...claim, subject: { repo: "acme/app", revision: "different" } }, [observation]).status).toBe("not_assessed");
  });
});
