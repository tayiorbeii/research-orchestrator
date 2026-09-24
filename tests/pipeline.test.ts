import { describe, expect, it } from "vitest";
import { runResearch } from "../src/core/pipeline.js";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";
import { OctocodeEvidenceProvider } from "../src/adapters/OctocodeEvidenceProvider.js";
import { GitHubEvidenceProvider } from "../src/adapters/GitHubEvidenceProvider.js";
import { DeepWikiExplainer } from "../src/adapters/DeepWikiExplainer.js";
import { ResearchError } from "../src/core/errors.js";
import { ResearchRunSchema } from "../src/schemas/index.js";
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
    expect(production?.class).toBe("production");
    expect(production?.nextAction).toBe("extract");
    expect(run.selectedRepos).toContain("headcodecms/headcodecms");

    // Accepted repos must carry exact evidence anchors (>= 3).
    for (const repo of run.selectedRepos) {
      const anchors = evidence.filter((a) => a.repo === repo && a.proofLevel === "proved");
      expect(anchors.length, `proved anchors for ${repo}`).toBeGreaterThanOrEqual(3);
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
    expect(output.summary.accepted).toBeGreaterThanOrEqual(1);
    expect(
      output.summary.accepted + output.summary.rejected + output.summary.needsMoreEvidence,
    ).toBe(2);
  });

  it("creates an MCP server exposing the research.* tools", () => {
    expect(() => createServer()).not.toThrow();
  });
});
