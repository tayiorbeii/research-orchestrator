import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { planRequest } from "../src/cli.js";
import type { ResearchBrief } from "../src/schemas/researchBrief.js";

// CLI tests run the built entry point, as the installed binary does. Spawning `tsx src/cli.ts`
// transpiled the whole import graph per call and, under parallel vitest workers, took ~5s
// per spawn and timed out intermittently. Build once here instead.
const CLI_ENTRY = join(process.cwd(), "dist/cli.js");

beforeAll(async () => {
  await promisify(execFile)(process.execPath, [join(process.cwd(), "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: process.cwd() });
}, 120_000);

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const tempDirs: string[] = [];

async function runCli(goal: string, extraArgs: string[] = []): Promise<CliResult> {
  const out = await mkdtemp(join(tmpdir(), "research-orchestrator-cli-"));
  tempDirs.push(out);
  const args = [
    CLI_ENTRY,
    "find",
    "--goal",
    goal,
    "--out",
    out,
    "--mock",
    "--no-cache",
    ...extraArgs,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runArtifactsCli(runId: string, cwd: string): Promise<CliResult> {
  const out = join(cwd, "out");
  const args = [
    CLI_ENTRY,
    "artifacts", "--run-id", runId, "--out", out,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runPlanCli(args: string[], cwd: string): Promise<CliResult> {
  const commandArgs = [CLI_ENTRY, "plan", ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, commandArgs, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CLI status contract", () => {
  it("exits two when registered assessors have not established all required claims", async () => {
    const result = await runCli(
      "Build a Next.js + Convex app with email magic links via Resend.",
    );
    expect(result.code, result.stderr).toBe(2);
    // The brief-based legacy goal adapter has no assessed anchors in this mock result.
    expect(result.stdout).toContain("status: inconclusive");
  });

  it("exits two for an inconclusive run", async () => {
    const result = await runCli(
      "Migrate Flowdeck to WezTerm while preserving keyboard navigation",
    );
    expect(result.code, result.stderr).toBe(2);
    expect(result.stdout).toContain("status: inconclusive");
  });

  it("supports explicitly allowing inconclusive runs", async () => {
    const result = await runCli(
      "Migrate Flowdeck to WezTerm while preserving keyboard navigation",
      ["--allow-inconclusive"],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("status: inconclusive");
  });

  it("surfaces typed cache read errors through the CLI", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "research-orchestrator-cli-cache-"));
    tempDirs.push(cwd);
    await mkdir(join(cwd, ".research-cache", "runs"), { recursive: true });
    await writeFile(join(cwd, ".research-cache", "runs", "broken-run.json"), "{broken", "utf8");
    const corrupt = await runArtifactsCli("broken-run", cwd);
    expect(corrupt.code).toBe(1);
    expect(corrupt.stderr).toContain("error [corrupt_json]");

  });
});

const brief: ResearchBrief = {
  id: "cli-brief", revision: 1, goal: "Find an example declaring package-x",
  questions: [{ id: "q1", statement: "Is package-x declared?", intentHints: ["library_usage"], required: true, answerScope: "one example", obligations: [{ facts: [{ kind: "dependency", packageName: "package-x" }], combine: "all", scope: "same_repository" }] }],
  mechanisms: [], vocabulary: [], seeds: [], allowedSourceKinds: ["repository_file"],
  budgets: { maxQuestions: 6, queryUnits: 16, reconnaissanceReads: 4, fileReads: 48, fileReadsPerRepo: 12, refinementRounds: 1, refinementProbes: 4, deadlineMs: 60_000 },
  readiness: { status: "needs_input", reasons: [{ code: "missing_vocabulary", questionIds: ["q1"], detail: "Name the package." }] }, lookupOutcomes: [],
};

describe("CLI entry point", () => {
  // Regression: the global bin (npm link) runs dist/cli.js through a symlink; a lexical
  // argv[1] comparison skipped main(), so `research-orchestrator --help` printed nothing.
  it("runs when invoked through a symlink, as the installed global binary is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "research-orchestrator-bin-"));
    tempDirs.push(dir);
    const link = join(dir, "research-orchestrator");
    await symlink(CLI_ENTRY, link);
    const result = await new Promise<CliResult>((resolve, reject) => {
      const child = spawn(process.execPath, [link, "--help"], { cwd: dir });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect(`${result.stdout}${result.stderr}`).toContain("research-orchestrator find");
  });
});

describe("CLI brief planning", () => {
  it("plans a request without suggesting that research has already happened", () => {
    const result = planRequest({ goal: brief.goal, questions: brief.questions }, {
      draftBriefFromGoal: () => brief,
      validateBrief: (input) => ({ brief: input, issues: [] }),
    });
    expect(result.brief).toEqual(brief);
    expect(result.brief.readiness.status).toBe("needs_input");
  });

  it("runs the host round trip from needs_input to a mock find", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "research-orchestrator-roundtrip-"));
    tempDirs.push(cwd);
    const request = join(cwd, "request.json");
    const draftPath = join(cwd, "draft.json");
    const submissionPath = join(cwd, "submission.json");
    const revisedPath = join(cwd, "revised.json");
    await writeFile(request, JSON.stringify({ goal: "Prevent lint debt from increasing" }), "utf8");
    const draft = await runPlanCli(["--request", request, "--out", draftPath], cwd);
    expect(draft.code, draft.stderr).toBe(0);
    expect(draft.stdout).toContain('"status": "needs_input"');
    const draftBrief = JSON.parse(await readFile(draftPath, "utf8")) as ResearchBrief;
    await writeFile(submissionPath, JSON.stringify({
      terms: [{ id: "ruff-baseline", text: "ruff --baseline", questionIds: ["q1"], mechanismId: "baseline", kind: "cli_token", origin: "remote_source_derived", sourceRefs: ["docs:ruff"], status: "observed" }],
      lookupOutcomes: [{ questionId: "q1", sourceRef: "docs:ruff", status: "succeeded", termIdsGained: ["ruff-baseline"] }],
    }), "utf8");
    const revised = await runPlanCli(["--brief", draftPath, "--submit", submissionPath, "--out", revisedPath], cwd);
    expect(revised.code, revised.stderr).toBe(0);
    expect(revised.stdout).toContain('"status": "ready"');
    const ready = JSON.parse(await readFile(revisedPath, "utf8")) as ResearchBrief;
    expect(ready.lineage?.parentId).toBe(draftBrief.id);
    const run = await runCliFromBrief(revisedPath, join(cwd, "run"), cwd);
    expect([0, 2]).toContain(run.code);
    expect(run.stdout).toMatch(/Research run .*mock mode/);
  });
});

async function runCliFromBrief(brief: string, out: string, cwd: string): Promise<CliResult> {
  const args = [CLI_ENTRY, "find", "--brief", brief, "--out", out, "--mock", "--no-cache", "--allow-inconclusive"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
