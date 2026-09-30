import { describe, expect, it } from "vitest";
import type { SourceObservation } from "../src/schemas/researchContracts.js";
import { configValueAssessor } from "../src/core/assessment/configValue.js";
import { renderTargetAssertion, type ClaimSpec } from "../src/core/assessment/types.js";

const claim: ClaimSpec = {
  claimId: "c1", questionId: "q1", subject: { repo: "owner/repo", revision: "abc123" },
  assertion: 'key path retries.max has literal value 3 in file settings.json',
};

function observation(overrides: Partial<SourceObservation> = {}): SourceObservation {
  return {
    id: "o1", kind: "repository_file", repo: "owner/repo", path: "settings.json", resolvedRevision: "abc123",
    revisionStatus: "immutable", excerpt: JSON.stringify({ retries: { max: 3 } }),
    retrievedAt: "2026-01-01T00:00:00Z", retrievalMethod: "test", readStatus: "complete", origin: "engine", ...overrides,
  };
}

describe("config value assessor", () => {
  it("supports a strict JSON literal and reports its narrow scope", () => {
    const result = configValueAssessor(claim, [observation()]);
    expect(result.status).toBe("supported");
    expect(result.limitations.join(" ")).toMatch(/occurrences or overrides in this observation/i);
  });

  it("uses a structured target when the assertion is prose", () => {
    const target = { kind: "config" as const, keyPath: "retries.max", value: 3, file: "settings.json" };
    const structured = { ...claim, assertion: renderTargetAssertion(target), target };
    expect(configValueAssessor(structured, [observation()]).status).toBe("supported");
  });

  it("supports engine-generated synthetic configuration evidence with an explicit label", () => {
    const result = configValueAssessor(claim, [observation({ origin: "synthetic" })]);
    expect(result).toMatchObject({ status: "supported", evidenceOrigin: "synthetic" });
    expect(result.limitations).toContain("Synthetic fixture observation; not a live repository finding.");
  });

  it("rejects an assertion that disagrees with its structured target", () => {
    const target = { kind: "config" as const, keyPath: "retries.max", value: 3, file: "settings.json" };
    const result = configValueAssessor({ ...claim, assertion: "retry limit is 100", target }, [observation()]);
    expect(result.status).toBe("unsupported");
    expect(result.rationale).toBe("assertion does not match structured target");
  });

  it("does not combine observations across repositories", () => {
    const local = observation({ excerpt: JSON.stringify({ retries: {} }) });
    const other = observation({ id: "o2", repo: "other/repo", excerpt: JSON.stringify({ retries: { max: 3 } }) });
    expect(configValueAssessor(claim, [local, other]).status).toBe("unsupported");
  });

  it("treats a requested revision mismatch as not assessed", () => {
    expect(configValueAssessor(claim, [observation({ resolvedRevision: "def456" })]).status).toBe("not_assessed");
  });

  it("does not use a partial read to support an absence claim", () => {
    const absence = { ...claim, assertion: "key path retries.max is absent in file settings.json" };
    expect(configValueAssessor(absence, [observation({ excerpt: "{}", readStatus: "partial" })]).status).toBe("unsupported");
  });

  it("returns quotation-only partial status for unsupported formats", () => {
    const yamlClaim = { ...claim, assertion: "key path retries.max has literal value 3 in file settings.yaml" };
    const result = configValueAssessor(yamlClaim, [observation({ path: "settings.yaml", excerpt: "retries:\n  max: 3" })]);
    expect(result.status).toBe("partial");
    expect(result.limitations).toContain("no safe parser installed; quotation only");
  });

  it("keeps injected external observations from producing engine-supported status", () => {
    const result = configValueAssessor(claim, [observation({ origin: "external" })]);
    expect(result.assessorOrigin).toBe("engine");
    expect(result.status).toBe("not_assessed");
    expect(result.rationale).toMatch(/non-engine observations/i);
  });
});
