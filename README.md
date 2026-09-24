# Research Orchestrator

**Evidence-grounded implementation research.** Give it a high-level feature
goal — it searches GitHub, scores candidate repositories, reads exact source
evidence, and writes planning artifacts (`research.md`, `plan.md`,
`evidence.json`, `implementation-checklist.md`) you can build from. Runs as a
CLI and as an MCP server, with Octocode as the evidence engine and optional
DeepWiki enrichment.

> "Find examples of a Next.js + Convex app using email magic links, extract
> the implementation pattern, and produce a grounded plan."

becomes a repeatable workflow that:

1. Normalizes the user's goal into a structured feature spec.
2. Generates high-precision and high-recall GitHub/Octocode probes.
3. Collects candidate repositories.
4. Scores candidates based on implementation evidence.
5. Reads exact source evidence.
6. Optionally enriches with DeepWiki when available and fresh.
7. Falls back to Octocode/local repo understanding when DeepWiki is unavailable or stale.
8. Produces reusable planning artifacts with evidence anchors.

## Install

```bash
npm install -g research-orchestrator   # or: npx research-orchestrator
```

Requires Node 20+. Zero configuration for offline mock mode; set Octocode env
for live GitHub evidence (see below).

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
│   ├── core/       # goal normalization, probe generation, pipeline, scoring
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
