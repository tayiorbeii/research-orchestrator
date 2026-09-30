import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runResearch } from "../src/core/pipeline.js";
import { writeArtifacts } from "../src/core/writeArtifacts.js";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";

/**
 * Golden-snapshot regression fixtures (docs/10_eval_benchmarks.md,
 * "Regression tests"): the deterministic mock run must regenerate artifacts
 * byte-identical to tests/fixtures/next-convex-magic-link/. Phase 2 records
 * observations, scoped claim assessments, coverage, and run outcome alongside
 * the compatibility anchor projection.
 *
 * To intentionally update the snapshots after reviewing the diff:
 *   npx tsx scripts/generate-golden-fixtures.ts
 */
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/next-convex-magic-link/", import.meta.url));
const GOAL = "Next.js + Convex app with email magic links via Resend";
const FILES: ReadonlyArray<readonly [string, string]> = [
  ["research.md", "expected-research.md"],
  ["plan.md", "expected-plan.md"],
  ["evidence.json", "expected-evidence.json"],
  ["implementation-checklist.md", "expected-implementation-checklist.md"],
];

describe("golden mock artifacts (docs/10 regression tests)", () => {
  it("regenerates artifacts byte-identical to the golden snapshots", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "ro-golden-"));
    const { run, evidence, pattern } = await runResearch({
      goal: GOAL,
      provider: new MockEvidenceProvider(),
      deterministic: true,
    });
    await writeArtifacts(run, outDir, { evidence, pattern });

    for (const [actualName, expectedName] of FILES) {
      const actual = await readFile(join(outDir, actualName), "utf8");
      const expected = await readFile(join(FIXTURE_DIR, expectedName), "utf8");
      expect(actual, `${actualName} must be byte-identical to ${expectedName}`).toBe(expected);
    }
  });

  it("golden evidence.json pins the deterministic run and stable evidence counts", async () => {
    const raw = await readFile(join(FIXTURE_DIR, "expected-evidence.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      runId: string;
      createdAt: string;
      selectedRepos: string[];
      evidencePolicyVersion: string;
      evidenceOrigin: string;
      schemaVersion: number;
      observations: Array<{ readStatus: string; revisionStatus: string }>;
      assessments: Array<{ status: string; assessorOrigin: string; evidenceOrigin?: string; subject: { repo: string }; assertion: string }>;
      coverage: unknown[];
      outcome: { status: string; reasons: string[] };
      evidence: Array<{ proofLevel: string; supportMethod?: string }>;
    };
    expect(parsed.runId).toBe("run_mock_next_convex_magic_link_auth");
    expect(parsed.createdAt).toBe("2026-06-30T00:00:00.000Z");
    expect(parsed.selectedRepos).toEqual(["headcodecms/headcodecms"]);
    expect(parsed.evidence).toHaveLength(17);
    expect(parsed.evidence.filter((a) => a.proofLevel === "proved")).toHaveLength(0);
    expect(parsed.evidence.filter((a) => a.supportMethod === "exact_source_quotation")).toHaveLength(17);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.evidencePolicyVersion).toBe("phase2_claim_evidence_v2");
    expect(parsed.observations.length).toBeGreaterThan(0);
    expect(parsed.assessments.some((item) => item.status === "supported" && item.assessorOrigin === "engine" && item.evidenceOrigin === "synthetic" && item.subject.repo === "headcodecms/headcodecms" && item.assertion.startsWith("package "))).toBe(true);
    expect(parsed.coverage.length).toBeGreaterThan(0);
    expect(parsed.outcome.status).toBe("partial");
    expect(parsed.outcome.reasons).toContain("synthetic_evidence");
    expect(parsed.evidenceOrigin).toBe("synthetic_mock");
    // Redaction is enforced on every artifact write: the mock fixture's fake
    // Resend key must never appear in a snapshot.
    expect(raw).not.toContain("re_FAKEFAKEFAKEFAKEFAKE1234");
  });
});
