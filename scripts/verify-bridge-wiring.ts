/**
 * End-to-end verification that the live bridge wires into the orchestrator's
 * production loader AND drives the real OctocodeEvidenceProvider against an
 * in-memory mock Octocode MCP server.
 *
 * Not a unit test (it exercises the real adapter + real SDK client/server over
 * an in-memory transport). Run after `npm run build`.
 */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  loadOctocodeToolCallerFromEnv,
  resolveOctocodeProvider,
  OCTOCODE_BRIDGE_ENV,
} from "../src/adapters/bridge.js";
import { OctocodeEvidenceProvider } from "../src/adapters/OctocodeEvidenceProvider.js";
import { createOctocodeToolCaller } from "../dist/bridges/octocode-mcp.js";
import { resolve } from "node:path";

const compiledBridge = resolve("dist/bridges/octocode-mcp.js");

async function main(): Promise<void> {
  // ── 1. Production loader loads the compiled bridge from the env var ──
  const env = { [OCTOCODE_BRIDGE_ENV]: compiledBridge } as NodeJS.ProcessEnv;
  const loaded = await loadOctocodeToolCallerFromEnv(env);
  if (typeof loaded !== "function") throw new Error("loader did not return a function");
  console.log("✓ loadOctocodeToolCallerFromEnv loaded the compiled bridge");

  const provider = await resolveOctocodeProvider({ env, requireConfigured: true });
  if (!provider.configured) throw new Error("provider reports unconfigured");
  console.log("✓ resolveOctocodeProvider({ requireConfigured }) -> configured");

  // ── 2. Full adapter chain: bridge -> real OctocodeEvidenceProvider ──
  // Mock Octocode returns one search hit for "convex auth".
  const server = new McpServer({ name: "mock", version: "0" }, { capabilities: { tools: {} } });
  server.tool("ghSearchCode", "search", () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          results: [
            {
              id: "p1",
              data: {
                files: [
                  {
                    owner: "get-convex",
                    repo: "convex-auth",
                    path: "convex/auth.ts",
                    matches: [{ value: "export function magicLink" }],
                  },
                ],
              },
            },
          ],
        }),
      },
    ],
  }));
  server.tool("ghGetFileContent", "file", () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          results: [
            {
              id: "get-convex/convex-auth",
              data: { files: [{ path: "convex/auth.ts", content: "export const proved = true;" }] },
            },
          ],
        }),
      },
    ],
  }));

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);

  const callTool = createOctocodeToolCaller({
    transport: clientT,
    config: { maxRetries: 0, timeoutMs: 5000 },
    env: {},
  });

  const live = new OctocodeEvidenceProvider({ callTool });

  const [search] = await live.searchCode([
    { id: "p1", query: '"convex auth"', rationale: "find auth" } as never,
  ]);
  if (search?.repo !== "get-convex/convex-auth") throw new Error("search normalization broke");
  console.log("✓ searchCode() normalized a real MCP response:", search.repo, search.path);

  const file = await live.getFile({ repo: "get-convex/convex-auth", path: "convex/auth.ts" } as never);
  if (file.content !== "export const proved = true;") throw new Error("file read broke");
  console.log("✓ getFile() returned exact content (proof-grade evidence)");

  await server.close().catch(() => {});
  console.log("\nALL VERIFICATIONS PASSED — live bridge is production-ready.");
}

main().catch((e: unknown) => {
  console.error("VERIFICATION FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
