# Prompt for Coding Agent

You are working on a new project called **Research Orchestrator**.

## Mission

Build a TypeScript/Node tool that turns high-level implementation research goals into grounded planning artifacts. The tool should use Octocode when available for evidence collection, optionally enrich selected repositories with DeepWiki, and produce structured markdown/JSON artifacts that another coding agent can use to implement a feature.

Example user goal:

> Find public implementations of a Next.js + Convex app that uses email magic links, determine the libraries and files involved, extract the implementation pattern, and generate a plan for adding the feature to my app.

## Read these files first

1. `README.md`
2. `docs/00_project_brief.md`
3. `docs/01_architecture.md`
4. `docs/02_mvp_roadmap.md`
5. `docs/03_research_workflow.md`
6. `docs/08_mcp_tool_spec.md`
7. `docs/12_build_tasks.md`

## Product principle

This is not another code search wrapper. It is a **research workflow engine**.

Octocode should handle evidence primitives:

- GitHub repo/code search
- file reads
- repo tree browsing
- npm package lookup
- clone/materialize if needed
- local search
- structural search
- LSP proof when needed

Research Orchestrator should handle:

- feature spec normalization
- query/probe planning
- candidate repo collection
- candidate scoring
- proof requirements
- DeepWiki enrichment/fallback
- pattern extraction
- artifact writing
- research-run cache
- evaluation harness

## Implementation constraints

Use TypeScript. Prefer small modules with explicit interfaces. Use Zod for runtime validation if available. Keep adapters isolated behind interfaces.

Start with a vertical slice before attempting MCP:

```text
goal string
  -> FeatureSpec
  -> SearchProbe[]
  -> CandidateRepo[]
  -> ScoredCandidate[]
  -> research.md + evidence.json
```

If Octocode MCP is not available in the current environment, create an adapter interface and a mock/in-memory adapter so the project is still testable. Do not block implementation on live GitHub access.

## Recommended initial project structure

```text
src/
  index.ts
  cli.ts
  core/
    normalizeFeatureSpec.ts
    generateSearchProbes.ts
    scoreCandidate.ts
    extractPattern.ts
    writeArtifacts.ts
  adapters/
    EvidenceProvider.ts
    OctocodeEvidenceProvider.ts
    GitHubEvidenceProvider.ts
    DeepWikiExplainer.ts
    MockEvidenceProvider.ts
  schemas/
    featureSpec.ts
    candidateRepo.ts
    evidenceAnchor.ts
    researchRun.ts
  mcp/
    server.ts
    tools/
      findImplementations.ts
      scoreRepos.ts
      explainRepoPattern.ts
      writePlanArtifact.ts
  cache/
    FileResearchCache.ts
  eval/
    benchmarkTasks.ts
    runEval.ts
tests/
  normalizeFeatureSpec.test.ts
  generateSearchProbes.test.ts
  scoreCandidate.test.ts
  writeArtifacts.test.ts
```

## First milestone

Implement a CLI command:

```bash
research-orchestrator find \
  --goal "Next.js + Convex app with email magic links via Resend" \
  --out .research/next-convex-magic-link \
  --mock
```

The `--mock` flow should use `examples/sample_research_run.json` to produce:

```text
.research/next-convex-magic-link/
  research.md
  plan.md
  evidence.json
  implementation-checklist.md
```

## Second milestone

Implement real adapter stubs with clear boundaries:

- `OctocodeEvidenceProvider`
- `DeepWikiExplainer`
- `GitHubEvidenceProvider`

The first real provider can still throw a helpful "not configured" error if credentials/tools are unavailable. Keep the interfaces stable.

## Third milestone

Expose MCP tools:

- `research.findImplementations`
- `research.scoreRepos`
- `research.explainRepoPattern`
- `research.writePlanArtifact`

Use the schemas in `docs/08_mcp_tool_spec.md` and `schemas/*.json` as the contract.

## Non-goals for the first pass

Do not build:

- a full code indexer
- a custom semantic search engine
- an embedding database
- a browser automation dependency for DeepWiki as the only path
- a full replacement for Octocode
- a web UI

## Acceptance criteria

The initial implementation is acceptable when:

1. `npm test` or equivalent test command passes.
2. The mock CLI flow writes all four expected artifacts.
3. The scorer can classify at least these candidate types:
   - production
   - reference
   - docs
   - template
   - toy
   - false_positive
4. Every accepted repo in generated artifacts includes evidence anchors.
5. The code is organized so real Octocode/DeepWiki providers can be added without rewriting core logic.
6. Security/privacy rules are enforced in artifact writing:
   - no token values
   - no secret values
   - env var names allowed, values redacted
   - public repo links allowed
   - private repo content should not be persisted by default

## Development style

Work in small increments. After each increment, run tests and update the generated artifacts. Prefer a simple working implementation over a highly abstract one.

When uncertain, preserve the interface and return a structured `warning` or `missingProof` entry rather than guessing.
