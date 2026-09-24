# Runbook — Research Orchestrator

End-to-end instructions for installing, building, running, testing, and operating
the Research Orchestrator. Every command below is verified against the actual
source (`src/cli.ts`, `package.json`, `bridges/`).

> **TL;DR** — after `npm install`, this works with **zero configuration** in mock
> mode (deterministic, no network):
> ```bash
> npm install
> npx tsx src/cli.ts find \
>   --goal "Next.js + Convex app with email magic links via Resend" \
>   --out .research/out
> ```
> Artifacts land in `.research/out/` (`research.md`, `plan.md`, `evidence.json`,
> `implementation-checklist.md`).

---

## 1. Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| **Node.js** | **20 LTS or newer** (tested on 24.x) | ESM project (`"type": "module"`), NodeNext resolution. Node 18 works but 20+ is recommended. |
| **npm** | 10+ (ships with Node) | Used for install + scripts. `pnpm`/`yarn` work but commands below use `npm`. |
| **Git** | any recent | Only needed to clone. |
| **TypeScript runner** | bundled (`tsx` devDep) | No global installs required. |

**Optional**, only for live modes:
- An **Octocode MCP server** reachable via stdio / SSE / HTTP (for `--mode octocode`).
- GitHub authentication via `gh auth login` or `GITHUB_TOKEN`/`GH_TOKEN` (for live GitHub/Octocode modes).

---

## 2. Install

```bash
git clone https://github.com/tayiorbeii/research-orchestrator.git
cd research-orchestrator
npm install
```

Lightweight install: the research engine's runtime dependencies are just
`@modelcontextprotocol/sdk` and `zod`, plus dev tools (`tsx`, `typescript`,
`vitest`, `@types/node`). No postinstall scripts.

---

## 3. The two ways to run

The CLI lives in `src/cli.ts`. You can run it **without building** (via `tsx`) or
**after building** (via `node`). Both are fully supported.

| Mode | Command | When to use |
| --- | --- | --- |
| **Dev (no build)** | `npx tsx src/cli.ts <args>` | Fastest feedback while editing; no compile step. |
| **Built** | `node dist/cli.js <args>` | Production / CI / installed globally. Requires `npm run build` first. |

The npm helper `npm run cli -- <args>` is shorthand for `tsx src/cli.ts <args>`
(note the `--` so flags pass through to the CLI, not npm).

---

## 4. CLI reference

```
Usage:
  research-orchestrator find --goal "<goal>" --out <dir> [options]
  research-orchestrator eval [--out <file.json>]
  research-orchestrator mcp
  research-orchestrator --help
```

### `find` — run the full research pipeline

Turns a goal into grounded planning artifacts.

| Flag | Required | Default | Description |
| --- | --- | --- | --- |
| `--goal <string>` | ✅ | — | Research goal in plain English. |
| `--out <dir>` | ✅ | — | Output directory for artifacts (created if missing). |
| `--mode <mode>` | — | `mock` | `mock` \| `octocode` \| `github`. |
| `--mock` | — | — | Shorthand for `--mode mock` (deterministic, no network). |
| `--max-candidates <n>` | — | `25` | Cap how many candidate repos are collected. |
| `--max-repos-to-prove <n>` | — | unset | Cap deep proof reads (limits Octocode calls / cost). |
| `--no-cache` | — | off | Skip reading/writing `.research-cache/`. |
| `--allow-inconclusive` | — | off | Exit `0` for an inconclusive run instead of `2`. |

**Exit codes:** `0` for a complete run (or an explicitly allowed inconclusive
run), `2` when research is inconclusive, and `1` on an execution/configuration
error. Structured `ResearchError` failures are printed to stderr.

> **Novel-domain behavior:** the deterministic normalizer mines named systems
> and behavior concepts from unfamiliar goals. If it cannot derive trustworthy
> proof signals, it rejects the goal as under-specified. A run with missing
> candidates, anchors, or required proof roles is `inconclusive`, not proof of
> absence. Add structured `hints` (`requiredConcepts`, `likelyFiles`, and
> `proofRequirements`) as shown in §13 when domain vocabulary needs correction.

### `eval` — run the benchmark harness

```bash
npx tsx src/cli.ts eval [--out report.json]
```

Runs the golden benchmark tasks and prints a JSON report to stdout (and to
`--out` if given).

### `mcp` — start the MCP server (stdio)

```bash
npx tsx src/cli.ts mcp
```

Starts a stdio MCP server (server name `research-orchestrator` v0.1.0) exposing
four tools: **`findImplementations`**, **`scoreRepos`**,
**`explainRepoPattern`**, **`writePlanArtifact`**. See §10 for client wiring.

### `--help`

```bash
npx tsx src/cli.ts --help
npx tsx src/cli.ts            # no args also prints help (exits 1)
```

---

## 5. The three modes

| Mode | Network? | Config needed | What it does |
| --- | --- | --- | --- |
| **`mock`** (default) | ❌ none | none | Deterministic `MockEvidenceProvider`. Identical output every run. **Start here.** |
| **`octocode`** | ✅ live | env vars (see §7) | Real `OctocodeEvidenceProvider` over the live bridge. Searches/proves against public repos. |
| **`github`** | ✅ live | `gh auth login` or `GITHUB_TOKEN`/`GH_TOKEN` | Built-in GitHub REST provider. |

Mock mode is the only mode that works with zero configuration. Use it to verify
your install, iterate on prompts/templates, and run the test suite.

---

## 6. Running in mock mode (zero config, offline)

```bash
# Dev (no build):
npx tsx src/cli.ts find \
  --goal "Next.js + Convex app with email magic links via Resend" \
  --out .research/mock-run

# Or with the npm helper:
npm run cli -- find --goal "..." --out .research/mock-run
```

Inspect the output:

```bash
ls .research/mock-run/
# evidence.json  implementation-checklist.md  plan.md  research.md
```

- `research.md` — narrative summary with selected repos.
- `plan.md` — staged implementation plan.
- `evidence.json` — machine-readable evidence anchors (repo + path + line + snippet).
- `implementation-checklist.md` — actionable build checklist.

Mock output is deterministic, so this is exactly what the golden-snapshot tests
lock down (see §9).

---

## 7. Running in Octocode mode (live)

This connects the orchestrator to a **real Octocode MCP server** through the
live bridge module (`bridges/octocode-mcp.ts` → `dist/bridges/octocode-mcp.js`).

### 7.1 One-time setup

```bash
# 1. Verify Octocode can authenticate to GitHub. It can reuse `gh auth`;
#    if status says unauthenticated, run `npx octocode auth login` once.
npx octocode status

# 2. Build the core + the bridge module (emits dist/ and dist/bridges/):
npm run build

# 3. Copy the template and fill in real values:
cp .env.example .env
#   then edit .env — at minimum set RESEARCH_OCTOCODE_COMMAND / _ARGS (stdio)
#   or RESEARCH_OCTOCODE_TRANSPORT=sse + _URL (sse/http).

# 4. Load the env into your shell (the CLI reads process.env at first call):
set -a; source .env; set +a
```

The canonical current server package is `@octocodeai/mcp@latest` (the older
`@octocode/mcp-server` name does not exist on npm). The server requires Node
20 or newer.

### 7.2 stdio transport (spawn the Octocode server as a subprocess)

```bash
RESEARCH_OCTOCODE_BRIDGE=./dist/bridges/octocode-mcp.js \
RESEARCH_OCTOCODE_COMMAND=npx \
RESEARCH_OCTOCODE_ARGS='["-y","@octocodeai/mcp@latest"]' \
  npx tsx src/cli.ts find \
    --goal "Next.js + Convex app with email magic links via Resend" \
    --out .research/live \
    --mode octocode \
    --max-repos-to-prove 3
```

### 7.3 SSE / HTTP transport (server already running elsewhere)

```bash
RESEARCH_OCTOCODE_BRIDGE=./dist/bridges/octocode-mcp.js \
RESEARCH_OCTOCODE_TRANSPORT=sse \
RESEARCH_OCTOCODE_URL=http://localhost:3001/sse \
RESEARCH_OCTOCODE_API_KEY="$OCTOCODE_API_KEY" \
  npx tsx src/cli.ts find \
    --goal "..." --out .research/live --mode octocode
```

### 7.4 Bridge configuration reference

All settings are read from `process.env` at first call (lazy connect).

| Variable | Values | Default | Notes |
| --- | --- | --- | --- |
| `RESEARCH_OCTOCODE_BRIDGE` | path to compiled module | — | **Required** for octocode mode. Point at `./dist/bridges/octocode-mcp.js`. |
| `RESEARCH_OCTOCODE_TRANSPORT` | `stdio` \| `sse` \| `http` | `stdio` | |
| `RESEARCH_OCTOCODE_COMMAND` | executable (stdio) | — | e.g. `npx`, `node`. |
| `RESEARCH_OCTOCODE_ARGS` | JSON array `["-y","pkg"]` **or** space-split string | `[]` | |
| `RESEARCH_OCTOCODE_CWD` | working dir (stdio) | inherited | |
| `RESEARCH_OCTOCODE_URL` | server URL (sse/http) | — | |
| `RESEARCH_OCTOCODE_API_KEY` | bearer token | — | Sent as `Authorization: Bearer …`. |
| `RESEARCH_OCTOCODE_MAX_RETRIES` | int ≥ 0 | `3` | Transient failures only. |
| `RESEARCH_OCTOCODE_BASE_BACKOFF_MS` | int ≥ 0 | `500` | Jittered exponential backoff base. |
| `RESEARCH_OCTOCODE_TIMEOUT_MS` | per-call ms | `60000` | |
| `RESEARCH_OCTOCODE_CLIENT_NAME` | string | `research-orchestrator` | Advertised in the MCP handshake. |
| `RESEARCH_OCTOCODE_DEBUG` | `1` / `true` | off | Emits bridge diagnostics to **stderr**. |

> **Security:** `.env` is gitignored. `.env.example` contains **placeholders
> only** — never put real tokens there. See `bridges/README.md` for the full
> contract (lazy connect, transparent reconnect, result unwrapping, error
> classification).

---

## 8. Building the project

```bash
npm run build           # core (src/ -> dist/) AND bridges (-> dist/bridges/)
npm run build:core      # src/ -> dist/ only
npm run build:bridges   # bridges/ -> dist/bridges/ only
```

Output layout:

```
dist/
├── cli.js               ← bin entry (research-orchestrator)
├── index.js             ← library entry (exports)
├── adapters/ core/ ...  ← compiled core
└── bridges/
    └── octocode-mcp.js  ← live bridge module (loadable via env)
```

TypeScript config: `target: ES2022`, `module/moduleResolution: NodeNext`,
`strict: true`, `declaration` + `sourceMap` on. The bridge has its own
`bridges/tsconfig.json` (separate compile unit so it never enters the core
library graph).

Run the built CLI directly:

```bash
node dist/cli.js find --goal "..." --out .research/out --mock
```

Or install globally and use the bin name:

```bash
npm install -g .
research-orchestrator --help
```

---

## 9. Running the test suite

```bash
npm test           # vitest run (single pass, exits)
npm run test:watch # vitest in watch mode
```

The suite runs unit + golden-snapshot tests across the core stages, including:
- **Golden-snapshot tests** (`goldenArtifacts.test.ts`) — lock the mock-mode
  output of `research.md` / `plan.md` / `evidence.json` /
  `implementation-checklist.md`. Update with `npx vitest -u` after intentional
  template changes.
- **Bridge tests** (`octocodeBridge.test.ts`, 26 tests) — config parsing, result
  unwrapping, retry classification, all three export shapes, and an in-process
  MCP round-trip via `InMemoryTransport` (no subprocess/network).
- Core unit tests: `normalizeFeatureSpec`, `generateSearchProbes`,
  `scoreCandidate`, `writeArtifacts`, `redact`, `schemas`, `pipeline`,
  `octocodeProvider`, `hybridExplainer`.

---

## 10. Verifying the bridge wiring (octocode mode)

Two scripts validate the live path. **Run `npm run build` first** (both load
the compiled bridge from `dist/bridges/`).

### 10.1 End-to-end wiring (no network needed)

```bash
npx tsx scripts/verify-bridge-wiring.ts
```

Loads the compiled bridge through the **production** env-var loader
(`loadOctocodeToolCallerFromEnv`), wires it into the **real**
`OctocodeEvidenceProvider`, and drives `searchCode` + `getFile` against an
in-memory mock MCP server. Prints `✓ …` lines and exits 0. This proves the
loader → bridge → adapter chain works without touching the network.

### 10.2 Live smoke test (hits a real server)

```bash
npm run smoke:octocode
# equivalent to:
#   npx tsx scripts/smoke-octocode-bridge.ts
```

Requires the same `RESEARCH_OCTOCODE_*` env vars as §7. Makes one real
`ghSearchCode` call and reports whether the response unwrapped into the
shape the adapter expects. Exit 0 = plumbing OK; 1 = server unreachable.

---

## 11. Running as an MCP server

Start the server (stdio transport):

```bash
npx tsx src/cli.ts mcp      # dev
node dist/cli.js mcp        # built
```

It speaks MCP over stdio and exposes:

| Tool | Purpose |
| --- | --- |
| `findImplementations` | Run the research pipeline for a goal. |
| `scoreRepos` | Score candidate repos against a feature spec. |
| `explainRepoPattern` | Extract the implementation pattern from evidence. |
| `writePlanArtifact` | Render a plan/checklist from a research run. |

### Connecting from an MCP client (e.g. Claude Desktop)

Add this to your client's server config (path must be absolute):

```jsonc
{
  "mcpServers": {
    "research-orchestrator": {
      "command": "node",
      "args": ["/absolute/path/to/research-orchestrator/dist/cli.js", "mcp"]
    }
  }
}
```

For octocode-backed runs, pass the bridge env on the server:

```jsonc
{
  "mcpServers": {
    "research-orchestrator": {
      "command": "node",
      "args": ["/abs/path/dist/cli.js", "mcp"],
      "env": {
        "RESEARCH_OCTOCODE_BRIDGE": "/abs/path/dist/bridges/octocode-mcp.js",
        "RESEARCH_OCTOCODE_TRANSPORT": "stdio",
        "RESEARCH_OCTOCODE_COMMAND": "npx",
        "RESEARCH_OCTOCODE_ARGS": "[\"-y\",\"@octocodeai/mcp@latest\"]"
      }
    }
  }
}
```

### Connecting from Pi (pi-mcp-adapter)

Add a server entry to `~/.pi/agent/mcp.json`. The CLI self-loads the kit's
`.env` (kit root, next to `package.json`), so the bridge env comes along
automatically — explicit `env` is only needed if you keep secrets elsewhere.
Give it a generous `requestTimeoutMs`: a live octocode-backed stage call with
proof reads can take minutes.

```jsonc
{
  "mcpServers": {
    "research-orchestrator": {
      "command": "node",
      "args": ["/absolute/path/to/research-orchestrator/dist/cli.js", "mcp"],
      "lifecycle": "keep-alive",
      "requestTimeoutMs": 300000,
      "directTools": [
        "research.scoreRepos",
        "research.explainRepoPattern",
        "research.writePlanArtifact"
      ]
    }
  }
}
```

Notes:

- Point `args[0]` at the kit checkout that has a current `dist/` build
  (`npm run build` inside the kit first).
- `directTools` registers the three exposed `research.*` tools —
  `research.scoreRepos`, `research.explainRepoPattern`, and
  `research.writePlanArtifact` — individually instead of behind the proxy, so
  the agent can call them like native tools. `research.findImplementations` is
  intentionally not exposed: a full run is a multi-minute batch job that
  exceeds MCP request timeouts, so the CLI is the path for full runs
  (`research-orchestrator find`, installed globally via `npm link`).
- If the bridge env is missing, octocode-backed calls fail with
  `stdio transport requires RESEARCH_OCTOCODE_COMMAND` — the kit `.env`
  supplies it; explicit `env` in this entry overrides it.
- Restart Pi (or reconnect the server) after editing `mcp.json`, then verify
  with the MCP tool list: the server should expose `research.scoreRepos`,
  `research.explainRepoPattern`, and `research.writePlanArtifact`
  (`research.findImplementations` is registered server-side but deliberately
  not exposed — full runs go through the CLI).

In Pi specifically, Octocode itself is CLI-only (`octocode-research` skill);
do not expect `mcp:octocode/*` tools. Route GitHub evidence through the
`research.*` tools above — the kit spawns its own Octocode bridge subprocess.

---

## 12. Output artifacts & caching

**Artifacts** (written to `--out <dir>`):

| File | Contents |
| --- | --- |
| `research.md` | Narrative: goal, summary, selected repositories, pattern. |
| `plan.md` | Staged implementation plan derived from the research. |
| `evidence.json` | Evidence anchors: repo, file path, line range, snippet, proof type. |
| `implementation-checklist.md` | Actionable build checklist. |

**Cache:** run transcripts + feature specs live in `.research-cache/`
(gitignored). Re-runs with the same goal reuse cached probes/candidates unless
you pass `--no-cache`. The `.research/` directory holds your `--out` outputs
(also gitignored).

> **Redaction:** every artifact write passes through `redactSecrets()`, which
> scrubs `ghp_/gho_/ghs_/github_pat_`, `re_…`, `sk_live_/sk_test_`, AWS keys,
> Slack tokens, etc. to `REDACTED`. Safe by construction.

---

## 13. Programmatic / library use

After `npm run build`, import the compiled library:

```ts
import { runResearch } from "./dist/index.js";
import { MockEvidenceProvider } from "./dist/adapters/MockEvidenceProvider.js";
// or for live:
import { resolveOctocodeProvider } from "./dist/adapters/bridge.js";

const provider = new MockEvidenceProvider(); // deterministic
const { run, evidence, pattern } = await runResearch({
  goal: "Next.js + Convex app with email magic links via Resend",
  provider,
  maxCandidates: 25,
  deterministic: true,
  // For novel domains, provide a Partial<FeatureSpec> so the engine generates
  // exact code probes instead of one broad repository query:
  hints: {
    featureKey: "custom-controller-input",
    feature: "external controller input",
    requiredConcepts: ["navigator.requestMIDIAccess", "onmidimessage"],
    likelyFiles: ["package.json", "index.html", "sketch.js"],
    proofRequirements: [
      {
        key: "midi_input_proof",
        description: "Browser requests MIDI access and handles messages.",
        required: true,
        signals: ["navigator.requestMIDIAccess", "onmidimessage"],
      },
    ],
  },
});
```

Most `proofRequirements[].signals` are acceptable alternatives during exact-file
collection. `existence_proof` is stricter: every named system signal must have a
proved anchor before the run can complete. `evidence.json` records the exact
`matchedSignal` for auditability. High-precision search still pairs leading
signals, so inspect the evidence map before claiming an end-to-end join.

For live Octocode, inject the bridge exactly as the CLI does:

```ts
import { resolveOctocodeProvider } from "./dist/adapters/bridge.js";
// Reads RESEARCH_OCTOCODE_BRIDGE from process.env; throws a structured
// provider_not_configured error if unset when requireConfigured: true.
const provider = await resolveOctocodeProvider({ requireConfigured: true });
```

You can also inject a custom `OctocodeToolCaller` directly without env vars:

```ts
import { setOctocodeToolCaller } from "./dist/adapters/bridge.js";
setOctocodeToolCaller(async (name, args) => myClient.call(name, args));
```

---

## 14. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `provider_not_configured` (octocode mode) | `RESEARCH_OCTOCODE_BRIDGE` is unset, or the path doesn't resolve to the compiled module. Run `npm run build`, then point the env at `./dist/bridges/octocode-mcp.js`. |
| `Cannot find module ... .js` in your own code | This is ESM + NodeNext. Every relative import needs the `.js` extension even when you write `.ts` sources. |
| `unknown --mode 'foo'` | Mode must be `mock` \| `octocode` \| `github`. |
| `--goal is required` / `--out is required` | Both flags are mandatory for `find`. |
| Bridge connects but returns `missingProof` | The adapter found candidates but no hard evidence. Loosen `--max-repos-to-prove`, broaden the goal, or check server logs. |
| `dist/bridges/octocode-mcp.js` missing | Run `npm run build:bridges` (or full `npm run build`). The bridge is a separate compile unit. |
| Tests fail after editing a template | You changed golden output intentionally. Run `npx vitest -u` to refresh snapshots, then review the diff. |
| Octocode calls time out | Raise `RESEARCH_OCTOCODE_TIMEOUT_MS` (default 60000) and/or `RESEARCH_OCTOCODE_MAX_RETRIES`. Set `RESEARCH_OCTOCODE_DEBUG=1` to see retry/backoff on stderr. |
| `gh repo clone` / push auth fails | Ensure `gh auth status` is logged in with `repo` scope (SSH or HTTPS). |

---

## 15. Environment-variable quick reference

**Bridge (octocode mode)** — see §7.4 for the full table:
`RESEARCH_OCTOCODE_BRIDGE`, `_TRANSPORT`, `_COMMAND`, `_ARGS`, `_CWD`, `_URL`,
`_API_KEY`, `_MAX_RETRIES`, `_BASE_BACKOFF_MS`, `_TIMEOUT_MS`, `_CLIENT_NAME`,
`_DEBUG`.

**Other:**
- `GITHUB_TOKEN` / `GH_TOKEN`, or `gh auth login` — for live GitHub/Octocode authentication. The stdio bridge forwards the CLI token to Octocode as `GH_TOKEN`.

Load a `.env` file into your shell before running:
```bash
set -a; source .env; set +a
```
(The CLI also self-loads a `.env` at the kit root — next to `package.json` —
automatically, with explicit environment variables taking precedence. The
shell snippet above is only needed to run from a different config location.)

---

*Verified against `src/cli.ts`, `package.json`, `bridges/`, and
`scripts/`. If the CLI surface changes, regenerate this file from `npx tsx
src/cli.ts --help` and the source.*
