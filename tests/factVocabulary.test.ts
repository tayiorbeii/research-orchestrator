import { describe, expect, it } from "vitest";
import { draftBriefFromGoal } from "../src/core/brief/draftBriefFromGoal.js";

const question = (id: string, facts: unknown[]) => ({
  id, statement: `Question ${id}`, intentHints: ["library_usage"], required: true, answerScope: "One repository.",
  obligations: [{ facts, combine: "all", scope: "same_repository" }],
});

describe("explicit questions search by their obligation facts", () => {
  it("derives vocabulary from dependency, quotation, config, and workflow facts instead of goal words", () => {
    const brief = draftBriefFromGoal("Implement email magic-link sign-in with Convex Auth and Resend", {
      questions: [
        question("q1", [{ kind: "dependency", packageName: "@convex-dev/auth" }, { kind: "quotation", signals: ["Resend"] }]),
        question("q2", [{ kind: "quotation", signals: ["ConvexAuthNextjsProvider"] }]),
        question("q3", [{ kind: "config", keyPath: "auth.providers" }, { kind: "workflow", command: "npx convex dev" }]),
      ],
    } as never);
    const termsFor = (id: string) => brief.vocabulary.filter((term) => term.questionIds.includes(id)).map((term) => [term.text, term.kind]);
    expect(termsFor("q1")).toEqual([["@convex-dev/auth", "package"], ["Resend", "symbol"]]);
    expect(termsFor("q2")).toEqual([["ConvexAuthNextjsProvider", "symbol"]]);
    expect(termsFor("q3")).toEqual([["auth.providers", "config_key"], ["npx convex dev", "cli_token"]]);
    expect(brief.vocabulary.some((term) => term.text === "sign-in")).toBe(false);
  });

  it("keeps goal-derived vocabulary for goal-only requests", () => {
    const brief = draftBriefFromGoal("Next.js + Convex app with email magic links via Resend");
    expect(brief.vocabulary.map((term) => term.text)).toContain("Convex");
  });
});
