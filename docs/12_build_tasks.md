# 12 Build Tasks

## Task 1: Bootstrap project

Create a TypeScript project with:

- CLI entrypoint
- core modules
- adapter interfaces
- schemas
- test runner
- lint/format scripts if available

Acceptance:

- `npm test` passes
- `npm run build` passes, or equivalent
- CLI has `--help`

## Task 2: Implement schemas

Implement Zod schemas or TypeScript types for:

- `FeatureSpec`
- `SearchProbe`
- `CandidateRepo`
- `EvidenceAnchor`
- `ScoredCandidate`
- `ResearchRun`
- `PlanArtifact`

Acceptance:

- schemas match `schemas/*.json`
- invalid sample input fails validation
- valid sample input passes validation

## Task 3: Feature normalization

Implement:

```ts
normalizeFeatureSpec(goal: string, hints?: Partial<FeatureSpec>): FeatureSpec
```

Acceptance:

- magic-link example produces expected key concepts
- stack hints are preserved
- generated feature key is stable
- tests cover at least three goal strings

## Task 4: Probe generation

Implement:

```ts
generateSearchProbes(featureSpec: FeatureSpec): SearchProbe[]
```

Acceptance:

- generates high-precision, recall, and path-targeted probes
- probes are deterministic
- magic-link example includes Convex/Resend/auth probes

## Task 5: Mock evidence provider

Implement `MockEvidenceProvider` using `examples/sample_research_run.json`.

Acceptance:

- returns deterministic candidates
- can return mock file evidence
- supports no network

## Task 6: Candidate scoring

Implement:

```ts
scoreCandidate(featureSpec: FeatureSpec, candidate: CandidateRepo, evidence: EvidenceAnchor[]): ScoredCandidate
```

Acceptance:

- classifies production/reference/docs/toy/false-positive
- applies negative signals
- requires exact evidence before high score
- tests include at least six candidate cases

## Task 7: Artifact writer

Implement:

```ts
writeArtifacts(run: ResearchRun, outDir: string): Promise<ArtifactRef[]>
```

Acceptance:

- writes `research.md`
- writes `plan.md`
- writes `evidence.json`
- writes `implementation-checklist.md`
- redacts secret-like values

## Task 8: CLI vertical slice

Implement:

```bash
research-orchestrator find --goal "..." --out <dir> --mock
```

Acceptance:

- writes all artifacts
- prints output paths
- exits nonzero for invalid args
- no network required

## Task 9: Provider stubs

Implement:

- `OctocodeEvidenceProvider`
- `GitHubEvidenceProvider`
- `DeepWikiExplainer`

Acceptance:

- clear constructor config
- structured not-configured errors
- no core logic changes needed to swap providers

## Task 10: MCP tools

Implement MCP server after CLI works.

Tools:

- `research.findImplementations`
- `research.scoreRepos`
- `research.explainRepoPattern`
- `research.writePlanArtifact`

Acceptance:

- tools use core functions
- tools support mock mode
- tools return structured output
- large artifacts are written to files, not dumped into responses

## Task 11: Eval harness

Implement benchmark runner.

Acceptance:

- mock benchmarks run
- metrics are saved as JSON
- artifact completeness rubric is represented
- benchmark task list is extensible
