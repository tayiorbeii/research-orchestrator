// Run-time budget resolution. A brief may not raise its own budgets
// (validateBrief reports `budget_explicitly_raised`); the operator running the
// command may, through explicit CLI flags or MCP `budgetOverrides`. Live runs
// also get a wall-clock deadline sized for real GitHub research: a full run
// with many questions and proof reads can take tens of minutes, while the
// 60-second brief default only suits deterministic mock runs.
import { DEFAULT_BRIEF_BUDGETS, DEFAULT_BRIEF_DEADLINE_MS, type BudgetLimits } from "../../schemas/researchBrief.js";

/** Default wall-clock deadline for live (octocode/github) runs: 30 minutes. */
export const LIVE_DEFAULT_DEADLINE_MS = 30 * 60_000;

export type BudgetOverrides = Partial<BudgetLimits>;

const BUDGET_KEYS = Object.keys(DEFAULT_BRIEF_BUDGETS) as Array<keyof BudgetLimits>;

/**
 * Effective limits for one run. A live run whose brief still carries the
 * default deadline gets LIVE_DEFAULT_DEADLINE_MS; a brief that chose a
 * different (lower) deadline keeps it. Explicit overrides win over both.
 */
export function resolveRunBudgets(budgets: BudgetLimits, options: { live: boolean; overrides?: BudgetOverrides }): BudgetLimits {
  const resolved: BudgetLimits = { ...budgets };
  if (options.live && resolved.deadlineMs === DEFAULT_BRIEF_DEADLINE_MS) resolved.deadlineMs = LIVE_DEFAULT_DEADLINE_MS;
  for (const [key, value] of Object.entries(options.overrides ?? {}) as Array<[keyof BudgetLimits, number | undefined]>) {
    if (value !== undefined) resolved[key] = value;
  }
  return resolved;
}

/** Parse `--budget fileReads=96,queryUnits=32` into overrides. */
export function parseBudgetFlag(value: string): BudgetOverrides {
  const overrides: BudgetOverrides = {};
  for (const part of value.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [rawKey, rawValue, ...rest] = part.split("=");
    const key = rawKey?.trim() as keyof BudgetLimits;
    if (rest.length || rawValue === undefined || !BUDGET_KEYS.includes(key)) {
      throw new Error(`invalid --budget entry "${part}" (expected key=integer; keys: ${BUDGET_KEYS.join(", ")})`);
    }
    const parsed = Number(rawValue.trim());
    const minimum = key === "deadlineMs" ? 1 : 0;
    if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`--budget ${key} must be an integer >= ${minimum}`);
    overrides[key] = parsed;
  }
  return overrides;
}

/** Human-readable one-line summary of the limits a run will use. */
export function describeBudgets(budgets: BudgetLimits): string {
  const minutes = budgets.deadlineMs / 60_000;
  const deadline = minutes >= 1 ? `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m` : `${Math.round(budgets.deadlineMs / 1000)}s`;
  return `deadline ${deadline}, queryUnits ${budgets.queryUnits}, fileReads ${budgets.fileReads} (${budgets.fileReadsPerRepo}/repo), questions ${budgets.maxQuestions}`;
}
