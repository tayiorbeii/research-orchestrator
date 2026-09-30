import { describe, expect, it } from "vitest";
import { runResearch } from "../src/core/pipeline.js";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";
import { OctocodeEvidenceProvider } from "../src/adapters/OctocodeEvidenceProvider.js";
import { GitHubEvidenceProvider } from "../src/adapters/GitHubEvidenceProvider.js";
import { DeepWikiExplainer } from "../src/adapters/DeepWikiExplainer.js";
import { ResearchError } from "../src/core/errors.js";
import { ResearchRunSchema } from "../src/schemas/index.js";
import { ResearchRunV2Schema } from "../src/schemas/index.js";
import { DEFAULT_BRIEF_BUDGETS } from "../src/schemas/researchBrief.js";
import { scoreRepos } from "../src/mcp/tools/scoreRepos.js";
import { findImplementations } from "../src/mcp/tools/findImplementations.js";
import { createServer } from "../src/mcp/server.js";

const GOAL = "Build a Next.js + Convex app with email magic links via Resend.";

describe("runResearch (mock vertical slice)", () => {
  it("runs goal -> spec -> probes -> candidates -> scores -> selection", async () => {
    const { run, evidence } = await runResearch({
      goal: GOAL,
      provider: new MockEvidenceProvider(),
      deterministic: true,
    });

    expect(() => ResearchRunSchema.parse(run)).not.toThrow();
    expect(run.featureSpec.featureKey).toBe("next-convex-magic-link-auth");
    expect(run.probes.length).toBeGreaterThanOrEqual(4);
    expect(run.candidates.length).toBe(2);

    const production = run.scoredCandidates.find((s) => s.repo === "headcodecms/headcodecms");
    // Exact quotes cannot establish working application behavior or production readiness.
    expect(production?.class).toBe("reference");
    expect(production?.nextAction).not.toBe("extract");
    expect(run.selectedRepos).toContain("headcodecms/headcodecms");

    // Accepted repos must carry exact evidence anchors (>= 3).
    for (const repo of run.selectedRepos) {
      const anchors = evidence.filter((a) => a.repo === repo && a.supportMethod === "exact_source_quotation");
      expect(anchors.length, `quoted source observations for ${repo}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("documents missing proof instead of guessing", async () => {
    const { run } = await runResearch({
      goal: GOAL,
      provider: new MockEvidenceProvider(),
      deterministic: true,
      maxReposToProve: 1,
    });
    expect(run.warnings.some((w) => w.includes("missingProof"))).toBe(true);
    const unproved = run.scoredCandidates.find(
      (s) => s.repo === "justinwlin/convex-magic-link-authentication",
    );
    expect(unproved).toBeDefined();
    expect(unproved!.class).not.toBe("production");
  });

  it("supports a server-auth quotation only from one same-path observation and labels mock support synthetic", async () => {
    const { run } = await runResearch({ goal: GOAL, provider: new MockEvidenceProvider(), deterministic: true });
    const claim = run.assessments.find((item) => item.questionId === "question_server_auth_proof" && item.subject.repo === "headcodecms/headcodecms");
    expect(claim).toMatchObject({ status: "supported", evidenceOrigin: "synthetic", method: "exact_source_quotation" });
    expect(claim?.assertion).toBe('source convex/auth.ts states: "convexAuth", "Resend"');
    expect(claim?.requiredObservationIds).toHaveLength(1);
  });

  it("requires outcomes and the budget ledger when a v2 run carries a brief", async () => {
    const { run } = await runResearch({ goal: GOAL, provider: new MockEvidenceProvider(), deterministic: true });
    const brief = {
      id: "brief-1", revision: 1, goal: GOAL,
      questions: [{ id: "q1", statement: "Find an example", intentHints: ["implementation_behavior"], required: true,
        answerScope: "One example", obligations: [{ facts: [{ kind: "quotation", signals: ["convexAuth"] }], combine: "all", scope: "same_repository" }] }],
      mechanisms: [], vocabulary: [], seeds: [], allowedSourceKinds: ["repository_file"], budgets: DEFAULT_BRIEF_BUDGETS,
      readiness: { status: "needs_input", reasons: [{ code: "missing_vocabulary", detail: "Specify the package." }] }, lookupOutcomes: [],
    } as const;
    const budgetLedger = {
      limits: { maxQuestions: 6, queryUnits: 16, reconnaissanceReads: 4, fileReads: 48, fileReadsPerRepo: 12, refinementRounds: 1, refinementProbes: 4, deadlineMs: 60000 },
      consumed: { queryUnits: 0, rpcCount: 0, reconnaissanceReads: 0, fileReads: 0, fileReadsByRepo: {}, refinementRounds: 0, refinementProbes: 0 }, cancelled: false,
    };
    expect(ResearchRunV2Schema.safeParse({ ...run, brief, probeOutcomes: [], budgetLedger }).success).toBe(true);
    expect(ResearchRunV2Schema.safeParse({ ...run, brief, probeOutcomes: [] }).success).toBe(false);
  });

  it("declares adapter search capabilities from the queries each adapter sends", () => {
    const mock = new MockEvidenceProvider().searchCapabilities();
    const github = new GitHubEvidenceProvider({ token: "test" }).searchCapabilities();
    const octocode = new OctocodeEvidenceProvider().searchCapabilities();
    expect(mock).toMatchObject({ codeSearch: true, repoSearch: true, supportedQualifiers: { codeSearch: [], repoSearch: [] }, batch: { codeSearch: true, repoSearch: false } });
    expect(github).toMatchObject({ codeSearch: true, repoSearch: true, supportedQualifiers: { codeSearch: ["language", "path", "filename", "extension", "repo", "org"], repoSearch: ["language", "org"] }, batch: { codeSearch: false, repoSearch: false } });
    expect(octocode).toMatchObject({ codeSearch: true, repoSearch: true, supportedQualifiers: { codeSearch: [], repoSearch: [] }, batch: { codeSearch: true, repoSearch: false, maxCodeQueriesPerCall: 5 } });
  });
});

describe("provider stubs (milestone 2)", () => {
  it("Octocode provider throws structured not-configured errors", async () => {
    const provider = new OctocodeEvidenceProvider();
    expect(provider.configured).toBe(false);
    await expect(provider.searchCode([])).rejects.toMatchObject({
      name: "ResearchError",
      code: "provider_not_configured",
    });
  });

  it("GitHub provider throws structured not-configured errors without a token", async () => {
    const provider = new GitHubEvidenceProvider({ token: undefined });
    if (!provider.configured) {
      await expect(provider.searchCode([])).rejects.toBeInstanceOf(ResearchError);
    }
  });

  it("DeepWiki explainer reports unavailable instead of guessing", async () => {
    const explainer = new DeepWikiExplainer();
    const capability = await explainer.canExplain({ repo: "owner/repo" });
    expect(capability.available).toBe(false);
    expect(capability.reason).toBeTruthy();
    await expect(
      explainer.explain({
        repo: { repo: "owner/repo" },
        feature: (await runResearch({ goal: GOAL, provider: new MockEvidenceProvider(), deterministic: true })).run
          .featureSpec,
        questions: ["Where is the provider configured?"],
      }),
    ).rejects.toMatchObject({ code: "provider_not_configured" });
  });
});

describe("MCP tools (milestone 3)", () => {
  it("research.findImplementations returns a full structured result in mock mode", async () => {
    const output = await findImplementations({ goal: GOAL, mode: "mock" });
    expect(output.runId).toBe("run_mock_next_convex_magic_link_auth");
    expect(output.featureSpec.featureKey).toBe("next-convex-magic-link-auth");
    expect(output.scoredCandidates.length).toBe(2);
    expect(output.selectedRepos.length).toBeGreaterThan(0);
    expect(output.evidence.length).toBeGreaterThanOrEqual(3);
  });

  it("research.scoreRepos summarizes accepted/rejected/needsMoreEvidence", async () => {
    const found = await findImplementations({ goal: GOAL, mode: "mock" });
    const output = await scoreRepos({
      featureSpec: found.featureSpec,
      candidates: found.candidates,
      evidence: found.evidence,
    });
    expect(output.scoredCandidates.length).toBe(2);
    // Inline MCP evidence is caller supplied and cannot mint current-policy support.
    expect(output.summary.accepted).toBe(0);
    expect(output.summary.accepted + output.summary.rejected + output.summary.needsMoreEvidence).toBe(2);
    expect(
      output.summary.accepted + output.summary.rejected + output.summary.needsMoreEvidence,
    ).toBe(2);
  });

  it("creates an MCP server exposing the research.* tools", () => {
    expect(() => createServer()).not.toThrow();
  });
});
