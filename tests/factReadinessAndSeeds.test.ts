import { describe, expect, it, vi } from "vitest";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";
import { executeBrief } from "../src/core/brief/executeBrief.js";
import { draftBriefFromGoal } from "../src/core/brief/draftBriefFromGoal.js";
import type { ResearchBrief } from "../src/schemas/researchBrief.js";

type Question = ResearchBrief["questions"][number];

function question(id: string, facts: Question["obligations"][number]["facts"]): Question {
  return {
    id,
    statement: `How does ${id} work?`,
    intentHints: ["implementation_behavior"],
    required: true,
    answerScope: "One source file.",
    obligations: [{ facts, combine: "all", scope: "same_repository" }],
  };
}

describe("a question's facts, not the goal sentence, decide readiness and search order", () => {
  it("is ready when the goal is bland but the facts name distinctive tokens", () => {
    const brief = draftBriefFromGoal("Find out how this works", {
      questions: [question("q1", [{ kind: "quotation", signals: ["mask_error_details"], claimScope: "implemented" }])],
    });
    expect(brief.readiness.status).toBe("ready");
    expect(brief.vocabulary.map((term) => term.text)).toEqual(["mask_error_details"]);
  });

  it("is ready when a bland goal meets a dependency fact", () => {
    const brief = draftBriefFromGoal("Find out how this works", {
      questions: [question("q1", [{ kind: "dependency", packageName: "@convex-dev/auth" }])],
    });
    expect(brief.readiness.status).toBe("ready");
  });

  it("still asks for input when neither the goal nor the facts are distinctive", () => {
    const brief = draftBriefFromGoal("Research strict lint coverage", {
      questions: [question("q1", [{ kind: "quotation", signals: ["feature"], claimScope: "implemented" }])],
    });
    expect(brief.readiness.status).toBe("needs_input");
  });

  it("puts structural tokens ahead of plain words so each question's first probe is the sharpest", () => {
    const brief = draftBriefFromGoal("Find how errors map", {
      questions: [question("q1", [{ kind: "quotation", signals: ["retry", "HttpError"], claimScope: "implemented" }])],
    });
    expect(brief.vocabulary.map((term) => term.text)).toEqual(["HttpError", "retry"]);
  });

  it("keeps each question's terms scoped to that question", () => {
    const brief = draftBriefFromGoal("Find two things", {
      questions: [
        question("q1", [{ kind: "quotation", signals: ["AlphaToken"], claimScope: "implemented" }]),
        question("q2", [{ kind: "quotation", signals: ["BetaToken"], claimScope: "implemented" }]),
      ],
    });
    expect(brief.vocabulary.map((term) => [term.text, term.questionIds.join()])).toEqual([["AlphaToken", "q1"], ["BetaToken", "q2"]]);
  });
});

describe("seed repositories without a fact path", () => {
  const seeded = (path?: string): ResearchBrief => draftBriefFromGoal("Find retry behavior", {
    questions: [question("q1", [{ kind: "quotation", signals: ["BackOffHTTPClient"], claimScope: "implemented", ...(path ? { path } : {}) }])],
    seeds: [{ repo: "burnash/gspread", origin: "user_supplied" }],
  });
  const run = async (brief: ResearchBrief) => {
    const provider = new MockEvidenceProvider();
    vi.spyOn(provider, "searchCode").mockResolvedValue([]);
    return executeBrief(brief, { provider });
  };

  it("warns that the seed is read at README.md only", async () => {
    const result = await run(seeded());
    const warning = result.warnings?.find((line) => line.includes("burnash/gspread"));
    expect(warning).toContain("only read at README.md");
    expect(warning).toContain("q1");
    expect(warning).toContain("path");
  });

  it("stays quiet when the fact names the file to read", async () => {
    const result = await run(seeded("gspread/http_client.py"));
    expect(result.warnings?.some((line) => line.includes("only read at README.md"))).toBe(false);
  });
});

describe("a seed names the files it is read at", () => {
  const facts = (path: string) => [{ kind: "quotation" as const, signals: ["BackOffHTTPClient"], claimScope: "implemented" as const, path }];
  const twoRepoBrief = (seeds: ResearchBrief["seeds"]): ResearchBrief => draftBriefFromGoal("Compare two repositories", {
    questions: [question("q1", facts("a/mod_a.py")), question("q2", facts("b/mod_b.py"))],
    seeds,
  });
  const readsFor = async (brief: ResearchBrief, hits: { repo: string; path: string }[] = []) => {
    const provider = new MockEvidenceProvider();
    vi.spyOn(provider, "searchCode").mockResolvedValue(hits.map((hit) => ({ ...hit, probeId: "p1" })));
    const reads = new Map<string, Set<string>>();
    vi.spyOn(provider, "getFile").mockImplementation(async ({ repo, path }) => {
      (reads.get(repo) ?? (reads.set(repo, new Set()), reads.get(repo)!)).add(path);
      return { provider: "mock", repo, path, content: "" } as Awaited<ReturnType<MockEvidenceProvider["getFile"]>>;
    });
    const result = await executeBrief(brief, { provider });
    return { reads, result };
  };

  it("reads each seed only at its own paths, not at every fact's path", async () => {
    const { reads } = await readsFor(twoRepoBrief([
      { repo: "acme/alpha", origin: "user_supplied", paths: ["a/mod_a.py"] },
      { repo: "acme/beta", origin: "user_supplied", paths: ["b/mod_b.py"] },
    ]));
    expect([...(reads.get("acme/alpha") ?? [])]).toEqual(["a/mod_a.py"]);
    expect([...(reads.get("acme/beta") ?? [])]).toEqual(["b/mod_b.py"]);
  });

  it("still reads every seed at every fact path when it names none", async () => {
    const { reads } = await readsFor(twoRepoBrief([{ repo: "acme/alpha", origin: "user_supplied" }]));
    expect([...(reads.get("acme/alpha") ?? [])].sort()).toEqual(["a/mod_a.py", "b/mod_b.py"]);
  });

  it("reads a seed that search also found at the paths it names, not only at the hit", async () => {
    const { reads } = await readsFor(twoRepoBrief([{ repo: "acme/alpha", origin: "user_supplied", paths: ["a/mod_a.py"] }]),
      [{ repo: "acme/alpha", path: "docs/other.md" }]);
    expect(reads.get("acme/alpha")?.has("a/mod_a.py")).toBe(true);
  });

  it("reads a seed without paths at the fact paths even when search also found it", async () => {
    const { reads } = await readsFor(twoRepoBrief([{ repo: "acme/alpha", origin: "user_supplied" }]),
      [{ repo: "acme/alpha", path: "docs/other.md" }]);
    expect(reads.get("acme/alpha")?.has("a/mod_a.py")).toBe(true);
    expect(reads.get("acme/alpha")?.has("b/mod_b.py")).toBe(true);
  });

  it("warns when several seeds all inherit the same fact paths", async () => {
    const { result } = await readsFor(twoRepoBrief([
      { repo: "acme/alpha", origin: "user_supplied" },
      { repo: "acme/beta", origin: "user_supplied" },
    ]));
    const warning = result.warnings?.find((line) => line.includes("every seed"));
    expect(warning).toContain("acme/alpha");
    expect(warning).toContain("paths");
  });

  it("stays quiet about shared fact paths when every seed names its own", async () => {
    const { result } = await readsFor(twoRepoBrief([
      { repo: "acme/alpha", origin: "user_supplied", paths: ["a/mod_a.py"] },
      { repo: "acme/beta", origin: "user_supplied", paths: ["b/mod_b.py"] },
    ]));
    expect(result.warnings?.some((line) => line.includes("every seed"))).toBe(false);
  });

  it("does not warn that a seed is only read at README.md when it names paths", async () => {
    const brief = draftBriefFromGoal("Find retry behavior", {
      questions: [question("q1", [{ kind: "quotation", signals: ["BackOffHTTPClient"], claimScope: "implemented" }])],
      seeds: [{ repo: "burnash/gspread", origin: "user_supplied", paths: ["gspread/http_client.py"] }],
    });
    const { result } = await readsFor(brief);
    expect(result.warnings?.some((line) => line.includes("only read at README.md"))).toBe(false);
  });
});
