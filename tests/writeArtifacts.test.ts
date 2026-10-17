import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAnchors, runPipeline } from "../src/core/pipeline.js";
import { writeArtifacts } from "../src/core/writeArtifacts.js";
import { redactSecrets } from "../src/core/redact.js";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";
import type { ResearchRunV2 } from "../src/schemas/index.js";

const GOAL = "Build a Next.js + Convex app with email magic links via Resend.";

describe("writeArtifacts", () => {
  let outDir: string;
  let run: ResearchRunV2;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "ro-artifacts-"));
    run = await runPipeline({
      goal: GOAL,
      provider: new MockEvidenceProvider(),
      deterministic: true,
    });
    await writeArtifacts(run, outDir, { evidence: runAnchors(run) });
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

  it("keeps mock origin visible in all four artifact formats", async () => {
    for (const file of ["research.md", "plan.md", "implementation-checklist.md"]) {
      expect(await readFile(join(outDir, file), "utf8")).toContain("Synthetic/mock evidence");
    }
    const evidence = JSON.parse(await readFile(join(outDir, "evidence.json"), "utf8")) as {
      evidenceOrigin: string;
      evidencePolicyVersion: string;
    };
    expect(evidence.evidenceOrigin).toBe("synthetic_mock");
    expect(evidence.evidencePolicyVersion).toBe("phase2_claim_evidence_v2");
  });

  it("research.md contains the required sections and evidence", async () => {
    const research = await readFile(join(outDir, "research.md"), "utf8");
    expect(research).toContain("Synthetic/mock evidence");
    expect(research).toContain("## Findings by question");
    expect(research).toContain("## What was searched");
    expect(research).toContain("## Budget receipt");
    expect(research).toContain("`convex/auth.ts`");
    expect(research).not.toContain("**Server flow**");
    expect(research).not.toContain("implementation file");
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

  it("plan.md includes what the evidence supports, gaps, and references", async () => {
    const plan = await readFile(join(outDir, "plan.md"), "utf8");
    expect(plan).toContain("## What the evidence supports");
    expect(plan).toContain("## Gaps");
    expect(plan).toContain("## Verification steps");
    expect(plan).not.toContain("AUTH_RESEND_KEY");
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
    const again = await runPipeline({
      goal: GOAL,
      provider: new MockEvidenceProvider(),
      deterministic: true,
    });
    expect(again.id).toBe(run.id);
    expect(again.createdAt).toBe(run.createdAt);
    expect(again.assessments).toEqual(run.assessments);
    expect(again.coverage).toEqual(run.coverage);
    expect(runAnchors(again)).toEqual(runAnchors(run));
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
