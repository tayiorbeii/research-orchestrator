import { describe, expect, it } from "vitest";
import { compileProbes } from "../src/core/brief/compileProbes.js";
import { draftBriefFromGoal } from "../src/core/brief/draftBriefFromGoal.js";
import { GitHubEvidenceProvider } from "../src/adapters/GitHubEvidenceProvider.js";
import { DEFAULT_BRIEF_BUDGETS, type ResearchBrief } from "../src/schemas/researchBrief.js";
import type { BudgetLedger } from "../src/schemas/searchProbeV2.js";

const ledger = (): BudgetLedger => ({ limits: { ...DEFAULT_BRIEF_BUDGETS }, consumed: { queryUnits: 0, rpcCount: 0, reconnaissanceReads: 0, fileReads: 0, fileReadsByRepo: {}, refinementRounds: 0, refinementProbes: 0 }, cancelled: false });
const caps = new GitHubEvidenceProvider({ token: "unused" }).searchCapabilities();
const q = (id: string, facts: unknown[]) => ({ id, statement: id, intentHints: ["library_usage"], required: true, answerScope: "one", obligations: [{ facts, combine: "all", scope: "same_repository" }] });
const briefWith = (languages: string[] | undefined, questions: unknown[]): ResearchBrief => ({ ...draftBriefFromGoal("Convex Auth with Resend", { questions, languages } as never), readiness: { status: "ready" } });
const queriesFor = (brief: ResearchBrief, questionId: string) => compileProbes(brief, caps, ledger()).probes.filter((p) => p.questionIds.includes(questionId)).map((p) => p.providerQuery);

describe("language scoping", () => {
  it("never language-filters dependency facts: manifests are JSON, not the source language", () => {
    const brief = briefWith(["TypeScript"], [q("q1", [{ kind: "dependency", packageName: "@convex-dev/auth" }])]);
    for (const query of queriesFor(brief, "q1")) expect(query).not.toMatch(/language:/);
  });

  it("scopes source quotations to a single listed language", () => {
    const brief = briefWith(["TypeScript"], [q("q1", [{ kind: "quotation", signals: ["ConvexAuthNextjsProvider"] }])]);
    const queries = queriesFor(brief, "q1");
    expect(queries.some((query) => /language:TypeScript/.test(query))).toBe(true);
  });

  it("does not AND several languages or silently keep only the first", () => {
    const brief = briefWith(["TypeScript", "JavaScript"], [q("q1", [{ kind: "quotation", signals: ["ConvexAuthNextjsProvider"] }])]);
    for (const query of queriesFor(brief, "q1")) expect(query).not.toMatch(/language:/);
  });

  it("adds a broader unscoped alternative for a language-scoped probe when budget allows", () => {
    const brief = briefWith(["TypeScript"], [q("q1", [{ kind: "quotation", signals: ["ConvexAuthNextjsProvider"] }])]);
    const queries = queriesFor(brief, "q1");
    expect(queries.some((query) => /language:/.test(query))).toBe(true);
    expect(queries.some((query) => !/language:/.test(query))).toBe(true);
  });
});

describe("combined-signal probes", () => {
  it("adds one search for all of an obligation's quotation signals together", () => {
    const brief = briefWith(undefined, [q("p5", [{ kind: "quotation", signals: ["updatedToolOutput", "noOutputExpected"] }])]);
    const queries = queriesFor(brief, "p5");
    expect(queries).toContain("updatedToolOutput noOutputExpected");
    expect(queries.filter((query) => query === "updatedToolOutput" || query === "noOutputExpected").length).toBeGreaterThanOrEqual(1);
  });

  it("does not combine a dependency with a quotation (different files)", () => {
    const brief = briefWith(undefined, [q("q1", [{ kind: "dependency", packageName: "@convex-dev/auth" }, { kind: "quotation", signals: ["Resend"] }])]);
    for (const query of queriesFor(brief, "q1")) expect(query).not.toMatch(/@convex-dev\/auth.*Resend|Resend.*@convex-dev\/auth/);
  });

  it("does not merge signals across the alternative facts of an any-combine obligation", () => {
    const brief = briefWith(undefined, [{ ...q("q1", []), obligations: [{ facts: [{ kind: "quotation", signals: ["AlphaToken"] }, { kind: "quotation", signals: ["BetaToken"] }], combine: "any", scope: "same_repository" }] }]);
    for (const query of queriesFor(brief, "q1")) expect(query).not.toMatch(/AlphaToken.*BetaToken|BetaToken.*AlphaToken/);
  });

  it("combines a multi-signal fact inside an any-combine obligation and never searches its generic word alone", () => {
    // idla q4: (gmail + draft) OR (gmail + reply) searched bare "draft" and "reply" and read dovecot/gnupg NEWS files.
    const brief = briefWith(undefined, [{ ...q("q4", []), obligations: [{ facts: [
      { kind: "quotation", signals: ["n8n-nodes-base.gmail", "draft"], claimScope: "implemented" },
      { kind: "quotation", signals: ["n8n-nodes-base.gmail", "reply"], claimScope: "implemented" },
    ], combine: "any", scope: "same_repository" }] }]);
    const queries = queriesFor(brief, "q4");
    expect(queries).toContain("n8n-nodes-base.gmail draft");
    expect(queries).toContain("n8n-nodes-base.gmail reply");
    expect(queries).not.toContain("draft");
    expect(queries).not.toContain("reply");
    expect(queries).not.toContain("n8n-nodes-base.gmail draft reply");
  });
});
