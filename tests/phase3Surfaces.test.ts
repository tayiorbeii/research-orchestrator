import { describe, expect, it, vi } from "vitest";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";
import { FileResearchCache } from "../src/cache/FileResearchCache.js";
import { runBriefInput } from "../src/cli.js";
import { findImplementations } from "../src/mcp/tools/findImplementations.js";
import type { ResearchBrief } from "../src/schemas/researchBrief.js";
import type { BudgetLedger, SearchProbeV2 } from "../src/schemas/searchProbeV2.js";

const brief: ResearchBrief = {
  id: "surface-equivalence", revision: 1, goal: "Find a source-backed package declaration",
  questions: [{ id: "q1", statement: "Is @convex-dev/auth declared?", intentHints: ["library_usage"], required: true, answerScope: "one repository example", obligations: [{ facts: [{ kind: "dependency", packageName: "@convex-dev/auth", file: "package.json" }], combine: "all", scope: "same_repository" }] }],
  mechanisms: [], vocabulary: [{ id: "term1", text: "@convex-dev/auth", questionIds: ["q1"], kind: "package", origin: "user_supplied", status: "observed" }],
  seeds: [{ repo: "headcodecms/headcodecms", origin: "user_supplied" }], allowedSourceKinds: ["repository_file"],
  budgets: { maxQuestions: 6, queryUnits: 16, reconnaissanceReads: 4, fileReads: 48, fileReadsPerRepo: 12, refinementRounds: 1, refinementProbes: 4, deadlineMs: 60_000 },
  readiness: { status: "ready" }, lookupOutcomes: [],
};
const probe: SearchProbeV2 = { id: "surface-p1", questionIds: ["q1"], mechanismIds: [], termIds: ["term1"], purpose: "discovery", intent: "find declaration", providerQuery: "@convex-dev/auth", providerArgs: {}, expectedSourceKinds: ["repository_file"], expectedPaths: ["package.json"], rationale: "Caller supplied package", alternativesLeftOpen: [], predecessorProbeIds: [] };
const compileProbes = (_brief: ResearchBrief, _capabilities: ReturnType<MockEvidenceProvider["searchCapabilities"]>, ledger: BudgetLedger) => ({ probes: [probe], failures: [], ledger });
const deps = { validateBrief: (input: ResearchBrief) => ({ brief: input, issues: [] }), compileProbes };

describe("Phase 3 CLI and MCP surfaces", () => {
  it("accepts the same brief and returns equivalent core outcomes", async () => {
    const cacheSave = vi.spyOn(FileResearchCache.prototype, "saveRun").mockResolvedValue("memory-cache");
    try {
      const cliRun = await runBriefInput(brief, { provider: new MockEvidenceProvider(), deterministic: true, ...deps });
      const mcp = await findImplementations({ brief, mode: "mock" }, {
        executeBrief: async (input, options) => (await import("../src/core/brief/executeBrief.js")).executeBrief(input, { ...options, ...deps }),
        validateBrief: deps.validateBrief,
      });
      expect(mcp.mode).toBe("mock");
      expect(mcp.provider).toBe("mock");
      expect(mcp.evidenceOrigin).toBe("synthetic_mock");
      expect({ outcome: mcp.outcome, coverage: mcp.coverage, assessments: mcp.assessments, probeOutcomes: mcp.probeOutcomes?.map(({ durationMs: _duration, ...item }) => item) }).toEqual({
        outcome: cliRun.outcome, coverage: cliRun.coverage, assessments: cliRun.assessments, probeOutcomes: cliRun.probeOutcomes?.map(({ durationMs: _duration, ...item }) => item),
      });
    } finally {
      cacheSave.mockRestore();
    }
  });
});
