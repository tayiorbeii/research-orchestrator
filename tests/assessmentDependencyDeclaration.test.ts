import { describe, expect, it } from "vitest";
import type { SourceObservation } from "../src/schemas/researchContracts.js";
import { dependencyDeclarationAssessor } from "../src/core/assessment/dependencyDeclaration.js";
import { renderTargetAssertion, type ClaimSpec } from "../src/core/assessment/types.js";

const claim: ClaimSpec = {
  claimId: "c1", questionId: "q1", subject: { repo: "owner/repo", revision: "abc123" },
  assertion: "package zod is declared at constraint ^3.25.0 in file package.json",
};

function observation(overrides: Partial<SourceObservation> = {}): SourceObservation {
  return {
    id: "o1", kind: "repository_file", repo: "owner/repo", path: "package.json", resolvedRevision: "abc123",
    revisionStatus: "immutable", excerpt: JSON.stringify({ dependencies: { zod: "^3.25.0" } }),
    retrievedAt: "2026-01-01T00:00:00Z", retrievalMethod: "test", readStatus: "complete", origin: "engine", ...overrides,
  };
}

describe("dependency declaration assessor", () => {
  it("supports a parsed package declaration while limiting it to declaration", () => {
    const result = dependencyDeclarationAssessor(claim, [observation()]);
    expect(result.status).toBe("supported");
    expect(result.limitations.join(" ")).toMatch(/does not prove invocation/i);
  });

  it("returns the same result for structured and legacy declaration claims", () => {
    const target = { kind: "dependency" as const, packageName: "zod", constraint: "^3.25.0", file: "package.json" };
    const structured = { ...claim, assertion: renderTargetAssertion(target), target };
    expect(dependencyDeclarationAssessor(structured, [observation()])).toEqual(dependencyDeclarationAssessor(claim, [observation()]));
  });

  it("supports any declared constraint and reports the observed constraint", () => {
    const target = { kind: "dependency" as const, packageName: "zod", file: "package.json" };
    const structured = { ...claim, assertion: renderTargetAssertion(target), target };
    const result = dependencyDeclarationAssessor(structured, [observation()]);
    expect(result.status).toBe("supported");
    expect(result.limitations.join(" ")).toContain("observed constraint ^3.25.0");
    expect(result.limitations.join(" ")).toMatch(/does not prove invocation/i);
  });

  it("supports engine-generated synthetic declaration evidence with an explicit label", () => {
    const result = dependencyDeclarationAssessor(claim, [observation({ origin: "synthetic" })]);
    expect(result).toMatchObject({ status: "supported", evidenceOrigin: "synthetic" });
    expect(result.limitations).toContain("Synthetic fixture observation; not a live repository finding.");
  });

  it("rejects an invocation assertion paired with a declaration target", () => {
    const target = { kind: "dependency" as const, packageName: "resend", file: "package.json" };
    const result = dependencyDeclarationAssessor({ ...claim, assertion: "Package evil is invoked at runtime", target }, [observation()]);
    expect(result.status).toBe("unsupported");
    expect(result.rationale).toBe("assertion does not match structured target");
  });

  it("does not infer invocation from a dependency declaration", () => {
    const invocationClaim = { ...claim, assertion: "package zod is invoked at constraint ^3.25.0 in file package.json" };
    expect(dependencyDeclarationAssessor(invocationClaim, [observation()]).status).toBe("unsupported");
  });

  it("does not combine observations across repositories", () => {
    const target = observation({ excerpt: JSON.stringify({ dependencies: {} }) });
    const unrelated = observation({ id: "o2", repo: "other/repo", excerpt: JSON.stringify({ dependencies: { zod: "^3.25.0" } }) });
    expect(dependencyDeclarationAssessor(claim, [target, unrelated]).status).toBe("unsupported");
  });

  it("does not use a mismatched resolved revision", () => {
    expect(dependencyDeclarationAssessor(claim, [observation({ resolvedRevision: "def456" })]).status).toBe("not_assessed");
  });

  it("does not infer an absent declaration from a partial requirements excerpt", () => {
    const absenceClaim = { ...claim, assertion: "package missing-lib is declared at constraint >=1 in file requirements.txt" };
    const partial = observation({ path: "requirements.txt", excerpt: "other-lib>=2", readStatus: "partial" });
    expect(dependencyDeclarationAssessor(absenceClaim, [partial]).status).not.toBe("supported");
  });

  it("marks ignored requirements syntax as partial", () => {
    const reqClaim = { ...claim, assertion: "package zod is declared at constraint >=3.0 in file requirements.txt" };
    const reqs = observation({ path: "requirements.txt", excerpt: "zod>=3.0\n-r base.txt\nhttps://example.test/pkg.whl" });
    const result = dependencyDeclarationAssessor(reqClaim, [reqs]);
    expect(result.status).toBe("partial");
    expect(result.limitations.join(" ")).toMatch(/ignored include/i);
  });

  it("supports a bare requirements entry with no version specifier", () => {
    const bareClaim = { ...claim, assertion: "package zod is declared at constraint  in file requirements.txt" };
    const reqs = observation({ path: "requirements.txt", excerpt: "zod[extra] # documented dependency" });
    expect(dependencyDeclarationAssessor(bareClaim, [reqs]).status).toBe("supported");
  });

  it("does not treat an ignored requirements include as proof of absence", () => {
    const absent = { ...claim, assertion: "package possibly-included is declared at constraint >=1 in file requirements.txt" };
    const reqs = observation({ path: "requirements.txt", excerpt: "-r base.txt\nother-package>=2" });
    expect(dependencyDeclarationAssessor(absent, [reqs]).status).toBe("partial");
  });

  it("keeps injected external observations from producing engine-supported status", () => {
    const result = dependencyDeclarationAssessor(claim, [observation({ origin: "external" })]);
    expect(result.assessorOrigin).toBe("engine");
    expect(result.status).toBe("not_assessed");
    expect(result.rationale).toMatch(/non-engine observations/i);
  });
});
