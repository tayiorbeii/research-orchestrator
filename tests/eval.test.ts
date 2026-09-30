import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { BENCHMARK_TASKS } from "../src/eval/benchmarkTasks.js";
import { runEval } from "../src/eval/runEval.js";

describe("offline labeled replay evaluation", () => {
  it("keeps synthetic labels independent, reports held-out fixtures, and measures each metric separately", async () => {
    expect(BENCHMARK_TASKS).toHaveLength(6);
    expect(BENCHMARK_TASKS.every((task) => task.synthetic && task.provenance.includes("synthetic"))).toBe(true);
    expect(BENCHMARK_TASKS.every((task) => task.sources.some((source) => source.relevance === "negative") && task.sources.some((source) => source.relevance === "noisy"))).toBe(true);

    const report = await runEval();
    expect(report.evaluationKind).toBe("mock_replay");
    expect(report.synthetic).toBe(true);
    expect(report.corpus.heldOutFixtures).toEqual(["review-tool-capabilities", "mixed-api-and-retry", "underspecified-improvement"]);
    expect(report.metrics.every((item) => item.intentGroups.length > 0 && item.questionCoverage.byQuestion.length > 0)).toBe(true);
    expect(report.totals.unsupportedVerificationCount.total).toBe(0);

    // Positive examples and the held-out source-kind proposal fixture pass independently.
    for (const id of ["library-webhook-signature", "bounded-retry-cancellation", "projection-rebuilding", "mixed-api-and-retry"]) {
      expect(report.metrics.find((item) => item.taskId === id)?.supportedClaimPrecision.trueSupported).toBeGreaterThan(0);
    }
    expect(report.metrics.find((item) => item.taskId === "review-tool-capabilities")?.questionCoverage.coverageMatch).toBe(true);
    expect(report.metrics.find((item) => item.taskId === "review-tool-capabilities")?.knownDefect).toBeUndefined();
    expect(report.metrics.find((item) => item.taskId === "underspecified-improvement")?.events.clarificationOrAbstention).toBe(1);
    expect(report.metrics.find((item) => item.taskId === "underspecified-improvement")?.cost.queryCount).toBe(0);
    expect(report.metrics[0]?.legacyRoundTripLosses.fields).toContain("coverage");
  });

  it("keeps all demo receipts visibly synthetic and preserves the vocabulary round trip", async () => {
    const receipts = [
      "library-webhook-signature.json", "projection-vocabulary-round-trip.json",
      "review-tool-capabilities.json", "underspecified-improvement.json",
    ];
    const loaded = await Promise.all(receipts.map(async (name) => JSON.parse(await readFile(new URL(`../examples/receipts/${name}`, import.meta.url), "utf8")) as Record<string, unknown>));
    expect(loaded.every((receipt) => receipt.synthetic === true && String(receipt.banner).includes("SYNTHETIC MOCK RECEIPT"))).toBe(true);
    expect(loaded[1]?.vocabularyRoundTrip).toMatchObject({ initialReadiness: "needs_input", revisedReadiness: "ready", issues: [] });
    expect(loaded[2]?.result).toMatchObject({ questionCoverage: { coverageMatch: true } });
    expect(loaded[3]?.result).toMatchObject({ surface: "goal" });
  });
});
