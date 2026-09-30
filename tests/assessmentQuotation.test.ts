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

describe("import-only mentions are leads, not implementation proof", () => {
  const assess = claimAssessorRegistry.exact_source_quotation!;
  const implemented: ClaimSpec = { ...claim, assertion: "implemented: PostToolUseOutcome", target: { kind: "quotation", signals: ["PostToolUseOutcome"], claimScope: "implemented" } };
  const rs = (id: string, text: string) => observation(id, text, "codex-rs/core/src/hook_runtime.rs");

  it("demotes a signal that appears only on import/use lines to partial", () => {
    for (const text of ["use codex_hooks::PostToolUseOutcome;", "import { PostToolUseOutcome } from './hooks';", "from hooks import PostToolUseOutcome", "const { PostToolUseOutcome } = require('./hooks');", "export { PostToolUseOutcome } from './hooks';"]) {
      const result = assess(implemented, [rs("imp", text)]);
      expect(result.status, text).toBe("partial");
      expect(result.rationale).toMatch(/only on import/i);
    }
  });

  it("supports a signal used outside import lines", () => {
    const text = "use codex_hooks::PostToolUseOutcome;\nlet outcome: PostToolUseOutcome = run_hooks(&input);";
    const multi = { ...rs("body", text), endLine: 2, anchor: { ...rs("body", text).anchor!, endLine: 2 } };
    const result = assess(implemented, [multi]);
    expect(result.status).toBe("supported");
  });

  it("leaves documentation/advertised quotations unaffected", () => {
    const advertised: ClaimSpec = { ...claim, assertion: "advertised", target: { kind: "quotation", path: "README.md", signals: ["import"], claimScope: "advertised" } };
    expect(assess(advertised, [observation("doc", "import is documented here", "README.md")]).status).toBe("supported");
  });
});

describe("import blocks and signal proximity", () => {
  const assess = claimAssessorRegistry.exact_source_quotation!;
  const bounded = (id: string, text: string, path = "src/hooks/index.ts") => {
    const lines = text.split("\n").length;
    const o = observation(id, text, path);
    return { ...o, endLine: lines, anchor: { ...o.anchor!, endLine: lines } };
  };
  const implemented = (signals: string[]): ClaimSpec => ({ ...claim, assertion: `implemented: ${signals.join(", ")}`, target: { kind: "quotation", signals, claimScope: "implemented" } });

  it("treats names inside a multi-line import block as import-only", () => {
    const text = "import {\n  type PostToolUseOutcome,\n  runHooks,\n} from './engine';\nexport const x = 1;";
    expect(assess(implemented(["PostToolUseOutcome"]), [bounded("blk", text)]).status).toBe("partial");
  });

  it("does not mistake destructuring exports for an import block", () => {
    const text = "import { convexAuth } from '@convex-dev/auth/server';\nexport const { auth, signIn } = convexAuth({\n  providers: [],\n});";
    expect(assess(implemented(["convexAuth"]), [bounded("destructure", text, "convex/auth.ts")]).status).toBe("supported");
  });

  it("treats Rust use blocks as imports", () => {
    const text = "use crate::events::{\n    PostToolUseOutcome,\n    PreToolUseOutcome,\n};\nfn main() {}";
    expect(assess(implemented(["PostToolUseOutcome"]), [bounded("rs", text, "src/lib.rs")]).status).toBe("partial");
  });

  it("requires several signals to co-occur within a small window", () => {
    const far = ["Each string is capped at 10,000 characters.", ...Array.from({ length: 19 }, () => "filler"), "`updatedToolOutput` hooks"].join("\n");
    const near = "updatedToolOutput replaces the output; it is capped at 10,000 characters.";
    const advertised: ClaimSpec = { ...claim, assertion: "advertised", target: { kind: "quotation", path: "docs/HOOKS.md", signals: ["updatedToolOutput", "10,000"], claimScope: "advertised" } };
    expect(assess(advertised, [bounded("far", far, "docs/HOOKS.md")]).status).toBe("unsupported");
    expect(assess(advertised, [bounded("near", near, "docs/HOOKS.md")]).status).toBe("supported");
  });
});
