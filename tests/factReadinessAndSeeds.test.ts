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
