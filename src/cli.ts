#!/usr/bin/env node
import { runPipeline } from "./core/pipeline.js";
import { executeBrief, type ExecuteBriefDeps } from "./core/brief/executeBrief.js";
import { draftBriefFromGoal } from "./core/brief/draftBriefFromGoal.js";
import { validateBrief } from "./core/brief/validateBrief.js";
import { reviseBrief } from "./core/brief/reviseBrief.js";
import { addLocalArtifactFingerprints } from "./core/brief/localArtifacts.js";
import { writeArtifacts, deriveRunStatus } from "./core/writeArtifacts.js";
import { MockEvidenceProvider } from "./adapters/MockEvidenceProvider.js";
import { GitHubEvidenceProvider } from "./adapters/GitHubEvidenceProvider.js";
import { resolveOctocodeProvider } from "./adapters/bridge.js";
import type { EvidenceProvider } from "./adapters/EvidenceProvider.js";
import type { EvidenceAnchor, ResearchRunV2 } from "./schemas/index.js";
import type { ExtractedPattern } from "./core/extractPattern.js";
import { FileResearchCache, ResearchCacheReadError } from "./cache/FileResearchCache.js";
import { providerNotConfigured, ResearchError } from "./core/errors.js";
import { runEval } from "./eval/runEval.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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
  research-orchestrator plan --request <request.json> --out <brief.json>
  research-orchestrator plan --brief <draft.json> --submit <submission.json> --out <revised.json>
  research-orchestrator find --brief <brief.json> --out <dir> [options]
  research-orchestrator find --resume <run-id> --brief <brief.json> --out <dir> [options]
  research-orchestrator artifacts --run-id <id> --out <dir>
  research-orchestrator eval [--out <file.json>]
  research-orchestrator mcp
  research-orchestrator --help

find options:
  --goal <string>            Research goal (compatibility adapter)
  --brief <file>             Validated structured research brief
  --resume <run-id>          Continue from a prior run; requires --brief
  --out <dir>                Output directory for artifacts (required)
  --mock                     Use the deterministic mock provider (no network)
  --mode <mode>              mock | octocode | github (default: mock)
  --max-candidates <n>       Cap candidate repos (default: 25)
  --max-repos-to-prove <n>   Cap deep proof reads
  --no-cache                 Skip writing to .research-cache/
  --allow-inconclusive       Exit 0 for any non-complete outcome (default: exit 2)

artifacts options:
  --run-id <id>              Load a cached run and render its artifacts
  --out <dir>                Output directory for artifacts

environment:
  (the kit's own .env is auto-loaded from the kit root; explicit env vars win)
  RESEARCH_OCTOCODE_BRIDGE   Module exporting an OctocodeToolCaller; enables --mode octocode
  RESEARCH_DEEPWIKI_BRIDGE   Module exporting askQuestion(repo, question); enables DeepWiki enrichment
  GITHUB_TOKEN/GH_TOKEN      Or gh auth login; enables live GitHub providers

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
    case "plan":
      await commandPlan(flags);
      break;
    case "find":
      await commandFind(flags);
      break;
    case "artifacts":
      await commandArtifacts(flags);
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

async function commandArtifacts(flags: Map<string, string | boolean>): Promise<void> {
  const runId = flags.get("run-id");
  const outDir = flags.get("out");
  if (typeof runId !== "string" || runId.trim() === "") fail("--run-id is required");
  if (typeof outDir !== "string" || outDir.trim() === "") fail("--out is required");
  try {
    const run = await new FileResearchCache().loadRun(runId);
    const artifacts = await writeArtifacts(run, outDir);
    const status = deriveRunStatus(run, []);
    process.stdout.write(`Research run ${run.id}\n  status: ${status.status}${status.reasons.length ? ` (${status.reasons.join(", ")})` : ""}\n`);
    for (const artifact of artifacts) process.stdout.write(`${artifact.path}\n`);
  } catch (error) {
    if (error instanceof ResearchCacheReadError) {
      process.stderr.write(`error [${error.code}]: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function commandFind(flags: Map<string, string | boolean>): Promise<void> {
  const goal = flags.get("goal");
  const briefPath = flags.get("brief");
  const resumeId = flags.get("resume");
  const out = flags.get("out");
  if ((typeof goal !== "string" || goal.trim() === "") && typeof briefPath !== "string") fail("--goal or --brief is required");
  if (typeof briefPath === "string" && (typeof goal === "string" || (typeof resumeId !== "string" && flags.has("resume")))) fail("Use --brief alone, or pair --resume with --brief");
  if (typeof resumeId === "string" && typeof briefPath !== "string") fail("--resume requires --brief");
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
    let run: ResearchRunV2;
    let evidence: EvidenceAnchor[];
    let pattern: ExtractedPattern | undefined;
    if (typeof briefPath === "string") {
      let raw: unknown;
      try { raw = JSON.parse(await readFile(briefPath, "utf8")); } catch (error) {
        process.stderr.write(`error [invalid_brief]: Could not read brief JSON: ${(error as Error).message}\n`);
        process.exit(1);
      }
      const validated = validateBrief(raw);
      if (validated.issues.length) {
        process.stderr.write(`error [invalid_brief]: ${validated.issues.map((issue) => issue.code).join(", ")}\n`);
        process.exit(1);
      }
      let resumeLedger;
      let parentRunId: string | undefined;
      let resumeRun: ResearchRunV2 | undefined;
      if (typeof resumeId === "string") {
        const parent = await new FileResearchCache().loadRun(resumeId);
        if (parent.schemaVersion !== 2 || !parent.brief || !parent.compiledProbes || !parent.probeOutcomes || !parent.providerName || parent.evidencePolicyVersion !== "phase2_claim_evidence_v2") {
          process.stderr.write("error [invalid_resume]: Resume requires a compatible Phase 5 v2 brief run.\n");
          process.exit(1);
        }
        parentRunId = parent.id;
        resumeLedger = parent.budgetLedger;
        resumeRun = parent as ResearchRunV2;
        if (!resumeLedger) {
          process.stderr.write("error [invalid_resume]: Parent run has no budget ledger.\n");
          process.exit(1);
        }
      }
      run = await runBriefInput(validated.brief, { provider, deterministic: mode === "mock", maxCandidates, maxReposToProve, resumeLedger, resumeRun, parentRunId });
      evidence = run.candidates.flatMap((candidate) => candidate.candidateSignals.flatMap((signal) => signal.evidence ?? []));
      pattern = undefined;
    } else {
      const legacy = await runPipeline({ goal: String(goal), provider, maxCandidates, maxReposToProve, deterministic: mode === "mock" });
      run = legacy;
      evidence = [];
      pattern = undefined;
    }

    const artifacts = await writeArtifacts(run, out, { evidence, pattern });
    run.artifacts = artifacts;

    const status = run.outcome ? { status: run.outcome.status, reasons: run.outcome.reasons } : deriveRunStatus(run, evidence);

    if (flags.get("no-cache") !== true) {
      await new FileResearchCache().saveRun(run);
    }

    process.stdout.write(`Research run ${run.id} (${mode} mode${run.evidenceOrigin === "synthetic_mock" ? ", SYNTHETIC MOCK FIXTURE" : ""})\n`);
    process.stdout.write(
      `  status: ${status.status}${status.reasons.length ? ` (${status.reasons.join(", ")})` : ""}\n`,
    );
    process.stdout.write(
      `  candidates: ${run.candidates.length}  selected: ${run.selectedRepos.length}  anchors: ${evidence.length}\n`,
    );
    for (const warning of run.warnings) process.stdout.write(`  warning: ${warning}\n`);
    process.stdout.write("Artifacts:\n");
    for (const artifact of artifacts) process.stdout.write(`  ${artifact.path}\n`);
    if (status.status !== "complete" && flags.get("allow-inconclusive") !== true) {
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

async function commandPlan(flags: Map<string, string | boolean>): Promise<void> {
  const requestPath = flags.get("request");
  const briefPath = flags.get("brief");
  const submitPath = flags.get("submit");
  const outPath = flags.get("out");
  if (!(typeof requestPath === "string" && requestPath.trim()) && !(typeof briefPath === "string" && typeof submitPath === "string")) fail("--request or --brief with --submit is required");
  if ((typeof briefPath === "string") !== (typeof submitPath === "string")) fail("--brief and --submit must be provided together");
  if (typeof outPath !== "string" || outPath.trim() === "") fail("--out is required");
  let validation: ReturnType<typeof planRequest>;
  if (typeof briefPath === "string" && typeof submitPath === "string") {
    try {
      const [rawBrief, submission] = await Promise.all([readFile(briefPath, "utf8"), readFile(submitPath, "utf8")]);
      validation = reviseBrief(JSON.parse(rawBrief), JSON.parse(submission));
    } catch (error) {
      process.stderr.write(`error [invalid_submission]: Could not read brief or submission JSON: ${(error as Error).message}\n`);
      process.exit(1);
    }
  } else {
    let request: Record<string, unknown>;
    try { request = JSON.parse(await readFile(String(requestPath), "utf8")) as Record<string, unknown>; } catch (error) {
      process.stderr.write(`error [invalid_request]: Could not read request JSON: ${(error as Error).message}\n`);
      process.exit(1);
    }
    if (typeof request.goal !== "string" || !request.goal.trim()) fail("request.goal must be a non-empty string");
    try { request = await addLocalArtifactFingerprints(request); } catch (error) {
      process.stderr.write(`error [local_artifact_unavailable]: ${(error as Error).message}\n`);
      process.exit(1);
    }
    validation = planRequest(request);
  }
  if (validation.issues.length) {
    process.stderr.write(`error [invalid_brief]: ${validation.issues.map((issue) => issue.code).join(", ")}\n`);
    process.exit(1);
  }
  const brief = validation.brief;
  const result = {
    brief,
    readiness: brief.readiness,
    requestedVocabularyWork: brief.lookupNeeds ?? [],
    researchPerformed: false,
  };
  await writeFile(outPath, `${JSON.stringify(brief, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function planRequest(request: Record<string, unknown>, deps: { draftBriefFromGoal?: typeof draftBriefFromGoal; validateBrief?: typeof validateBrief } = {}) {
  if (typeof request.goal !== "string" || !request.goal.trim()) fail("request.goal must be a non-empty string");
  const hints = { ...request } as Partial<import("./schemas/researchBrief.js").ResearchBrief>;
  delete (hints as Record<string, unknown>).goal;
  return (deps.validateBrief ?? validateBrief)((deps.draftBriefFromGoal ?? draftBriefFromGoal)(request.goal, hints));
}

export function runBriefInput(brief: import("./schemas/researchBrief.js").ResearchBrief, deps: ExecuteBriefDeps) {
  return executeBrief(brief, deps);
}

async function resolveCliProvider(mode: string): Promise<EvidenceProvider> {
  switch (mode) {
    case "mock":
      return new MockEvidenceProvider();
    case "octocode":
      // Wired via setOctocodeToolCaller() or RESEARCH_OCTOCODE_BRIDGE; fails
      // fast with a structured provider_not_configured error otherwise.
      return resolveOctocodeProvider({ requireConfigured: true });
    case "github": {
      const provider = new GitHubEvidenceProvider();
      if (!provider.configured) {
        throw providerNotConfigured(
          "GitHub",
          "Run `gh auth login` or set GITHUB_TOKEN/GH_TOKEN, then retry.",
        );
      }
      return provider;
    }
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

// Compare real paths: the global bin (npm link) invokes this file through a
// symlink, and a lexical comparison silently skipped main() for that entry.
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    process.stderr.write(`fatal: ${(error as Error).stack ?? String(error)}\n`);
    process.exit(1);
  });
}
