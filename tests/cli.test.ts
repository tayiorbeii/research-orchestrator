import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

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
    join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
    join(process.cwd(), "src/cli.ts"),
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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CLI status contract", () => {
  it("exits zero for a complete evidence-backed mock run", async () => {
    const result = await runCli(
      "Build a Next.js + Convex app with email magic links via Resend.",
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("status: complete");
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
});
