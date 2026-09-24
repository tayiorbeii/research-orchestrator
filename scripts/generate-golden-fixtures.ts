/**
 * Regenerate the golden-snapshot fixtures for the deterministic mock run
 * (docs/10_eval_benchmarks.md, "Regression tests").
 *
 *   npx tsx scripts/generate-golden-fixtures.ts
 *
 * Only run this after intentionally changing scoring/rendering behavior, and
 * review the fixture diff before committing.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runResearch } from "../src/core/pipeline.js";
import { writeArtifacts } from "../src/core/writeArtifacts.js";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";

export const GOLDEN_GOAL = "Next.js + Convex app with email magic links via Resend";
export const GOLDEN_FILES: ReadonlyArray<readonly [string, string]> = [
  ["research.md", "expected-research.md"],
  ["plan.md", "expected-plan.md"],
  ["evidence.json", "expected-evidence.json"],
  ["implementation-checklist.md", "expected-implementation-checklist.md"],
];

const fixtureDir = fileURLToPath(
  new URL("../tests/fixtures/next-convex-magic-link/", import.meta.url),
);

const outDir = await mkdtemp(join(tmpdir(), "ro-golden-gen-"));
const { run, evidence, pattern } = await runResearch({
  goal: GOLDEN_GOAL,
  provider: new MockEvidenceProvider(),
  deterministic: true,
});
await writeArtifacts(run, outDir, { evidence, pattern });

await mkdir(fixtureDir, { recursive: true });
for (const [src, dest] of GOLDEN_FILES) {
  const content = await readFile(join(outDir, src), "utf8");
  await writeFile(join(fixtureDir, dest), content, "utf8");
  console.log(`${dest}: ${content.length} bytes`);
}
console.log(`run id: ${run.id}, anchors: ${evidence.length}`);
