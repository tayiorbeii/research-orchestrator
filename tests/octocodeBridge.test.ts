/**
 * Tests for the live Octocode bridge module.
 *
 * Two layers:
 *   1. Pure unit tests — config parsing, result unwrapping, retry/backoff
 *      classification, and export shapes. Always run; no I/O.
 *   2. An in-process MCP round-trip — a real SDK Client (the bridge) talks to
 *      a real SDK Server (a mock Octocode) over an InMemoryTransport pair.
 *      This validates transport wiring, callTool, and unwrapping end-to-end
 *      WITHOUT spawning a subprocess or touching the network.
 *
 * A separate `scripts/smoke-octocode-bridge.ts` performs a live call against a
 * real Octocode server when one is configured; that is intentionally not part
 * of the always-green suite.
 */
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createOctocodeToolCaller,
  readBridgeConfig,
  parseArgs,
  unwrapCallToolResult,
  isRetryable,
  isConnectionLost,
  backoffDelay,
  ConfigError,
  ToolError,
} from "../bridges/octocode-mcp.js";

// ──────────────────────────────────────────────────────────────────────────
// 1. Config parsing
// ──────────────────────────────────────────────────────────────────────────

describe("readBridgeConfig", () => {
  it("applies defaults from an empty env", () => {
    const cfg = readBridgeConfig({});
    expect(cfg.transport).toBe("stdio");
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.baseBackoffMs).toBe(500);
    expect(cfg.timeoutMs).toBe(60_000);
    expect(cfg.clientName).toBe("research-orchestrator");
    expect(cfg.args).toEqual([]);
    expect(cfg.debug).toBe(false);
    expect(cfg.apiKey).toBeUndefined();
  });

  it("parses stdio command + JSON-array args", () => {
    const cfg = readBridgeConfig({
      RESEARCH_OCTOCODE_COMMAND: "npx",
      RESEARCH_OCTOCODE_ARGS: '["-y","@octocodeai/mcp@latest"]',
      RESEARCH_OCTOCODE_CWD: "/tmp",
    });
    expect(cfg.command).toBe("npx");
    expect(cfg.args).toEqual(["-y", "@octocodeai/mcp@latest"]);
    expect(cfg.cwd).toBe("/tmp");
  });

  it("parses SSE url + api key + transport", () => {
    const cfg = readBridgeConfig({
      RESEARCH_OCTOCODE_TRANSPORT: "sse",
      RESEARCH_OCTOCODE_URL: "http://localhost:3001/sse",
      RESEARCH_OCTOCODE_API_KEY: "secret",
    });
    expect(cfg.transport).toBe("sse");
    expect(cfg.url).toBe("http://localhost:3001/sse");
    expect(cfg.apiKey).toBe("secret");
  });

  it("rejects an unknown transport", () => {
    expect(() =>
      readBridgeConfig({ RESEARCH_OCTOCODE_TRANSPORT: "carrier-pigeon" }),
    ).toThrow(/invalid/);
  });

  it("fails at setup time when stdio command is missing", () => {
    expect(() => createOctocodeToolCaller({ env: { PATH: "" } })).toThrow(
      /RESEARCH_OCTOCODE_COMMAND/,
    );
  });

  it("fails at setup time when neither gh auth nor a token is available", () => {
    expect(() =>
      createOctocodeToolCaller({
        env: { PATH: "", RESEARCH_OCTOCODE_COMMAND: "octocode" },
      }),
    ).toThrow(/gh auth login|GITHUB_TOKEN\/GH_TOKEN/);
  });

  it("accepts a GitHub CLI token for the Octocode stdio subprocess", () => {
    expect(() =>
      createOctocodeToolCaller({
        env: {
          PATH: "",
          GH_TOKEN: "gh-cli-token",
          RESEARCH_OCTOCODE_COMMAND: "octocode",
        },
      }),
    ).not.toThrow();
  });

  it("rejects a malformed URL eagerly is NOT required (deferred to transport) — but bad timeout is", () => {
    expect(() => readBridgeConfig({ RESEARCH_OCTOCODE_TIMEOUT_MS: "0" })).toThrow(/TIMEOUT_MS/);
    expect(() => readBridgeConfig({ RESEARCH_OCTOCODE_MAX_RETRIES: "-1" })).toThrow(/MAX_RETRIES/);
  });
});

describe("parseArgs", () => {
  it("returns [] for empty input", () => {
    expect(parseArgs(undefined)).toEqual([]);
    expect(parseArgs("   ")).toEqual([]);
  });

  it("splits on whitespace when not JSON", () => {
    expect(parseArgs("--foo bar -x")).toEqual(["--foo", "bar", "-x"]);
  });

  it("accepts a JSON string array", () => {
    expect(parseArgs('["a","b","c"]')).toEqual(["a", "b", "c"]);
  });

  it("falls back to split when JSON parses to non-array", () => {
    expect(parseArgs('{"a":1}')).toEqual(['{"a":1}']);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2. Result unwrapping
// ──────────────────────────────────────────────────────────────────────────

describe("unwrapCallToolResult", () => {
  it("prefers structuredContent", () => {
    const out = unwrapCallToolResult(
      { structuredContent: { results: [{ repo: "a/b", path: "c.ts" }] } },
      "githubSearchCode",
    );
    expect(out).toEqual({ results: [{ repo: "a/b", path: "c.ts" }] });
  });

  it("parses JSON text content into an object", () => {
    const out = unwrapCallToolResult(
      { content: [{ type: "text", text: '{"paths":["x.ts"]}' }] },
      "githubViewRepoStructure",
    );
    expect(out).toEqual({ paths: ["x.ts"] });
  });

  it("returns raw text when not JSON", () => {
    const out = unwrapCallToolResult(
      { content: [{ type: "text", text: "not json" }] },
      "t",
    );
    expect(out).toBe("not json");
  });

  it("returns the content array when there is no text item", () => {
    const content = [{ type: "image", data: "x" }];
    const out = unwrapCallToolResult({ content }, "t");
    expect(out).toBe(content);
  });

  it("throws a ToolError when isError is true", () => {
    expect(() =>
      unwrapCallToolResult(
        { isError: true, content: [{ type: "text", text: "boom" }] },
        "githubGetFileContent",
      ),
    ).toThrow(ToolError);
  });

  it("passes through non-object results", () => {
    expect(unwrapCallToolResult(null, "t")).toBeNull();
    expect(unwrapCallToolResult("hi", "t")).toBe("hi");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 3. Retry classification
// ──────────────────────────────────────────────────────────────────────────

describe("isRetryable / isConnectionLost", () => {
  it("retries on network-shaped errors", () => {
    expect(isRetryable(new Error("fetch failed: ECONNRESET"))).toBe(true);
    expect(isRetryable(new Error("ETIMEDOUT"))).toBe(true);
    expect(isRetryable(new Error("socket hang up"))).toBe(true);
  });

  it("retries on rate-limit-shaped tool errors", () => {
    expect(isRetryable(new ToolError("t", "Rate limit exceeded (429)"))).toBe(true);
    expect(isRetryable(new Error("Too Many Requests"))).toBe(true);
  });

  it("does NOT retry config errors", () => {
    expect(isRetryable(new ConfigError("bad"))).toBe(false);
  });

  it("does NOT retry ordinary tool errors", () => {
    expect(isRetryable(new ToolError("t", "file not found"))).toBe(false);
  });

  it("treats connection-closed messages as connection-lost", () => {
    expect(isConnectionLost(new Error("connection closed"))).toBe(true);
    expect(isConnectionLost(new Error("ECONNRESET"))).toBe(true);
    expect(isConnectionLost(new ToolError("t", "rate limited"))).toBe(false);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and stays under the cap", () => {
    const d0 = backoffDelay(0, 100);
    const d5 = backoffDelay(5, 100);
    expect(d0).toBeGreaterThanOrEqual(100);
    expect(d0).toBeLessThanOrEqual(200);
    expect(d5).toBeLessThanOrEqual(30_000);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 4. Export shapes (contract: default, named callTool, factory)
// ──────────────────────────────────────────────────────────────────────────

describe("module export shapes", () => {
  it("exports a default function, a named callTool, and a createOctocodeToolCaller factory", async () => {
    const mod = await import("../bridges/octocode-mcp.js");
    expect(typeof mod.default).toBe("function");
    expect(typeof mod.callTool).toBe("function");
    expect(typeof mod.createOctocodeToolCaller).toBe("function");
  });

  it("createOctocodeToolCaller returns an OctocodeToolCaller with an injected transport", () => {
    const [transport] = InMemoryTransport.createLinkedPair();
    const caller = createOctocodeToolCaller({ transport, env: {} });
    expect(typeof caller).toBe("function");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 5. In-process MCP round-trip (real client + real server, no network)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Spin up a minimal mock Octocode server in-process, hand the bridge a client
 * wired to it over an in-memory transport pair, and confirm a real
 * `githubSearchCode` call flows end-to-end and is unwrapped into the shape the
 * adapter's `normalizeSearchResponse` expects.
 */
async function withMockOctocodeServer(
  fn: (callTool: (name: string, args: unknown) => Promise<unknown>) => Promise<void>,
): Promise<void> {
  const server = new McpServer(
    { name: "mock-octocode", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.tool("githubSearchCode", "mock code search", () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          results: [
            {
              queryId: "q1",
              repository: "get-convex/convex-auth",
              path: "convex/auth.ts",
              matches: [{ line: 42, text: "export function authenticate" }],
            },
          ],
        }),
      },
    ],
  }));

  server.tool("githubGetFileContent", "mock file read", () => ({
    content: [
      { type: "text", text: JSON.stringify({ files: [{ content: "export const X = 1;" }] }) },
    ],
  }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-bridge", version: "0.0.0" });
  await client.connect(clientTransport);

  // Build a caller that uses the injected transport and never retries, so a
  // failure surfaces immediately rather than masking a bug in retries.
  const caller = createOctocodeToolCaller({
    transport: clientTransport,
    config: { maxRetries: 0, timeoutMs: 5_000 },
    env: {},
  });

  try {
    await fn(caller);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

describe("in-process MCP round-trip", () => {
  it("calls githubSearchCode and unwraps into OctocodeSearchResponse shape", async () => {
    await withMockOctocodeServer(async (callTool) => {
      const raw = (await callTool("githubSearchCode", {
        queries: [{ id: "q1", keywordsToSearch: ["convex", "auth"] }],
      })) as { results?: Array<{ repository?: string; path?: string }> };

      expect(raw.results).toHaveLength(1);
      expect(raw.results?.[0]?.repository).toBe("get-convex/convex-auth");
      expect(raw.results?.[0]?.path).toBe("convex/auth.ts");
    });
  });

  it("calls githubGetFileContent and unwraps { files: [{ content }] }", async () => {
    await withMockOctocodeServer(async (callTool) => {
      const raw = (await callTool("githubGetFileContent", {
        queries: [{ owner: "o", repo: "r", path: "x.ts", fullContent: true }],
      })) as { files?: Array<{ content?: string }> };

      expect(raw.files?.[0]?.content).toBe("export const X = 1;");
    });
  });

  it("surfaces a tool error (isError) as a thrown Error, not a silent return", async () => {
    const server = new McpServer(
      { name: "mock-octocode-err", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    server.tool("githubSearchCode", "errors", () => ({
      isError: true,
      content: [{ type: "text", text: "invalid query" }],
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const caller = createOctocodeToolCaller({
      transport: clientTransport,
      config: { maxRetries: 0, timeoutMs: 5_000 },
      env: {},
    });

    await expect(
      caller("githubSearchCode", { queries: [{ id: "q1" }] }),
    ).rejects.toThrow(/invalid query/);

    await server.close().catch(() => {});
  });
});
