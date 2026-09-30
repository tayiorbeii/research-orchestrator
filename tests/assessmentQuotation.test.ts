import { describe, expect, it } from "vitest";
import { claimAssessorRegistry, type ClaimSpec } from "../src/core/assessment/types.js";
import type { SourceObservation } from "../src/schemas/researchContracts.js";

const claim: ClaimSpec = {
  claimId: "role", questionId: "q1", subject: { repo: "org/repo" },
  assertion: 'source src/auth.ts states: "auth", "provider"',
  target: { kind: "quotation", path: "src/auth.ts", signals: ["auth", "provider"] },
};

function observation(id: string, excerpt: string, path = "src/auth.ts"): SourceObservation {
  return {
    id, kind: "repository_file", repo: "org/repo", path, revisionStatus: "unknown", excerpt,
    startLine: 1, endLine: 1, retrievedAt: "2026-01-01T00:00:00.000Z", retrievalMethod: "getFile",
    readStatus: "complete", origin: "synthetic",
    anchor: {
      id: `a_${id}`, provider: "mock", repo: "org/repo", path, startLine: 1, endLine: 1,
      matchText: excerpt, role: "auth", proofLevel: "partial", evidencePolicyVersion: "phase1_exact_quotation_v1",
      supportMethod: "exact_source_quotation",
    },
  };
}

describe("same-subject quotation targets", () => {
  it("requires every signal in one observation from the requested path", () => {
    const assess = claimAssessorRegistry.exact_source_quotation!;
    const together = assess(claim, [observation("one", 'const auth = configure("provider");')]);
    expect(together).toMatchObject({ status: "supported", evidenceOrigin: "synthetic" });

    const split = assess(claim, [observation("auth", "const auth = true;"), observation("provider", "provider = true;")]);
    expect(split.status).toBe("unsupported");
    expect(assess(claim, [observation("other", 'auth("provider")', "README.md")]).status).toBe("unsupported");
    expect(assess({ ...claim, target: { kind: "quotation", signals: [] } }, [observation("empty", "anything")]).status).toBe("unsupported");
  });

  it("limits changelog quotations to explicitly advertised historical wording", () => {
    const assess = claimAssessorRegistry.exact_source_quotation!;
    const changelog = observation("history", "Added auth provider support", "CHANGELOG.md");
    expect(assess({ ...claim, assertion: "implemented: auth", target: { kind: "quotation", path: "CHANGELOG.md", signals: ["auth", "provider"], claimScope: "implemented" } }, [changelog]).status).toBe("not_assessed");
    expect(assess({ ...claim, assertion: "auth was advertised", target: { kind: "quotation", path: "CHANGELOG.md", signals: ["auth", "provider"], claimScope: "advertised" } }, [changelog]).status).toBe("supported");
    expect(assess({ ...claim, target: { kind: "quotation", path: "CHANGELOG.md", signals: ["auth", "provider"] } }, [changelog]).status).toBe("unsupported");
  });

  it("accepts .gitignore as implementation evidence only for claims that name it", () => {
    const assess = claimAssessorRegistry.exact_source_quotation!;
    const ignoreRule = { ...claim, assertion: 'implemented: source .gitignore states: "dist/"', target: { kind: "quotation" as const, path: ".gitignore", signals: ["dist/"], claimScope: "implemented" as const } };
    expect(assess(ignoreRule, [observation("ignore", "dist/", ".gitignore")]).status).toBe("supported");
    // A path-less implementation claim must not be satisfied by an ignore file that merely mentions the signal.
    const pathless = { ...claim, assertion: 'implemented: source states: "ruff"', target: { kind: "quotation" as const, signals: ["ruff"], claimScope: "implemented" as const } };
    expect(assess(pathless, [observation("cache", ".ruff_cache/", ".gitignore")]).status).not.toBe("supported");
  });

  it("allows issue proposals only for proposed claims and annotates closed issues", () => {
    const assess = claimAssessorRegistry.exact_source_quotation!;
    const issue = {
      ...observation("issue", "Proposal: planned support for custom rules", "issues/17"),
      kind: "issue_proposal" as const, url: "https://example.invalid/issues/17", issueState: "closed" as const,
      revisionStatus: "moving_ref" as const,
      anchor: {
        id: "issue-anchor", provider: "mock" as const, repo: "org/repo", path: "issues/17", startLine: 1, endLine: 1,
        matchText: "Proposal: planned support for custom rules", role: "proposed", proofLevel: "partial" as const,
        evidencePolicyVersion: "phase1_exact_quotation_v1" as const, supportMethod: "exact_source_quotation" as const,
      },
    };
    const proposed = { ...claim, assertion: "proposed custom rules", target: { kind: "quotation" as const, path: "issues/17", signals: ["planned support", "custom rules"], claimScope: "proposed" as const } };
    expect(assess(proposed, [issue])).toMatchObject({ status: "supported", limitations: expect.arrayContaining([expect.stringContaining("issue is closed")]) });
    expect(assess({ ...proposed, target: { ...proposed.target, claimScope: "implemented" } }, [issue]).status).not.toBe("supported");
    expect(assess({ ...proposed, target: { kind: "quotation", path: "issues/17", signals: ["planned support", "custom rules"] } }, [issue]).status).not.toBe("supported");
    const repositoryFile = { ...issue, kind: "repository_file" as const, path: "issues/17.md" };
    expect(assess(proposed, [repositoryFile]).status).not.toBe("supported");
  });
});
