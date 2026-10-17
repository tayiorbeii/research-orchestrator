import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";
import { executeBrief } from "../src/core/brief/executeBrief.js";
import { deriveBriefReport, isBriefRun, renderBriefResearchMd } from "../src/core/report/briefReport.js";
import { writeArtifacts } from "../src/core/writeArtifacts.js";
import type { ResearchBrief } from "../src/schemas/researchBrief.js";
import type { SearchProbeV2 } from "../src/schemas/searchProbeV2.js";

const budgets = { maxQuestions: 6, queryUnits: 16, reconnaissanceReads: 4, fileReads: 48, fileReadsPerRepo: 12, refinementRounds: 0, refinementProbes: 0, deadlineMs: 60_000 };
const question = (id: string, statement: string, signals: string[], claimScope: "implemented" | "advertised" = "implemented"): ResearchBrief["questions"][number] => ({
  id, statement, intentHints: ["implementation_behavior"], required: true, answerScope: "one",
  obligations: [{ facts: [{ kind: "quotation", signals, claimScope }], combine: "all", scope: "same_repository" }],
});
const brief: ResearchBrief = {
  id: "report", revision: 1, goal: "Magic links with Convex Auth and Resend", mechanisms: [], vocabulary: [], seeds: [{ repo: "headcodecms/headcodecms", origin: "user_supplied" }, { repo: "justinwlin/convex-magic-link-authentication", origin: "user_supplied" }],
  allowedSourceKinds: ["repository_file"], budgets, readiness: { status: "ready" }, lookupOutcomes: [],
  questions: [
    question("q-provider", "How is the Resend provider configured?", ["Resend("]),
    question("q-middleware", "Is a route matcher used?", ["createRouteMatcher"]),
    question("q-docs-only", "Is SITE_URL documented in source?", ["SITE_URL"]),
  ],
};
const probe = (id: string, questionId: string): SearchProbeV2 => ({ id, questionIds: [questionId], mechanismIds: [], termIds: [], purpose: "discovery", intent: questionId, providerQuery: questionId, providerArgs: { endpoint: "codeSearch" }, expectedSourceKinds: ["repository_file"], expectedPaths: [], rationale: "t", alternativesLeftOpen: [], predecessorProbeIds: [] });
const compile = ((_b: unknown, _c: unknown, ledger: never) => ({ probes: brief.questions.map((item) => probe(`p-${item.id}`, item.id)), failures: [], ledger })) as never;

describe("brief report model", () => {
  it("lists supported findings, leads and gaps per question from the run", async () => {
    const run = await executeBrief(brief, { provider: new MockEvidenceProvider(), deterministic: true, validateBrief: (item) => ({ brief: item, issues: [] }), compileProbes: compile });
    expect(isBriefRun(run)).toBe(true);
    const report = deriveBriefReport(run as never, run.candidates.flatMap((candidate) => candidate.candidateSignals.flatMap((signal) => signal.evidence ?? [])), { status: run.outcome.status, reasons: run.outcome.reasons });
    const provider = report.questions.find((item) => item.id === "q-provider")!;
    expect(provider.status).toBe("satisfied");
    expect(provider.supported[0]).toMatchObject({ repo: "headcodecms/headcodecms", path: "convex/auth.ts", fact: "Resend(", revision: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(provider.supported[0]?.line).toBeGreaterThan(0);
    expect(provider.unsatisfied).toEqual([]);
    const docs = report.questions.find((item) => item.id === "q-docs-only")!;
    expect(docs.status).not.toBe("satisfied");
    // README.md states SITE_URL, which an "implemented" fact cannot count: it is reported as a lead.
    expect(docs.leads).toContainEqual(expect.objectContaining({ repo: "justinwlin/convex-magic-link-authentication", path: "README.md" }));
    expect(docs.unsatisfied).toEqual(["SITE_URL"]);
    expect(report.candidates[0]).toMatchObject({ repo: "headcodecms/headcodecms", supported: 2 });
    expect(report.budget?.reads[0]).toBeGreaterThan(0);
    expect(report.synthetic).toBe(true);
  });

  it("renders the three artifacts from the report without a claim wall", async () => {
    const run = await executeBrief(brief, { provider: new MockEvidenceProvider(), deterministic: true, validateBrief: (item) => ({ brief: item, issues: [] }), compileProbes: compile });
    const root = await mkdtemp(join(tmpdir(), "brief-report-"));
    try {
      await writeArtifacts(run, root);
      const research = await readFile(join(root, "research.md"), "utf8");
      expect(research).toContain("## Findings by question");
      expect(research).toContain("### q-provider — How is the Resend provider configured?");
      expect(research).toContain("`convex/auth.ts`");
      expect(research).toContain("| Question | Compiled query | Endpoint | Outcome | Results |");
      expect(research).toContain("Leads (not proof)");
      expect(research).not.toContain("## Claim assessments");
      expect(research).toContain("Synthetic/mock evidence");
      expect(research.split("\n").filter((line) => line.startsWith("- `claim_")).length).toBe(0);
      const plan = await readFile(join(root, "plan.md"), "utf8");
      expect(plan).toContain("## What the evidence supports");
      expect(plan).toContain("## Gaps");
      expect(plan).toContain("Is SITE_URL documented in source?");
      const checklist = await readFile(join(root, "implementation-checklist.md"), "utf8");
      expect(checklist).toContain("- [ ] headcodecms/headcodecms `convex/auth.ts:");
      expect(checklist).toContain("## Resolve gaps");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("explains a needs_input run instead of rendering an empty report", async () => {
    const needsInput: ResearchBrief = { ...brief, readiness: { status: "needs_input", reasons: [{ code: "missing_vocabulary", questionIds: ["q-provider"], detail: "Name the provider symbol." }] }, lookupNeeds: [{ questionId: "q-provider", need: "vocabulary", suggestedSourceKinds: ["documentation_page"], remainingAllowance: 4 }] };
    const run = await executeBrief(needsInput, { provider: new MockEvidenceProvider(), deterministic: true, validateBrief: (item) => ({ brief: item, issues: [] }), compileProbes: compile });
    const report = deriveBriefReport(run as never, [], { status: run.outcome.status, reasons: run.outcome.reasons });
    const markdown = renderBriefResearchMd(report);
    expect(markdown).toContain("## Needs input");
    expect(markdown).toContain("missing_vocabulary (q-provider): Name the provider symbol.");
    expect(markdown).toContain("needs input before it can search");
  });
});
