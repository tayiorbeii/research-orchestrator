# Research Orchestrator — Bridge Modules

Bridge modules are **host-side wiring**: they connect the orchestrator's
interface-only core to a live external service (an MCP server, a REST API, …).
They never live under `src/` and are never imported by core library code — the
core depends only on `EvidenceProvider` / `RepoExplainer` interfaces and
receives bridges via injection (see `src/adapters/bridge.ts`).

## `octocode-mcp.ts` — live Octocode MCP bridge

A production-ready bridge that wraps a real `@modelcontextprotocol/sdk` client
and exposes an `OctocodeToolCaller`.

- **Transports:** stdio (spawn a subprocess), SSE, or Streamable HTTP.
- **Lifecycle:** lazy connect on first call; transparent reconnect on transport
  death.
- **Resilience:** jittered exponential backoff for transient failures
  (timeouts, closed connections, network errors, rate limits).
- **Unwrapping:** prefers `structuredContent`, falls back to JSON-parsed
  `text` content, so the adapter always receives the Octocode payload directly.
- **Export shapes:** default export, named `callTool`, and a
  `createOctocodeToolCaller` factory — all three shapes accepted by
  `bridgeFunctionFromModule`.

### Build

```bash
npm run build           # core + bridges -> dist/ and dist/bridges/
npm run build:bridges   # bridges only
```

### Configure

All settings are read from `process.env` at first call.

| Variable | Values | Default |
| --- | --- | --- |
| `RESEARCH_OCTOCODE_TRANSPORT` | `stdio` \| `sse` \| `http` | `stdio` |
| `RESEARCH_OCTOCODE_COMMAND` | executable for stdio (e.g. `npx`) | — |
| `RESEARCH_OCTOCODE_ARGS` | JSON array `["-y","pkg"]` or space-split | `[]` |
| `RESEARCH_OCTOCODE_CWD` | working dir for the subprocess | inherited |
| `RESEARCH_OCTOCODE_URL` | server URL for sse/http | — |
| `RESEARCH_OCTOCODE_API_KEY` | bearer token (optional) | — |
| `RESEARCH_OCTOCODE_MAX_RETRIES` | int ≥ 0 | `3` |
| `RESEARCH_OCTOCODE_BASE_BACKOFF_MS` | int ≥ 0 | `500` |
| `RESEARCH_OCTOCODE_TIMEOUT_MS` | per-call ms | `60000` |
| `RESEARCH_OCTOCODE_CLIENT_NAME` | MCP client name | `research-orchestrator` |
| `RESEARCH_OCTOCODE_DEBUG` | `1` / `true` → stderr logging | off |

### Run

```bash
# stdio
RESEARCH_OCTOCODE_BRIDGE=./dist/bridges/octocode-mcp.js \
RESEARCH_OCTOCODE_COMMAND=npx \
RESEARCH_OCTOCODE_ARGS='["-y","@octocodeai/mcp@latest"]' \
  npx tsx src/cli.ts find --goal "..." --out .research/live --mode octocode

# sse / http
RESEARCH_OCTOCODE_BRIDGE=./dist/bridges/octocode-mcp.js \
RESEARCH_OCTOCODE_TRANSPORT=sse \
RESEARCH_OCTOCODE_URL=http://localhost:3001/sse \
  npx tsx src/cli.ts find --goal "..." --out .research/live --mode octocode
```

### Programmatic use (custom transport / config overrides)

```ts
import { setOctocodeToolCaller } from "../src/adapters/bridge.js";
import { createOctocodeToolCaller } from "../dist/bridges/octocode-mcp.js";

// Rely on env for transport, override retry behaviour:
setOctocodeToolCaller(createOctocodeToolCaller({ config: { maxRetries: 5 } }));

// Or inject a transport directly (tests / exotic runtimes):
setOctocodeToolCaller(createOctocodeToolCaller({ transport: myTransport }));
```

### Verify

- **No server needed:** `npm run build && npx tsx scripts/verify-bridge-wiring.ts`
  loads the bridge through the production env-var loader and drives the real
  `OctocodeEvidenceProvider` against an in-memory mock MCP server.
- **Live server:** `npx tsx scripts/smoke-octocode-bridge.ts` makes one real
  `ghSearchCode` call (requires a reachable Octocode MCP server).
- **Unit + integration tests:** `tests/octocodeBridge.test.ts` (26 tests).

### Error contract

Transient failures are retried; anything that survives the retry budget is
thrown as a plain `Error` whose `message` names the tool and the cause. The
adapter converts thrown errors into `missingProof` warnings rather than
crashing the run (design invariant #4).
