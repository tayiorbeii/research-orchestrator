import { describe, expect, it } from "vitest";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";
import { executeBrief } from "../src/core/brief/executeBrief.js";
import type { ResearchBrief } from "../src/schemas/researchBrief.js";
import type { SearchProbeV2 } from "../src/schemas/searchProbeV2.js";

const budgets = { maxQuestions: 6, queryUnits: 16, reconnaissanceReads: 4, fileReads: 48, fileReadsPerRepo: 12, refinementRounds: 1, refinementProbes: 4, deadlineMs: 60_000 };
const question = (id: string, signal: string): ResearchBrief["questions"][number] => ({
  id, statement: `${signal} is used`, intentHints: ["implementation_behavior"], required: true, answerScope: "one example",
  obligations: [{ facts: [{ kind: "quotation", signals: [signal], claimScope: "implemented" }], combine: "all", scope: "same_repository" }],
});
const brief: ResearchBrief = {
  id: "reinvest", revision: 1, goal: "two facts", questions: [question("q1", "alphaToken"), question("q2", "betaToken")],
  mechanisms: [], vocabulary: [], seeds: [], allowedSourceKinds: ["repository_file"], budgets, readiness: { status: "ready" }, lookupOutcomes: [],
};
const probe = (id: string, questionId: string): SearchProbeV2 => ({ id, questionIds: [questionId], mechanismIds: [], termIds: [], purpose: "discovery", intent: questionId, providerQuery: questionId, providerArgs: { endpoint: "codeSearch" }, expectedSourceKinds: ["repository_file"], expectedPaths: [], rationale: "test", alternativesLeftOpen: [], predecessorProbeIds: [] });
const probes = [probe("p1", "q1"), probe("p2", "q2")];

/** q1 hits in four repos; q2 hits in three, of which the first-ranked one is a false lead. */
class LeadProvider extends MockEvidenceProvider {
  reads: string[] = [];
  override async searchCode(items: Parameters<MockEvidenceProvider["searchCode"]>[0]) {
    const id = items[0]!.id;
    if (id === "p1") return ["a/one", "a/two", "a/three", "a/four"].map((repo) => ({ repo, path: "src/alpha.ts", probeId: id }));
    return ["b/false-lead", "b/real", "b/other"].map((repo) => ({ repo, path: "src/beta.ts", probeId: id }));
  }
  override async getRepoMetadata({ repo }: { repo: string }) { const [owner, name] = repo.split("/"); return { repo, owner: owner!, name: name!, defaultBranch: "main" }; }
  override async getFile(input: Parameters<MockEvidenceProvider["getFile"]>[0]) {
    this.reads.push(`${input.repo}:${input.path}`);
    const content = input.path === "src/alpha.ts" ? "export const alphaToken = 1;" : input.repo === "b/false-lead" ? "// mentions nothing useful" : "export const betaToken = 2;";
    return { provider: "mock" as const, repo: input.repo, path: input.path, readStatus: "complete" as const, content };
  }
}

const compile = (_brief: ResearchBrief, _caps: unknown, ledger: never) => ({ probes, failures: [], ledger });

describe("budget reinvestment after the first proving pass", () => {
  it("promotes an unread hit repository when a required question is still unresolved", async () => {
    const provider = new LeadProvider();
    const run = await executeBrief(brief, { provider, maxCandidates: 2, validateBrief: (item) => ({ brief: item, issues: [] }), compileProbes: compile as never });
    // First pass: the weakest question's first lead (a false one) and one q1 repo.
    expect(provider.reads.slice(0, 2)).toEqual(["b/false-lead:src/beta.ts", "a/one:src/alpha.ts"]);
    // Reinvestment: q2 stayed unresolved, so its next unread hit was promoted and read.
    expect(provider.reads).toContain("b/real:src/beta.ts");
    expect(run.candidates.map((candidate) => candidate.repo)).toContain("b/real");
    expect(run.coverage.map((item) => `${item.questionId}:${item.status}`)).toEqual(["q1:satisfied", "q2:satisfied"]);
    expect(run.outcome.status).toBe("complete");
    expect(run.warnings.some((warning) => warning.startsWith("reinvested budget: round 1"))).toBe(true);
    // Observations and anchors of the promoted repo carry unique ids.
    const ids = run.observations.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(run.budgetLedger?.consumed.fileReads).toBe(provider.reads.length);
  });

  it("does not reinvest once the read budget is spent", async () => {
    const provider = new LeadProvider();
    const run = await executeBrief({ ...brief, budgets: { ...budgets, fileReads: 2 } }, { provider, maxCandidates: 2, validateBrief: (item) => ({ brief: item, issues: [] }), compileProbes: compile as never });
    expect(provider.reads).toHaveLength(2);
    expect(run.candidates).toHaveLength(2);
    expect(run.coverage.find((item) => item.questionId === "q2")?.status).not.toBe("satisfied");
    expect(run.outcome.status).toBe("partial");
  });

  it("stops when every required question is satisfied without touching further leads", async () => {
    const provider = new LeadProvider();
    const run = await executeBrief({ ...brief, questions: [question("q1", "alphaToken")] }, { provider, maxCandidates: 2, validateBrief: (item) => ({ brief: item, issues: [] }), compileProbes: (_b: ResearchBrief, _c: unknown, ledger: never) => ({ probes: [probes[0]!], failures: [], ledger }) as never });
    expect(run.outcome.status).toBe("complete");
    expect(provider.reads).toHaveLength(2);
    expect(run.warnings.some((warning) => warning.startsWith("reinvested budget"))).toBe(false);
  });
});
