import { describe, expect, it } from "vitest";
import { describeBudgets, LIVE_DEFAULT_DEADLINE_MS, parseBudgetFlag, resolveRunBudgets } from "../src/core/brief/runBudgets.js";
import { DEFAULT_BRIEF_BUDGETS } from "../src/schemas/researchBrief.js";

describe("run budgets", () => {
  it("gives live runs a 30-minute deadline and keeps mock runs at the brief default", () => {
    expect(resolveRunBudgets(DEFAULT_BRIEF_BUDGETS, { live: true }).deadlineMs).toBe(LIVE_DEFAULT_DEADLINE_MS);
    expect(LIVE_DEFAULT_DEADLINE_MS).toBe(30 * 60_000);
    expect(resolveRunBudgets(DEFAULT_BRIEF_BUDGETS, { live: false }).deadlineMs).toBe(DEFAULT_BRIEF_BUDGETS.deadlineMs);
  });

  it("keeps a brief's own lower deadline for live runs", () => {
    expect(resolveRunBudgets({ ...DEFAULT_BRIEF_BUDGETS, deadlineMs: 20_000 }, { live: true }).deadlineMs).toBe(20_000);
  });

  it("applies explicit operator overrides over every default", () => {
    const resolved = resolveRunBudgets(DEFAULT_BRIEF_BUDGETS, { live: true, overrides: { deadlineMs: 90 * 60_000, fileReads: 200 } });
    expect(resolved.deadlineMs).toBe(90 * 60_000);
    expect(resolved.fileReads).toBe(200);
    expect(resolved.queryUnits).toBe(DEFAULT_BRIEF_BUDGETS.queryUnits);
  });

  it("parses --budget key=value lists and rejects unknown or invalid entries", () => {
    expect(parseBudgetFlag("fileReads=96, queryUnits=32")).toEqual({ fileReads: 96, queryUnits: 32 });
    expect(() => parseBudgetFlag("fileReadz=1")).toThrow(/invalid --budget entry/);
    expect(() => parseBudgetFlag("fileReads=-1")).toThrow(/>= 0/);
    expect(() => parseBudgetFlag("deadlineMs=0")).toThrow(/>= 1/);
    expect(() => parseBudgetFlag("fileReads")).toThrow(/invalid --budget entry/);
  });

  it("describes the effective deadline in minutes", () => {
    expect(describeBudgets(resolveRunBudgets(DEFAULT_BRIEF_BUDGETS, { live: true }))).toMatch(/^deadline 30m,/);
    expect(describeBudgets(DEFAULT_BRIEF_BUDGETS)).toMatch(/^deadline 1m,/);
  });
});
