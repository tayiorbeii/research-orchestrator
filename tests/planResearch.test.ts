import { describe, expect, it, vi } from "vitest";
import { planResearch } from "../src/mcp/tools/planResearch.js";
import type { ResearchBrief } from "../src/schemas/researchBrief.js";

const brief: ResearchBrief = {
  id: "plan-one", revision: 1, goal: "Explore an unfamiliar pattern",
  questions: [{ id: "q1", statement: "Which mechanism is used?", intentHints: ["architecture_pattern"], required: true, answerScope: "one documented example", obligations: [{ facts: [{ kind: "quotation", signals: ["mechanism"] }], combine: "any", scope: "across_examples" }] }],
  mechanisms: [], vocabulary: [], seeds: [], allowedSourceKinds: ["repository_file"],
  budgets: { maxQuestions: 6, queryUnits: 16, reconnaissanceReads: 4, fileReads: 48, fileReadsPerRepo: 12, refinementRounds: 1, refinementProbes: 4, deadlineMs: 60_000 },
  readiness: { status: "needs_input", reasons: [{ code: "missing_vocabulary", questionIds: ["q1"], detail: "Provide sourced mechanism names." }] }, lookupOutcomes: [],
};

describe("research.planResearch", () => {
  it("returns an explicit needs-input brief without representing lookup as completed", async () => {
    const validateBrief = vi.fn((input: ResearchBrief) => ({ brief: input, issues: [] }));
    const result = await planResearch({ goal: brief.goal }, {
      draftBriefFromGoal: () => brief,
      validateBrief,
    });
    expect(result).toMatchObject({ readiness: brief.readiness, needs: brief.readiness.status === "needs_input" ? brief.readiness.reasons : [], researchPerformed: false });
    expect(validateBrief).toHaveBeenCalledOnce();
  });

  it("accepts a host submission and returns an immutable, lineage-linked revision", async () => {
    const result = await planResearch({
      brief,
      submission: {
        terms: [{ id: "term-1", text: "knownApi", questionIds: ["q1"], kind: "symbol", origin: "remote_source_derived", sourceRefs: ["docs:api"], status: "observed" }],
        lookupOutcomes: [{ questionId: "q1", sourceRef: "docs:api", status: "succeeded", termIdsGained: ["term-1"] }],
      },
    });
    expect(result).toMatchObject({ readiness: { status: "ready" }, brief: { revision: 2, lineage: { parentId: brief.id, parentRevision: 1 } }, researchPerformed: false });
    expect(result.brief.questions[0]?.statement).toBe(brief.questions[0]?.statement);
  });

  it("rejects unknown submission keys instead of stripping them", async () => {
    await expect(planResearch({ brief, submission: { terms: [], lookupOutcomes: [], extra: true } })).rejects.toThrow();
    const result = await planResearch({
      brief,
      submission: { terms: [{ id: "bad", text: "knownApi", questionIds: ["q1"], kind: "symbol", origin: "remote_source_derived", status: "proposed", extra: true }], lookupOutcomes: [] },
    });
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_unrecognized_keys" })]));
  });
});
