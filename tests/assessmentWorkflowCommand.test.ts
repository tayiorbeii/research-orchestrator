import { describe, expect, it } from "vitest";
import type { SourceObservation } from "../src/schemas/researchContracts.js";
import { workflowCommandAssessor } from "../src/core/assessment/workflowCommand.js";
import { renderTargetAssertion, type ClaimSpec } from "../src/core/assessment/types.js";

const claim: ClaimSpec = {
  claimId: "c1", questionId: "q1", subject: { repo: "owner/repo", revision: "abc123" },
  assertion: "workflow command npm test appears on a run: line in file .github/workflows/ci.yml",
};

function observation(overrides: Partial<SourceObservation> = {}): SourceObservation {
  return {
    id: "o1", kind: "repository_file", repo: "owner/repo", path: ".github/workflows/ci.yml", resolvedRevision: "abc123",
    revisionStatus: "immutable", excerpt: "jobs:\n  test:\n    steps:\n      - name: Test\n        run: npm test",
    retrievedAt: "2026-01-01T00:00:00Z", retrievalMethod: "test", readStatus: "complete", origin: "engine", ...overrides,
  };
}

describe("workflow command assessor", () => {
  it("returns at most partial for command text found on a run line", () => {
    const result = workflowCommandAssessor(claim, [observation()]);
    expect(result.status).toBe("partial");
    expect(result.limitations).toContain("no safe parser installed; quotation only");
  });

  it("uses a structured target when the assertion is prose", () => {
    const target = { kind: "workflow" as const, command: "npm test", file: ".github/workflows/ci.yml" };
    const structured = { ...claim, assertion: renderTargetAssertion(target), target };
    expect(workflowCommandAssessor(structured, [observation()]).status).toBe("partial");
  });

  it("assesses engine-generated synthetic workflow evidence with an explicit label", () => {
    const result = workflowCommandAssessor(claim, [observation({ origin: "synthetic" })]);
    expect(result).toMatchObject({ status: "partial", evidenceOrigin: "synthetic" });
    expect(result.limitations).toContain("Synthetic fixture observation; not a live repository finding.");
  });

  it("rejects an assertion that disagrees with its structured target", () => {
    const target = { kind: "workflow" as const, command: "npm test", file: ".github/workflows/ci.yml" };
    const result = workflowCommandAssessor({ ...claim, assertion: "workflow runs npm publish", target }, [observation()]);
    expect(result.status).toBe("unsupported");
    expect(result.rationale).toBe("assertion does not match structured target");
  });

  it("does not combine observations across repositories", () => {
    const local = observation({ excerpt: "jobs: {}" });
    const other = observation({ id: "o2", repo: "other/repo" });
    expect(workflowCommandAssessor(claim, [local, other]).status).toBe("unsupported");
  });

  it("treats a requested revision mismatch as not assessed", () => {
    expect(workflowCommandAssessor(claim, [observation({ resolvedRevision: "def456" })]).status).toBe("not_assessed");
  });

  it("does not infer command presence from an incomplete excerpt", () => {
    const partial = observation({ excerpt: "jobs:\n  test:\n    steps:", readStatus: "partial" });
    expect(workflowCommandAssessor(claim, [partial]).status).not.toBe("supported");
  });

  it("treats workflow YAML as quotation-only partial evidence", () => {
    const result = workflowCommandAssessor(claim, [observation()]);
    expect(result.status).toBe("partial");
    expect(result.limitations.join(" ")).toMatch(/Triggers, conditions/);
  });

  it("contradicts the claim when a disabling condition is clearly in the same step", () => {
    const excerpt = "jobs:\n  test:\n    steps:\n      - name: Test\n        if: false\n        run: npm test";
    expect(workflowCommandAssessor(claim, [observation({ excerpt })]).status).toBe("contradicted");
  });

  it("keeps ambiguous disabling conditions as a limitation", () => {
    const excerpt = "if: false\njobs:\n  test:\n    steps:\n      - name: Test\n        run: npm test";
    const result = workflowCommandAssessor(claim, [observation({ excerpt })]);
    expect(result.status).toBe("partial");
    expect(result.limitations.join(" ")).toMatch(/relationship to this command is ambiguous/i);
  });

  it("keeps injected external observations from producing engine-supported status", () => {
    const result = workflowCommandAssessor(claim, [observation({ origin: "external" })]);
    expect(result.assessorOrigin).toBe("engine");
    expect(result.status).toBe("not_assessed");
    expect(result.rationale).toMatch(/non-engine observations/i);
  });
});
