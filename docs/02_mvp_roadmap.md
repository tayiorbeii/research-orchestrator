# 02 MVP Roadmap

## Phase 0: Project skeleton

Deliverables:

- TypeScript project
- tests configured
- `src/core/*`
- `src/adapters/*`
- `src/schemas/*`
- mock fixtures
- CLI entrypoint

Acceptance criteria:

- project builds
- tests run
- `--help` works

## Phase 1: Mock vertical slice

Implement:

```text
goal string
  -> normalized FeatureSpec
  -> generated SearchProbe[]
  -> mock candidates
  -> scored candidates
  -> generated artifacts
```

CLI:

```bash
research-orchestrator find \
  --goal "Next.js + Convex app with email magic links via Resend" \
  --out .research/next-convex-magic-link \
  --mock
```

Artifacts:

```text
research.md
plan.md
evidence.json
implementation-checklist.md
```

Acceptance criteria:

- no network required
- deterministic output
- at least 5 unit tests
- scorer classifies candidates correctly

## Phase 2: Real evidence provider boundaries

Implement provider classes, even if some methods are not yet fully wired:

- `OctocodeEvidenceProvider`
- `GitHubEvidenceProvider`
- `DeepWikiExplainer`
- `MockEvidenceProvider`

Acceptance criteria:

- provider interfaces are stable
- unavailable providers return structured configuration errors
- mock provider remains default for tests

## Phase 3: Octocode-backed discovery

Implement a real Octocode adapter.

Initial capabilities:

- search code with probes
- read files
- view repo structure
- optional clone/materialize path

Acceptance criteria:

- can run a discovery flow against public repos
- preserves repo/path/line anchors
- handles pagination warnings
- returns missing-proof entries instead of guessing

## Phase 4: Candidate proof and scoring

Implement proof requirements per feature type.

For magic-link auth, verify:

- dependencies
- provider config
- auth routes
- client sign-in call
- middleware/proxy route protection
- env var references/docs

Acceptance criteria:

- accepted repos have at least 3 evidence anchors
- docs-only repos are not scored as production
- exact source evidence is included in `evidence.json`

## Phase 5: DeepWiki adapter

Implement optional DeepWiki enrichment.

Capabilities:

- check whether a DeepWiki repo page exists
- collect visible freshness/index metadata when available
- collect wiki page/source-file metadata where possible
- return stale/unavailable status clearly
- fallback to Octocode explainer

Acceptance criteria:

- no run depends exclusively on DeepWiki
- stale DeepWiki content triggers fallback verification
- DeepWiki data is labeled as enrichment, not proof, unless verified

## Phase 6: MCP server

Expose tools:

- `research.findImplementations`
- `research.scoreRepos`
- `research.explainRepoPattern`
- `research.writePlanArtifact`

Acceptance criteria:

- MCP tools call core services
- tools use the same schemas as CLI
- mock mode remains supported
- errors are structured and actionable

## Phase 7: Evaluation harness

Add benchmark tasks and metrics.

Metrics:

- wall time
- tool calls
- candidate count
- proved repo count
- false positives
- evidence anchors
- artifact completeness
- human correction count

Acceptance criteria:

- eval can run in mock mode
- real mode can be run manually with credentials/tools
- regression threshold documented

## Post-MVP

Only after the MVP works:

- SQLite cache
- curated ecosystem index
- local repo graph
- web UI
- browser automation for DeepWiki, if stable and allowed
- organization/private repo support
- pattern memory across repeated runs
