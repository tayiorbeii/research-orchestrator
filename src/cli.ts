#!/usr/bin/env node
import { runResearch } from "./core/pipeline.js";
import { writeArtifacts, deriveRunStatus } from "./core/writeArtifacts.js";
import { MockEvidenceProvider } from "./adapters/MockEvidenceProvider.js";
import { GitHubEvidenceProvider } from "./adapters/GitHubEvidenceProvider.js";
import { resolveOctocodeProvider } from "./adapters/bridge.js";
import type { EvidenceProvider } from "./adapters/EvidenceProvider.js";
import { FileResearchCache } from "./cache/FileResearchCache.js";
import { ResearchError } from "./core/errors.js";
import { runEval } from "./eval/runEval.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load the kit's own `.env` (kit root, next to package.json) so the CLI works
 * when invoked from any cwd — the documented workflow runs it from the
 * caller's project root, where a plain dotenv-from-cwd would never find it.
 *
 * - Values never override variables already set in the process environment.
 * - Relative paths in *_BRIDGE values are resolved against the kit root, since
 *   the shipped .env uses `./dist/...` paths that only make sense there.
 */
function loadKitEnv(): void {
  try {
    const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const envPath = resolve(kitRoot, ".env");
    if (!existsSync(envPath)) return;
    for (const rawLine of readFileSync(envPath, "utf8").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key.endsWith("_BRIDGE") && value && !isAbsolute(value)) {
        value = resolve(kitRoot, value);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // A missing or unreadable .env is not an error; explicit env vars still work.
  }
}

loadKitEnv();

const HELP = `research-orchestrator — grounded implementation research

Usage:
  research-orchestrator find --goal "<goal>" --out <dir> [options]
  research-orchestrator eval [--out <file.json>]
  research-orchestrator mcp
  research-orchestrator --help

find options:
  --goal <string>            Research goal (required)
  --out <dir>                Output directory for artifacts (required)
  --mock                     Use the deterministic mock provider (no network)
  --mode <mode>              mock | octocode | github (default: mock)
  --max-candidates <n>       Cap candidate repos (default: 25)
  --max-repos-to-prove <n>   Cap deep proof reads
  --no-cache                 Skip writing to .research-cache/
  --allow-inconclusive       Exit 0 when the run is inconclusive (default: exit 2)

environment:
  (the kit's own .env is auto-loaded from the kit root; explicit env vars win)
  RESEARCH_OCTOCODE_BRIDGE   Module exporting an OctocodeToolCaller; enables --mode octocode
  RESEARCH_DEEPWIKI_BRIDGE   Module exporting askQuestion(repo, question); enables DeepWiki enrichment
  GITHUB_TOKEN               Low-scope token; enables --mode github

Examples:
  research-orchestrator find \\
    --goal "Next.js + Convex app with email magic links via Resend" \\
    --out .research/next-convex-magic-link \\
    --mock
`;

interface ParsedArgs {
  command: string | undefined;
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    } else if (!command) {
      command = arg;
    }
  }
  return { command, flags };
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n\n${HELP}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flags.has("help") || command === "help" || command === undefined) {
    process.stdout.write(HELP);
    process.exit(command === undefined && !flags.has("help") ? 1 : 0);
  }

  switch (command) {
    case "find":
      await commandFind(flags);
      break;
    case "eval": {
      const outFile = typeof flags.get("out") === "string" ? (flags.get("out") as string) : undefined;
      const report = await runEval({ outFile });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      break;
    }
    case "mcp": {
      const { startServer } = await import("./mcp/server.js");
      await startServer();
      // Keep the process alive for stdio transport.
      await new Promise(() => {});
      break;
    }
    default:
      fail(`unknown command '${command}'`);
  }

  // One-shot commands may own a live stdio MCP child process through a bridge.
  // Flush all previously queued output, then terminate explicitly so the child
  // transport cannot keep `find` or `eval` hanging after successful completion.
  // The persistent `mcp` command never reaches this block.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write("", (error) => (error ? reject(error) : resolve()));
  });
  process.exit(0);
}

async function commandFind(flags: Map<string, string | boolean>): Promise<void> {
  const goal = flags.get("goal");
  const out = flags.get("out");
  if (typeof goal !== "string" || goal.trim() === "") fail("--goal is required");
  if (typeof out !== "string" || out.trim() === "") fail("--out is required");

  const mock = flags.get("mock") === true || flags.get("mode") === "mock" || !flags.has("mode");
  const mode = mock ? "mock" : String(flags.get("mode"));

  let provider: EvidenceProvider;
  try {
    provider = await resolveCliProvider(mode);
  } catch (error) {
    if (error instanceof ResearchError) {
      process.stderr.write(
        `error [${error.code}]: ${error.message}\n` +
          (error.suggestedAction ? `hint: ${error.suggestedAction}\n` : ""),
      );
      process.exit(1);
    }
    throw error;
  }

  const maxCandidates = intFlag(flags, "max-candidates");
  const maxReposToProve = intFlag(flags, "max-repos-to-prove");

  try {
    const { run, evidence, pattern } = await runResearch({
      goal,
      provider,
      maxCandidates,
      maxReposToProve,
      deterministic: mode === "mock",
    });

    const artifacts = await writeArtifacts(run, out, { evidence, pattern });
    run.artifacts = artifacts;

    const status = deriveRunStatus(run, evidence);

    if (flags.get("no-cache") !== true) {
      await new FileResearchCache().saveRun(run);
    }

    process.stdout.write(`Research run ${run.id} (${mode} mode)\n`);
    process.stdout.write(
      `  status: ${status.status}${status.reasons.length ? ` (${status.reasons.join(", ")})` : ""}\n`,
    );
    process.stdout.write(
      `  candidates: ${run.candidates.length}  selected: ${run.selectedRepos.length}  anchors: ${evidence.length}\n`,
    );
    for (const warning of run.warnings) process.stdout.write(`  warning: ${warning}\n`);
    process.stdout.write("Artifacts:\n");
    for (const artifact of artifacts) process.stdout.write(`  ${artifact.path}\n`);
    if (status.status === "inconclusive" && flags.get("allow-inconclusive") !== true) {
      process.exit(2);
    }
  } catch (error) {
    if (error instanceof ResearchError) {
      process.stderr.write(
        `error [${error.code}]: ${error.message}\n` +
          (error.suggestedAction ? `hint: ${error.suggestedAction}\n` : ""),
      );
      process.exit(1);
    }
    throw error;
  }
}

async function resolveCliProvider(mode: string): Promise<EvidenceProvider> {
  switch (mode) {
    case "mock":
      return new MockEvidenceProvider();
    case "octocode":
      // Wired via setOctocodeToolCaller() or RESEARCH_OCTOCODE_BRIDGE; fails
      // fast with a structured provider_not_configured error otherwise.
      return resolveOctocodeProvider({ requireConfigured: true });
    case "github":
      return new GitHubEvidenceProvider();
    default:
      fail(`unknown --mode '${mode}' (expected mock | octocode | github)`);
  }
}

function intFlag(flags: Map<string, string | boolean>, key: string): number | undefined {
  const value = flags.get(key);
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) fail(`--${key} must be a positive integer`);
  return parsed;
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
