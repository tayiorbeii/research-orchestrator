# Initial Backlog Issues

## Issue 1: Bootstrap TypeScript project

Create package skeleton, test runner, CLI entrypoint, and module layout.

## Issue 2: Define schemas

Implement TypeScript/Zod schemas and align with `schemas/*.json`.

## Issue 3: Implement `normalizeFeatureSpec`

Convert a goal string into a structured feature spec.

## Issue 4: Implement `generateSearchProbes`

Generate high-precision, recall, and path-targeted search probes.

## Issue 5: Implement `MockEvidenceProvider`

Use `examples/sample_research_run.json` to support deterministic tests.

## Issue 6: Implement candidate scoring

Apply rubric from `docs/06_repo_scoring_rubric.md`.

## Issue 7: Implement artifact writer

Write `research.md`, `plan.md`, `evidence.json`, and `implementation-checklist.md`.

## Issue 8: Implement CLI mock flow

Support `research-orchestrator find --goal ... --out ... --mock`.

## Issue 9: Implement provider stubs

Add `OctocodeEvidenceProvider`, `GitHubEvidenceProvider`, and `DeepWikiExplainer`.

## Issue 10: Add MCP server

Expose tools from `docs/08_mcp_tool_spec.md`.

## Issue 11: Add eval harness

Track quality, latency, false positives, and evidence completeness.
