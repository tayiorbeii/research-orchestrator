# 08 MCP Tool Specification

## Tool: `research.findImplementations`

### Purpose

Find, score, and optionally prove repositories that implement a requested feature.

### Input

```ts
type FindImplementationsInput = {
  goal: string;
  stack?: string[];
  mustHave?: string[];
  shouldHave?: string[];
  exclude?: string[];
  language?: string;
  maxCandidates?: number;
  maxReposToProve?: number;
  mode?: "mock" | "octocode" | "github" | "hybrid";
  deepwiki?: {
    enabled?: boolean;
    maxAgeDays?: number;
    fallbackToOctocode?: boolean;
  };
};
```

### Output

```ts
type FindImplementationsOutput = {
  runId: string;
  featureSpec: FeatureSpec;
  probes: SearchProbe[];
  candidates: CandidateRepo[];
  scoredCandidates: ScoredCandidate[];
  selectedRepos: string[];
  warnings: string[];
};
```

## Tool: `research.scoreRepos`

### Purpose

Score existing candidates against a feature spec.

### Input

```ts
type ScoreReposInput = {
  featureSpec: FeatureSpec;
  candidates: CandidateRepo[];
  evidencePolicy?: "metadata" | "file_slices" | "deep_proof";
};
```

### Output

```ts
type ScoreReposOutput = {
  scoredCandidates: ScoredCandidate[];
  summary: {
    accepted: number;
    rejected: number;
    needsMoreEvidence: number;
  };
};
```

## Tool: `research.explainRepoPattern`

### Purpose

Answer implementation questions for one or more selected repositories.

### Input

```ts
type ExplainRepoPatternInput = {
  featureSpec: FeatureSpec;
  repos: string[];
  questions?: string[];
  preferDeepWiki?: boolean;
  fallbackToOctocode?: boolean;
  maxFiles?: number;
};
```

### Output

```ts
type ExplainRepoPatternOutput = {
  explanations: RepoPatternExplanation[];
  warnings: string[];
};
```

## Tool: `research.writePlanArtifact`

### Purpose

Write markdown/JSON artifacts from a research run.

### Input

```ts
type WritePlanArtifactInput = {
  runId?: string;
  researchRun?: ResearchRun;
  outDir: string;
  formats?: ("research_md" | "plan_md" | "evidence_json" | "checklist_md")[];
  targetProject?: {
    stack?: string[];
    constraints?: string[];
    existingFiles?: string[];
  };
};
```

### Output

```ts
type WritePlanArtifactOutput = {
  artifacts: ArtifactRef[];
  summary: string;
  unresolvedQuestions: string[];
};
```

## Error model

Every tool should return structured errors.

```ts
type ResearchError = {
  code:
    | "provider_not_configured"
    | "rate_limited"
    | "no_results"
    | "incomplete_results"
    | "deepwiki_unavailable"
    | "invalid_feature_spec"
    | "artifact_write_failed";
  message: string;
  recoverable: boolean;
  suggestedAction?: string;
};
```

## MCP design notes

- Keep tools idempotent when possible.
- Avoid writing artifacts unless the user calls `writePlanArtifact` or passes `outDir`.
- Include warnings rather than hiding uncertainty.
- Do not return giant file contents through MCP responses.
- Prefer artifact files for large outputs.
- Preserve evidence anchors in JSON for downstream agents.

## Suggested schemas

Use the JSON schemas in `schemas/` as the public contract.
