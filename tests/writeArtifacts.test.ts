import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runResearch, type RunResearchResult } from "../src/core/pipeline.js";
import { writeArtifacts } from "../src/core/writeArtifacts.js";
import { redactSecrets } from "../src/core/redact.js";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";

const GOAL = "Build a Next.js + Convex app with email magic links via Resend.";

describe("writeArtifacts", () => {
  let outDir: string;
  let result: RunResearchResult;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "ro-artifacts-"));
    result = await runResearch({
      goal: GOAL,
      provider: new MockEvidenceProvider(),
      deterministic: true,
    });
    await writeArtifacts(result.run, outDir, {
      evidence: result.evidence,
      pattern: result.pattern,
    });
  });

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("writes all four expected artifacts", async () => {
    const files = await readdir(outDir);
    expect(files.sort()).toEqual([
      "evidence.json",
      "implementation-checklist.md",
      "plan.md",
      "research.md",
    ]);
  });

  it("research.md contains the required sections and evidence", async () => {
    const research = await readFile(join(outDir, "research.md"), "utf8");
    for (const section of [
      "## Goal",
      "## Selected repositories",
      "## Candidate analysis",
      "## Implementation pattern",
      "## Evidence map",
      "## Open questions",
      "## Skeptic notes",
    ]) {
      expect(research).toContain(section);
    }
    expect(research).toContain("headcodecms/headcodecms");
  });

  it("evidence.json is valid JSON and every selected repo has >= 3 anchors", async () => {
    const evidence = JSON.parse(await readFile(join(outDir, "evidence.json"), "utf8")) as {
      selectedRepos: string[];
      evidence: Array<{ repo?: string; path: string; proofLevel: string }>;
    };
    expect(evidence.selectedRepos.length).toBeGreaterThan(0);
    for (const repo of evidence.selectedRepos) {
      const anchors = evidence.evidence.filter((a) => a.repo === repo);
      expect(anchors.length, `anchors for ${repo}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("plan.md includes steps, env var names, and references", async () => {
    const plan = await readFile(join(outDir, "plan.md"), "utf8");
    expect(plan).toContain("## Step-by-step implementation");
    expect(plan).toContain("AUTH_RESEND_KEY");
    expect(plan).toContain("## References");
    expect(plan).toContain("github.com/headcodecms/headcodecms");
  });

  it("redacts secret values but keeps env var names", async () => {
    const files = await readdir(outDir);
    for (const file of files) {
      const content = await readFile(join(outDir, file), "utf8");
      // The mock README contains a fake Resend key value; it must never leak.
      expect(content).not.toContain("re_FAKEFAKEFAKEFAKEFAKE1234");
    }
  });

  it("is deterministic for mock runs", async () => {
    const again = await runResearch({
      goal: GOAL,
      provider: new MockEvidenceProvider(),
      deterministic: true,
    });
    expect(again.run.id).toBe(result.run.id);
    expect(again.run.createdAt).toBe(result.run.createdAt);
    expect(again.run.scoredCandidates).toEqual(result.run.scoredCandidates);
    expect(again.evidence).toEqual(result.evidence);
  });
});

describe("redactSecrets", () => {
  it("redacts env-style secret assignments but keeps the name", () => {
    const out = redactSecrets("AUTH_RESEND_KEY=re_abc123def456ghi789\nSITE_URL=http://localhost");
    expect(out).toContain("AUTH_RESEND_KEY=[REDACTED]");
    expect(out).toContain("SITE_URL=http://localhost");
  });

  it("redacts JSON secret values", () => {
    const out = redactSecrets('{"GITHUB_TOKEN": "ghp_abcdefghijklmnopqrstuv123456"}');
    expect(out).toContain('"GITHUB_TOKEN": "[REDACTED]"');
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuv123456");
  });

  it("redacts bare token shapes", () => {
    const out = redactSecrets("token ghp_abcdefghijklmnopqrstuv123456 and key sk_live_abcdef123456");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuv123456");
    expect(out).not.toContain("sk_live_abcdef123456");
  });
});
