#!/usr/bin/env tsx
/**
 * Live smoke test for the Octocode bridge.
 *
 * Loads the bridge exactly the way the orchestrator does — by pointing
 * `RESEARCH_OCTOCODE_BRIDGE` at the compiled module — then makes a single
 * `ghSearchCode` call against the configured server and prints whether the
 * current Octocode bulk response normalizes into the provider shape.
 *
 * Usage:
 *   # 1. Build the bridge first (emits dist/bridges/octocode-mcp.js)
 *   npm run build:bridges
 *
 *   # 2a. stdio transport (spawn the Octocode MCP server as a subprocess)
 *   RESEARCH_OCTOCODE_COMMAND=npx \
 *   RESEARCH_OCTOCODE_ARGS='["-y","@octocodeai/mcp@latest"]' \
 *   npx tsx scripts/smoke-octocode-bridge.ts
 *
 *   # 2b. SSE/HTTP transport (server already running)
 *   RESEARCH_OCTOCODE_TRANSPORT=sse \
 *   RESEARCH_OCTOCODE_URL=http://localhost:3001/sse \
 *   RESEARCH_OCTOCODE_API_KEY=$OCTOCODE_KEY \
 *   npx tsx scripts/smoke-octocode-bridge.ts
 *
 * Exit codes: 0 = success, 1 = call failed or server unreachable.
 * No assertions on network content — this only checks the plumbing.
 */
import { OCTOCODE_BRIDGE_ENV, loadOctocodeToolCallerFromEnv } from "../src/adapters/bridge.js";
import { normalizeSearchResponse } from "../src/adapters/OctocodeEvidenceProvider.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load the kit's own `.env` exactly like the CLI does, so the smoke test works
 * from a bare shell without `set -a; source .env`. Explicit env vars win.
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
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key.endsWith("_BRIDGE") && value && !isAbsolute(value)) value = resolve(kitRoot, value);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // Missing or unreadable .env is not an error; explicit env vars still work.
  }
}

loadKitEnv();

const bridgePath = process.env[OCTOCODE_BRIDGE_ENV] ?? new URL("../dist/bridges/octocode-mcp.js", import.meta.url).pathname;

process.env[OCTOCODE_BRIDGE_ENV] = bridgePath;

async function main(): Promise<void> {
  const caller = await loadOctocodeToolCallerFromEnv();
  if (!caller) {
    console.error(`Set ${OCTOCODE_BRIDGE_ENV} or rely on the default dist path.`);
    process.exit(1);
  }

  console.error(`[smoke] bridge loaded from ${bridgePath}`);
  console.error("[smoke] calling ghSearchCode ...");

  const raw = (await caller("ghSearchCode", {
    queries: [
      {
        id: "smoke",
        mainResearchGoal: "Verify the live Research Orchestrator bridge.",
        researchGoal: "Find any public Convex authentication implementation.",
        keywords: ["convex", "auth"],
        reasoning: "A real search proves stdio transport, authentication, and response unwrapping.",
        limit: 5,
        page: 1,
        concise: false,
      },
    ],
  })) as { results?: unknown[] };

  const normalized = normalizeSearchResponse(raw as never, [
    { id: "smoke", query: '"convex auth"', rationale: "smoke" } as never,
  ]);

  console.error(`[smoke] raw.resultCount=${raw.results?.length ?? 0}`);
  console.error(`[smoke] normalized.length=${normalized.length}`);
  console.error("[smoke] OK — bridge unwrapped a response in the expected shape.");
  // The one-shot stdio bridge owns a live child process; terminate it after
  // verification so this script does not hang waiting for the MCP transport.
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[smoke] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
