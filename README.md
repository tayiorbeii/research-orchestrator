# Research Orchestrator

**Evidence-grounded implementation research.** Give it a research brief (or a
goal sentence it drafts into one) — it searches GitHub, reads source at pinned
revisions, assesses every fact against every repository it read, keeps spending
its budget on unresolved questions, and writes planning artifacts
(`research.md`, `plan.md`, `evidence.json`, `implementation-checklist.md`) that
cite file and line. Runs as a CLI and as an MCP server, with Octocode as the
evidence engine and optional DeepWiki enrichment.

> "Find examples of a Next.js + Convex app using email magic links, extract
> the implementation pattern, and produce a grounded plan."

> "Find examples of a Next.js + Convex app using email magic links, extract the implementation pattern, and produce a grounded plan."

into a repeatable workflow. Every run uses a validated v2 research brief and a
question-scoped claim ledger: a repository is *selected* only when the engine
supported at least one of its claims from source.

One run does the following (see `docs/01_architecture.md`):

1. Validate the brief (or draft one from a goal sentence) and resolve its budgets.
2. Compile one GitHub/Octocode search per distinctive term, plus a combined search
   for each multi-signal fact.
3. Select candidate repositories fairly across questions and read their matched
   files at a pinned commit.
4. Assess every fact against every repository that was read (the claim ledger) and
   derive per-question coverage.
5. Reinvest unspent budget: read unopened hits and promote further hit repositories
   while required questions remain unresolved.
6. Optionally enrich with DeepWiki when available and fresh (MCP `explainRepoPattern`).
7. Write `research.md`, `plan.md`, `implementation-checklist.md` and `evidence.json`
   from one report model, and cache the run for `--resume`.

## Install

```bash
npm install -g research-orchestrator   # or: npx research-orchestrator
```

### Requirements

- **Node 20+** (enforced via `engines`; the Octocode server also needs 20+)
- **npx** available for live `--mode octocode` (bundled with npm — it spawns
  `@octocodeai/mcp` as a subprocess; first call downloads the package)
- Network access to GitHub for live modes; **no config, no network for
  `--mode mock`**
- No native modules, no postinstall scripts — runtime deps are just
  `@modelcontextprotocol/sdk` and `zod`

### Per-mode configuration

| Mode | Needs |
| --- | --- |
| `mock` (default) | Nothing — offline, deterministic |
| `octocode` (live GitHub evidence) | Bridge env vars (below) + `gh auth login` or `GITHUB_TOKEN`/`GH_TOKEN` |
| `github` (built-in REST provider) | `gh auth login` or `GITHUB_TOKEN`/`GH_TOKEN` |

For `--mode octocode`, copy `.env.example` → `.env` and set the bridge config:

- **Local clone:** put `.env` at the package root (next to `package.json`) —
  the CLI self-loads it from its install location regardless of your cwd.
- **Global install:** either export the variables directly (they always win):

  ```bash
  export RESEARCH_OCTOCODE_BRIDGE="$(npm root -g)/research-orchestrator/dist/bridges/octocode-mcp.js"
  export RESEARCH_OCTOCODE_COMMAND=npx
  export RESEARCH_OCTOCODE_ARGS='["-y","@octocodeai/mcp@latest"]'
  ```

  …or place the `.env` at the installed package root
  (`$(npm root -g)/research-orchestrator/.env`).

- **SSE/HTTP transport** (Octocode server already running elsewhere):
  `RESEARCH_OCTOCODE_TRANSPORT=sse` + `RESEARCH_OCTOCODE_URL` +
  `RESEARCH_OCTOCODE_API_KEY` instead of the stdio vars.

For stdio, the bridge forwards the token from `gh auth token` to Octocode as
`GH_TOKEN` when no token environment variable is set. Both live providers check
authentication before starting research and return a configuration error if it
is unavailable.

Full variable reference: [`.env.example`](.env.example) and
[`docs/RUNBOOK.md`](docs/RUNBOOK.md) §7.

## Quickstart

```bash
# 1. Offline smoke run — no config, deterministic
research-orchestrator find \
  --goal "Next.js + Convex app with email magic links via Resend" \
  --out ./my-research --mode mock

# 2. Read the artifacts
ls ./my-research   # research.md plan.md evidence.json implementation-checklist.md

# 3. Live run with real GitHub evidence (one-time setup: docs/RUNBOOK.md §7)
research-orchestrator find --goal "..." --out ./my-research --mode octocode
```

The CLI self-loads a `.env` at the package root (see `.env.example`) for the
Octocode bridge; explicit environment variables always win. Exit codes:
`0` plan ready · `2` inconclusive (warnings explain why) · `1` error.

> **Full details** — [`docs/RUNBOOK.md`](docs/RUNBOOK.md) covers the verified
> mock-mode quickstart, live Octocode setup, MCP server registration, tests,
> output artifacts, and troubleshooting.

## Brief-based research

Use `plan` to validate a structured request before provider calls, then execute
the resulting brief. A `needs_input` result includes vocabulary work for a host
to perform and cite; planning itself does not claim that a lookup occurred.

```sh
npm run cli -- plan --request request.json --out brief.json
npm run cli -- find --brief brief.json --out .research/run --mode mock
npm run cli -- find --resume RUN_ID --brief revised-brief.json --out .research/resume --mode mock
```

Write questions with obligation facts: a `dependency` fact (`packageName`), `quotation` signals
(exact symbols), `config` keys, or `workflow` commands. Those facts become the search terms, and
a dependency fact also schedules the repository's `package.json` for proof. Live runs default to a
30-minute deadline, 32 searches, and 150 file reads (16 per repository); pass `--deadline-minutes <n>` or `--budget fileReads=120,...` to change the
run's limits (the same overrides are `budgetOverrides` on the MCP find tool).

`languages` is a narrow filter: with exactly one language it scopes source-code quotation
searches (`language:X`); dependency, config, and workflow facts are never language-filtered
(manifests are JSON/YAML), and listing several languages applies no filter.

Quotation evidence is deliberately strict: a signal that appears only on import/use/require
lines is a partial lead, not proof of implementation, and several signals in one fact must
appear within 12 lines of each other. For a fact with several signals, the engine also runs one
combined search for all of them, and a generic word in it (`draft`, `reply`) is never searched
alone. Avoid generic signals (numbers, common words): code search drops punctuation, so
`"continue": false` searches for "continue false".

`claimScope: "implemented"` accepts source code and the files that configure a running system:
Dockerfiles, compose/k8s/Helm YAML, JSON exports, TOML, Terraform/HCL, shell scripts, Makefiles,
SQL, and `.env.example`-style templates. README, CHANGELOG, and `docs/` files are `advertised`;
when they state the signals, the assessment names them as leads.

`find --goal` drafts a brief from the goal sentence (one quotation fact per
distinctive word, any of which satisfies the question) and runs it on the same
path as `--brief`; it is the weakest way to write a brief, not a different
engine. Mock is synthetic fixture data, not live repository research; its mode
and synthetic origin are shown in receipts.

After the first proving pass the run reinvests unspent budget: while required
questions are unresolved it reads the search hits nobody opened, promotes hit
repositories beyond the candidate cap, and reassesses, until the questions are
satisfied or the search/read/deadline budgets run out. `--mode octocode` pins
each repository to a commit SHA through your GitHub token (`gh auth login` or
`GITHUB_TOKEN`), so findings cite an immutable revision; the MCP find tool opts
in with `pinRevisions: true`.

`research.md` reports, per question: supported findings (repository, `path:line`,
quoted text, link, revision), leads (files that state the signals but cannot
count, such as documentation or imports), unsatisfied facts, and unopened search
hits to read next — followed by the search table, candidates, the budget receipt
and grouped diagnostics. `evidence.json` carries every observation and claim;
each claim names its fact (`questionId`, obligation and fact index, kind).

## Offline evaluation

`npm run eval` replays six frozen synthetic corpora, reports separate discovery,
support precision, unsupported verification, coverage, costs, provider events,
and compatibility-loss metrics, and labels tuning versus held-out fixtures.
It makes no live provider calls. See [`docs/10_eval_benchmarks.md`](docs/10_eval_benchmarks.md)
and committed demo receipts under `examples/receipts/`.

## Suggested reading order

1. `docs/RUNBOOK.md`
2. `PROMPT_FOR_CODING_AGENT.md`
3. `docs/00_project_brief.md`
4. `docs/01_architecture.md`
5. `docs/02_mvp_roadmap.md`
6. `docs/03_research_workflow.md`
7. `docs/08_mcp_tool_spec.md`
8. `docs/12_build_tasks.md`

## Directory map

```text
.
├── src/            # TypeScript source (core engine, adapters, MCP server, schemas)
│   ├── core/       # brief drafting/validation, probe compilation, run engine, claim ledger, report
│   ├── adapters/   # evidence providers (Octocode bridge, mock, GitHub)
│   ├── mcp/        # MCP server exposing the research.* tools
│   ├── cache/      # run cache
│   └── eval/       # deterministic eval harness
├── bridges/        # Octocode MCP bridge (stdio/SSE/HTTP transports)
├── tests/          # vitest suite (unit + golden snapshots) and fixtures
├── scripts/        # bridge smoke test and wiring verification
├── docs/           # RUNBOOK + design docs (00–12)
├── schemas/        # JSON schemas for feature specs and artifacts
├── templates/      # artifact templates
├── examples/       # sample feature spec, probes, and research run
├── prompts/        # subagent prompts used by the workflow
└── backlog/        # roadmap: milestones and issues
```

## Implementation bias

Start with a TypeScript/Node project exposing:

- a CLI for local/manual iteration
- a small library core
- an MCP server after the first vertical slice works
- file-based cache initially, SQLite later if needed

Do **not** rebuild Octocode primitives first. Treat Octocode as the evidence engine and build the orchestration/scoring/artifact layer on top.

## Acknowledgments

Research Orchestrator stands on the shoulders of:

- **[Octocode](https://github.com/bgauryy/octocode)** — the evidence engine
  this tool is built around, and the project that shaped its architecture.
  Studying Octocode's thin-interface/engine-split design and performance
  characteristics drove the core decision: layer orchestration, scoring, and
  artifact generation on top of a long-lived evidence provider — never
  re-implement code search. Design notes in
  [`docs/SOURCE_NOTES.md`](docs/SOURCE_NOTES.md).
- **[DeepWiki](https://deepwiki.com/)** — optional repo-explanation
  enrichment. Useful when a repo wiki is indexed and fresh; never treated as
  proof — critical claims are always verified against exact source.
- **[Model Context Protocol](https://modelcontextprotocol.io/)** — the MCP
  server (`research.scoreRepos`, `research.explainRepoPattern`,
  `research.writePlanArtifact`) is built on the official MCP TypeScript SDK.
- **[GitHub code search](https://docs.github.com/en/search-github/github-code-search/understanding-github-code-search-syntax)** —
  its practical limits (result caps, rate limits, snippets-aren't-proof)
  directly informed probe sharding, result caching, and the proof-grade
  evidence-anchor model.

## License

[MIT](LICENSE)
