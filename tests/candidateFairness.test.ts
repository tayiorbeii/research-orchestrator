import { describe, expect, it, vi } from "vitest";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";
import type { EvidenceProvider } from "../src/adapters/EvidenceProvider.js";
import { executeBrief } from "../src/core/brief/executeBrief.js";
import type { ResearchBrief } from "../src/schemas/researchBrief.js";
import type { BudgetLedger, SearchProbeV2 } from "../src/schemas/searchProbeV2.js";

const budgets = { maxQuestions: 6, queryUnits: 16, reconnaissanceReads: 4, fileReads: 48, fileReadsPerRepo: 12, refinementRounds: 0, refinementProbes: 0, deadlineMs: 60_000 };
const question = (id: string, signal: string) => ({ id, statement: `Uses ${signal}?`, intentHints: ["library_usage" as const], required: true, answerScope: "one example", obligations: [{ facts: [{ kind: "quotation" as const, signals: [signal] }], combine: "all" as const, scope: "same_repository" as const }] });
const brief: ResearchBrief = {
  id: "fairness", revision: 1, goal: "three independent questions",
  questions: [question("q1", "Alpha"), question("q2", "Beta"), question("q3", "Gamma")],
  mechanisms: [], vocabulary: ["Alpha", "Beta", "Gamma"].map((text, i) => ({ id: `t${i + 1}`, text, questionIds: [`q${i + 1}`], kind: "symbol" as const, origin: "user_supplied" as const, status: "proposed" as const })),
  seeds: [], allowedSourceKinds: ["repository_file"], budgets, readiness: { status: "ready" }, lookupOutcomes: [],
};
const probeFor = (n: number): SearchProbeV2 => ({ id: `p${n}`, questionIds: [`q${n}`], mechanismIds: [], termIds: [`t${n}`], purpose: "discovery", intent: "find", providerQuery: ["Alpha", "Beta", "Gamma"][n - 1]!, providerArgs: { endpoint: "codeSearch" }, expectedSourceKinds: ["repository_file"], expectedPaths: [], rationale: "test", alternativesLeftOpen: [], predecessorProbeIds: [] });
const compile = (_b: ResearchBrief, _c: ReturnType<EvidenceProvider["searchCapabilities"]>, ledger: BudgetLedger) => ({ probes: [probeFor(1), probeFor(2), probeFor(3)], failures: [], ledger });

describe("candidate selection across questions", () => {
  it("gives every question's leads a share of the candidate cap", async () => {
    const provider = new MockEvidenceProvider();
    // q1's search returns many more leads than q2/q3, as a broad package search does.
    vi.spyOn(provider, "searchCode").mockImplementation(async (probes) => {
      const q = probes[0]!.query;
      const count = q === "Alpha" ? 40 : 12;
      return Array.from({ length: count }, (_, i) => ({ repo: `${q.toLowerCase()}/repo-${i}`, path: "src/index.ts", snippet: q, probeId: probes[0]!.id }));
    });
    const run = await executeBrief(brief, { provider, deterministic: true, maxCandidates: 12, validateBrief: (b) => ({ brief: b, issues: [] }), compileProbes: compile });
    // The first pass fills the cap fairly; later reinvestment rounds may promote
    // further unread leads (bounded by one more cap) because nothing was proved.
    const firstPass = run.candidates.slice(0, 12);
    const perQuestion = (prefix: string) => firstPass.filter((c) => c.repo.startsWith(prefix)).length;
    expect(run.candidates.length).toBeGreaterThanOrEqual(12);
    expect(run.candidates.length).toBeLessThanOrEqual(24);
    expect(perQuestion("alpha/")).toBeGreaterThanOrEqual(3);
    expect(perQuestion("beta/")).toBeGreaterThanOrEqual(3);
    expect(perQuestion("gamma/")).toBeGreaterThanOrEqual(3);
  });

  it("puts repositories that match several questions first", async () => {
    const provider = new MockEvidenceProvider();
    vi.spyOn(provider, "searchCode").mockImplementation(async (probes) => {
      const q = probes[0]!.query;
      const own = Array.from({ length: 10 }, (_, i) => ({ repo: `${q.toLowerCase()}/repo-${i}`, path: "src/index.ts", snippet: q, probeId: probes[0]!.id }));
      return [...own, { repo: "shared/everything", path: `src/${q}.ts`, snippet: q, probeId: probes[0]!.id }];
    });
    const run = await executeBrief(brief, { provider, deterministic: true, maxCandidates: 6, validateBrief: (b) => ({ brief: b, issues: [] }), compileProbes: compile });
    expect(run.candidates[0]?.repo).toBe("shared/everything");
    expect(run.candidates[0]?.matchedPaths.sort()).toEqual(["src/Alpha.ts", "src/Beta.ts", "src/Gamma.ts"]);
  });
});

describe("declaration files join the read set", () => {
  it("reads package.json for repositories matched by a dependency-fact question", async () => {
    const depBrief: ResearchBrief = {
      ...brief, questions: [{ ...question("q1", "Alpha"), obligations: [{ facts: [{ kind: "dependency", packageName: "alpha-pkg" }], combine: "all", scope: "same_repository" }] }],
      vocabulary: [{ id: "t1", text: "alpha-pkg", questionIds: ["q1"], kind: "package", origin: "user_supplied", status: "proposed" }],
    };
    class Provider extends MockEvidenceProvider {
      reads: string[] = [];
      override async searchCode(probes: Parameters<MockEvidenceProvider["searchCode"]>[0]) { return [{ repo: "acme/app", path: "docs/setup.md", snippet: "alpha-pkg", probeId: probes[0]!.id }]; }
      override async getFile(input: Parameters<MockEvidenceProvider["getFile"]>[0]) {
        this.reads.push(input.path);
        return { provider: "mock" as const, repo: input.repo, path: input.path, readStatus: "complete" as const, content: input.path === "package.json" ? JSON.stringify({ dependencies: { "alpha-pkg": "^1.0.0" } }) : "install alpha-pkg" };
      }
    }
    const provider = new Provider();
    const run = await executeBrief(depBrief, { provider, deterministic: true, validateBrief: (b) => ({ brief: b, issues: [] }), compileProbes: (_b, _c, ledger) => ({ probes: [probeFor(1)], failures: [], ledger }) });
    expect(provider.reads).toContain("package.json");
    expect(run.candidates[0]?.matchedPaths).toEqual(expect.arrayContaining(["docs/setup.md", "package.json"]));
  });
});
