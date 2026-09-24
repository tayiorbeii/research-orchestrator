/**
 * Live Octocode MCP bridge for the Research Orchestrator.
 *
 * Host-side wiring (NOT core library code): spawns or connects to a real
 * Octocode MCP server and exposes an {@link OctocodeToolCaller} that the core
 * `OctocodeEvidenceProvider` consumes. The orchestrator never embeds an MCP
 * client — it loads this module via `RESEARCH_OCTOCODE_BRIDGE` or receives the
 * factory via `setOctocodeToolCaller(createOctocodeToolCaller())`.
 *
 * This module exports the bridge in all three shapes accepted by
 * `bridgeFunctionFromModule`:
 *   1. default export            -> `export default callTool`
 *   2. named export `callTool`   -> `export { callTool }`
 *   3. factory                   -> `export { createOctocodeToolCaller }`
 *
 * The factory form is preferred for programmatic use because it accepts an
 * explicit transport (for tests) and config overrides. The default/named
 * forms read everything from `process.env` and lazily connect on first call.
 *
 * ── Connection configuration (read from process.env) ───────────────────────
 *   RESEARCH_OCTOCODE_TRANSPORT     "stdio" | "sse" | "http"  (default: stdio)
 *
 *   stdio:
 *     RESEARCH_OCTOCODE_COMMAND     executable, e.g. "npx" or "/opt/octocode/bin/octocode"
 *     RESEARCH_OCTOCODE_ARGS        JSON array ["--foo","bar"] OR space-split "--foo bar"
 *     RESEARCH_OCTOCODE_CWD         optional working directory for the subprocess
 *
 *   sse / http:
 *     RESEARCH_OCTOCODE_URL         e.g. "http://localhost:3001/sse" or ".../mcp"
 *     RESEARCH_OCTOCODE_API_KEY     optional bearer token (sent as Authorization header)
 *
 *   behaviour:
 *     RESEARCH_OCTOCODE_MAX_RETRIES   int  (default 3; 0 disables retry)
 *     RESEARCH_OCTOCODE_BASE_BACKOFF_MS  (default 500)
 *     RESEARCH_OCTOCODE_TIMEOUT_MS     per-call timeout (default 60000)
 *     RESEARCH_OCTOCODE_CLIENT_NAME    MCP client name (default "research-orchestrator")
 *     RESEARCH_OCTOCODE_DEBUG          "1" or "true" enables stderr logging
 *
 * ── Error contract ─────────────────────────────────────────────────────────
 * Transient failures (timeouts, closed transports, network errors) are retried
 * with jittered exponential backoff. A tool-level error (`isError: true` or a
 * rate-limit-shaped message) is retried only when it looks transient. Anything
 * that survives the retry budget is thrown as a plain `Error` whose `message`
 * names the tool and the underlying failure; the adapter converts that into a
 * `missingProof` warning rather than crashing the run.
 *
 * @module bridges/octocode-mcp
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * Signature the orchestrator's adapter expects. Re-declared locally so the
 * bridge has zero compile-time dependency on `src/` (it is host-side code and
 * ships outside the core library graph). Structurally identical to
 * `OctocodeToolCaller` in `src/adapters/OctocodeEvidenceProvider.ts`.
 */
export type OctocodeToolCaller = (toolName: string, args: unknown) => Promise<unknown>;

/** Transport selection. */
export type OctocodeTransportKind = "stdio" | "sse" | "http";

/** Resolved bridge configuration (env values coerced to typed fields). */
export interface OctocodeBridgeConfig {
  transport: OctocodeTransportKind;
  /** stdio */
  command?: string;
  args: string[];
  cwd?: string;
  /** sse / http */
  url?: string;
  apiKey?: string;
  /** behaviour */
  maxRetries: number;
  baseBackoffMs: number;
  timeoutMs: number;
  clientName: string;
  debug: boolean;
}

/** Options accepted by {@link createOctocodeToolCaller}. */
export interface CreateOctocodeToolCallerOptions {
  /**
   * Inject a transport directly (test path). When provided, `config` is used
   * only for retry/timeout behaviour; transport-specific env vars are ignored.
   */
  transport?: Transport;
  /** Overrides for individual config fields; missing fields fall back to env. */
  config?: Partial<OctocodeBridgeConfig>;
  /** Environment to read configuration from (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

const DEFAULTS = {
  transport: "stdio" as OctocodeTransportKind,
  maxRetries: 3,
  baseBackoffMs: 500,
  timeoutMs: 60_000,
  clientName: "research-orchestrator",
};

/** Read & coerce bridge configuration from an environment object. */
export function readBridgeConfig(env: NodeJS.ProcessEnv = process.env): OctocodeBridgeConfig {
  const transport = parseTransport(env.RESEARCH_OCTOCODE_TRANSPORT, DEFAULTS.transport);
  const args = parseArgs(env.RESEARCH_OCTOCODE_ARGS);
  const apiKey = env.RESEARCH_OCTOCODE_API_KEY;
  const url = env.RESEARCH_OCTOCODE_URL;

  const config: OctocodeBridgeConfig = {
    transport,
    command: env.RESEARCH_OCTOCODE_COMMAND,
    args,
    cwd: env.RESEARCH_OCTOCODE_CWD,
    url,
    apiKey: apiKey && apiKey.trim() !== "" ? apiKey : undefined,
    maxRetries: parseIntish(env.RESEARCH_OCTOCODE_MAX_RETRIES, DEFAULTS.maxRetries),
    baseBackoffMs: parseIntish(env.RESEARCH_OCTOCODE_BASE_BACKOFF_MS, DEFAULTS.baseBackoffMs),
    timeoutMs: parseIntish(env.RESEARCH_OCTOCODE_TIMEOUT_MS, DEFAULTS.timeoutMs),
    clientName: env.RESEARCH_OCTOCODE_CLIENT_NAME?.trim() || DEFAULTS.clientName,
    debug: isTruthy(env.RESEARCH_OCTOCODE_DEBUG),
  };

  validateConfig(config);
  return config;
}

/** Build a fresh transport from resolved config. */
export function createTransport(config: OctocodeBridgeConfig): Transport {
  switch (config.transport) {
    case "stdio": {
      if (!config.command) {
        throw new ConfigError(
          "stdio transport requires RESEARCH_OCTOCODE_COMMAND (the executable to spawn).",
        );
      }
      // `env` is intentionally omitted: StdioClientTransport then uses the
      // SDK's getDefaultEnvironment(), which inherits the parent process env
      // (incl. any tokens the Octocode subprocess needs) safely.
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        stderr: "pipe",
      });
    }
    case "sse": {
      if (!config.url) {
        throw new ConfigError(
          "sse transport requires RESEARCH_OCTOCODE_URL (e.g. http://localhost:3001/sse).",
        );
      }
      return new SSEClientTransport(toUrl(config.url), {
        requestInit: authHeaders(config),
      });
    }
    case "http": {
      if (!config.url) {
        throw new ConfigError(
          "http transport requires RESEARCH_OCTOCODE_URL (e.g. http://localhost:3001/mcp).",
        );
      }
      return new StreamableHTTPClientTransport(toUrl(config.url), {
        requestInit: authHeaders(config),
      });
    }
    default: {
      // Exhaustiveness check; parseTransport already constrains the union.
      throw new ConfigError(`Unsupported transport: ${config.transport as string}`);
    }
  }
}

/**
 * Create an {@link OctocodeToolCaller} backed by a live MCP client.
 *
 * Connection is established lazily on the first call and rebuilt on transport
 * death. Each call is retried with jittered exponential backoff for transient
 * failures (timeouts, closed connections, network errors).
 */
export function createOctocodeToolCaller(
  options: CreateOctocodeToolCallerOptions = {},
): OctocodeToolCaller {
  const config: OctocodeBridgeConfig = { ...readBridgeConfig(options.env), ...options.config };
  const injectedTransport = options.transport;

  // Mutable client state, closed over by the returned caller.
  let client: Client | undefined;
  let activeTransport: Transport | undefined;
  let connecting: Promise<Client> | undefined;

  const debug = (...parts: unknown[]): void => {
    if (config.debug) console.error("[octocode-bridge]", ...parts);
  };

  async function connect(): Promise<Client> {
    // Serialize concurrent first-call races onto a single connect attempt.
    if (connecting) return connecting;
    connecting = (async () => {
      const transport = injectedTransport ?? createTransport(config);
      activeTransport = transport;
      const next = new Client({ name: config.clientName, version: "0.1.0" });
      // Surface transport errors through the client's close path so the next
      // call can detect a dead connection and reconnect.
      transport.onerror = (err: Error) => debug("transport error:", err.message);
      transport.onclose = () => debug("transport closed");
      await next.connect(transport);
      debug("connected via", config.transport);
      client = next;
      return next;
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }

  async function reconnect(): Promise<Client> {
    debug("reconnecting after transport death");
    await safeClose(client, activeTransport);
    client = undefined;
    activeTransport = undefined;
    return connect();
  }

  async function callOnce(name: string, args: unknown, clientRef: Client): Promise<unknown> {
    const result = await clientRef.callTool(
      { name, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      { timeout: config.timeoutMs },
    );
    return unwrapCallToolResult(result, name);
  }

  return async function callTool(name: string, args: unknown): Promise<unknown> {
    let lastError: unknown;
    let reconnected = false;

    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      // Ensure we have a live client; (re)connect if needed.
      let clientRef: Client;
      try {
        if (!client) {
          clientRef = await (reconnected ? reconnect() : connect());
        } else {
          clientRef = client;
        }
      } catch (err) {
        lastError = err;
        if (attempt < config.maxRetries && isRetryable(err)) {
          await backoff(attempt, config.baseBackoffMs);
          continue;
        }
        throw wrap(err, name, `connect failed after ${attempt + 1} attempt(s)`);
      }

      try {
        return await callOnce(name, args, clientRef);
      } catch (err) {
        lastError = err;

        // A dead transport: force a reconnect before the next attempt so we
        // don't hammer a broken client object.
        if (isConnectionLost(err)) {
          await safeClose(client, activeTransport);
          client = undefined;
          activeTransport = undefined;
          reconnected = true;
        }

        if (attempt < config.maxRetries && isRetryable(err)) {
          debug(`call ${name} failed (attempt ${attempt + 1}), retrying: ${describe(err)}`);
          await backoff(attempt, config.baseBackoffMs);
          continue;
        }
        throw wrap(err, name);
      }
    }

    // Loop exits only via return or throw; this is a defensive fallback.
    throw wrap(lastError, name, "exhausted retries");
  };
}

// ── Result unwrapping ───────────────────────────────────────────────────────

/** A minimal view of the MCP CallToolResult we care about. */
interface CallToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Extract the payload an Octocode tool actually returned. Preference order:
 *   1. `structuredContent` (typed JSON object) — cleanest.
 *   2. The first `text` content item, JSON-parsed when it looks like JSON.
 *   3. The raw result object (last resort, preserves information).
 *
 * Tool-level errors (`isError: true`) are turned into a thrown Error so the
 * retry layer can classify them; non-retryable ones propagate to the adapter.
 */
export function unwrapCallToolResult(result: unknown, toolName: string): unknown {
  if (result == null || typeof result !== "object") return result;
  const r = result as CallToolResultLike;

  const payload = r.structuredContent ?? extractTextPayload(r.content);

  if (r.isError) {
    const message = typeof payload === "string" ? payload : stringifyForError(payload);
    throw new ToolError(toolName, message || "tool returned isError with no message");
  }
  return payload;
}

function extractTextPayload(content: CallToolResultLike["content"]): unknown {
  if (!Array.isArray(content)) return undefined;
  const first = content[0];
  const text = first?.text;
  if (typeof text !== "string") return content;
  const trimmed = text.trim();
  if (!trimmed) return text;
  // Octocode returns JSON; parse it when feasible, else return the raw text.
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }
  return text;
}

// ── Retry classification ─────────────────────────────────────────────────────

/** True for failures worth retrying (transient / network / rate-limit). */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ToolError) return looksLikeRateLimit(error.message);
  if (error instanceof McpError) {
    return (
      error.code === -32001 || // RequestTimeout
      error.code === -32000    // ConnectionClosed
    );
  }
  if (error instanceof ConfigError) return false;
  const msg = describe(error);
  return (
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|fetch failed|network|socket hang up/i.test(
      msg,
    ) ||
    looksLikeRateLimit(msg) ||
    /closed|disconnect|transport/i.test(msg)
  );
}

/** True when the failure indicates the transport is dead and must reconnect. */
export function isConnectionLost(error: unknown): boolean {
  if (error instanceof McpError) return error.code === -32000; // ConnectionClosed
  const msg = describe(error);
  return /closed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|transport/i.test(msg);
}

function looksLikeRateLimit(message: string): boolean {
  return /rate.?limit|429|too many requests|throttl/i.test(message);
}

// ── Shared module-level caller (default + named exports) ────────────────────

/**
 * Lazily-initialized process-wide caller used by the default and named
 * exports. Built on first use from `process.env`. For programmatic control
 * (custom transport, config overrides) use {@link createOctocodeToolCaller}.
 */
let sharedCaller: OctocodeToolCaller | undefined;

function sharedCallTool(name: string, args: unknown): Promise<unknown> {
  if (!sharedCaller) sharedCaller = createOctocodeToolCaller();
  return sharedCaller(name, args);
}

// Default export + named export + factory — all three shapes the loader
// accepts. The factory is checked first by `bridgeFunctionFromModule`, then
// the default, then the named `callTool`.
export default sharedCallTool;
export { sharedCallTool as callTool };
// `createOctocodeToolCaller` is already exported by its `export function`
// declaration above — do not re-list it here.

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Distinguished error types so callers/tests can branch on cause. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}
export class ToolError extends Error {
  override readonly name = "ToolError";
  readonly toolName: string;
  constructor(toolName: string, message: string) {
    super(message);
    this.toolName = toolName;
  }
}

function parseTransport(raw: string | undefined, fallback: OctocodeTransportKind): OctocodeTransportKind {
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "stdio" || v === "sse" || v === "http") return v;
  throw new ConfigError(
    `RESEARCH_OCTOCODE_TRANSPORT="${raw}" is invalid; use one of: stdio, sse, http.`,
  );
}

/** Parse RESEARCH_OCTOCODE_ARGS as a JSON array, else space-split, else []. */
export function parseArgs(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return [];
  const trimmed = raw.trim();
  if (trimmed[0] === "[") {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed as string[];
      }
    } catch {
      // fall through to space-split
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

function parseIntish(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function isTruthy(raw: string | undefined): boolean {
  return raw === "1" || raw === "true" || raw === "TRUE" || raw === "yes";
}

function toUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new ConfigError(`RESEARCH_OCTOCODE_URL="${raw}" is not a valid URL.`);
  }
}

function authHeaders(config: OctocodeBridgeConfig): { headers: Record<string, string> } | undefined {
  if (!config.apiKey) return undefined;
  return { headers: { Authorization: `Bearer ${config.apiKey}` } };
}

function validateConfig(config: OctocodeBridgeConfig): void {
  if (config.maxRetries < 0) throw new ConfigError("RESEARCH_OCTOCODE_MAX_RETRIES must be >= 0.");
  if (config.baseBackoffMs < 0) throw new ConfigError("RESEARCH_OCTOCODE_BASE_BACKOFF_MS must be >= 0.");
  if (config.timeoutMs <= 0) throw new ConfigError("RESEARCH_OCTOCODE_TIMEOUT_MS must be > 0.");
  if (config.transport === "stdio" && !config.command) {
    // Allowed to construct (so tests can inject transport), but flagged when
    // actually building one. createTransport re-checks; keep this as a hint.
  }
}

/** Jittered exponential backoff: base * 2^attempt + random jitter. */
export function backoffDelay(attempt: number, baseMs: number): number {
  const exp = baseMs * 2 ** attempt;
  const jitter = Math.random() * baseMs;
  return Math.min(exp + jitter, 30_000);
}

async function backoff(attempt: number, baseMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt, baseMs)));
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function stringifyForError(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Wrap any failure in an Error carrying the tool name + concise cause. */
function wrap(error: unknown, toolName: string, context?: string): Error {
  const cause = describe(error);
  const parts = [`Octocode tool "${toolName}" failed`];
  if (context) parts.push(`(${context})`);
  parts.push(":");
  parts.push(cause);
  const message = parts.join(" ");
  const err = new Error(message) as Error & { toolName?: string; cause?: unknown };
  err.toolName = toolName;
  err.cause = error instanceof Error ? error : undefined;
  return err;
}

async function safeClose(clientRef?: Client, transport?: Transport): Promise<void> {
  try {
    if (clientRef) await clientRef.close();
    else if (transport) await transport.close();
  } catch {
    // Best-effort cleanup; ignore.
  }
}
