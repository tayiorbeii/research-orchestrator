import { describe, expect, it } from "vitest";
import { selectSourceReads } from "../src/core/sourceSelection.js";

describe("selectSourceReads", () => {
  it("prioritizes exact hits and Python configuration over dotfiles and alphabetic tree order", () => {
    const result = selectSourceReads({
      question: "Which ignore rules apply?",
      obligations: ["Ruff CI invocation"],
      exactHits: ["src/lint.py"],
      callerPaths: [".gitignore"],
      treeSample: [
        ".github/workflows/lint.yml", ".gitignore", "README.md", "pyproject.toml",
        "ruff.toml", "src/lint.py", "src/zebra.py", "src/alpha.py", "src/",
      ],
      ecosystem: "python",
      budget: { total: 5, perRepo: 5 },
    });
    expect(result.reads.map(({ path, reason }) => [path, reason])).toEqual([
      ["src/lint.py", "exact_hit"],
      [".gitignore", "caller_path"],
      [".github/workflows/lint.yml", "ecosystem_config"],
      ["pyproject.toml", "ecosystem_config"],
      ["ruff.toml", "ecosystem_config"],
    ]);
    expect(result.untouched).toEqual([
      { path: "src/zebra.py", reason: "implementation_path" },
      { path: "src/alpha.py", reason: "implementation_path" },
      { path: "README.md", reason: "tree_sample" },
    ]);
  });

  it("allows a targeted ignore-rule question to read the ignore file", () => {
    expect(selectSourceReads({
      question: "Does .gitignore exclude generated outputs?",
      exactHits: [".gitignore"], treeSample: ["CHANGELOG.md"],
      budget: { total: 1, perRepo: 1 },
    }).reads).toEqual([{ path: ".gitignore", reason: "exact_hit" }]);
  });

  it("records a referenced workflow script and reports references left over budget", () => {
    const result = selectSourceReads({
      references: [
        { path: "scripts/lint.py", referencedBy: { path: ".github/workflows/lint.yml", observationId: "obs1", detail: "run: ./scripts/lint.py" } },
        { path: "scripts/typecheck.py", referencedBy: { path: ".github/workflows/lint.yml", observationId: "obs1", detail: "entry: scripts/typecheck.py" } },
      ],
      budget: { total: 1, perRepo: 1 },
    });
    expect(result.reads).toEqual([{
      path: "scripts/lint.py", reason: "implementation_path",
      referencedBy: { path: ".github/workflows/lint.yml", observationId: "obs1", detail: "run: ./scripts/lint.py" },
    }]);
    expect(result.untouched).toEqual([{ path: "scripts/typecheck.py", reason: "implementation_path" }]);
  });
});
