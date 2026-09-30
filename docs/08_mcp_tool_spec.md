# 08 MCP Tool Specification

## Tool: `research.findImplementations`

### Purpose

Find, score, and optionally prove repositories that implement a requested feature.

### Input

```ts
type FindImplementationsInput = {
  goal?: string;
  brief?: ResearchBrief;
  resumeRunId?: string;
  budgetOverrides?: Partial<BudgetLimits>;
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

Supply exactly one of `goal` or `brief`. Goal input uses the same conservative
brief adapter as the CLI. A resume requires a brief revision and carries prior
engine consumption forward; any larger limit must be explicit in that brief or
in `budgetOverrides`. The returned run includes its brief, compiled probes,
per-probe outcomes, and budget ledger. Mock mode is the default and produces
synthetic fixture evidence; request `octocode` or `github` explicitly for live
providers. Provider selection is never silently changed.

### Output

```ts
type FindImplementationsOutput = {
  runId: string;
  mode: "mock" | "octocode" | "github" | "hybrid";
  provider: string;
  evidenceOrigin: "repository_observation" | "synthetic_mock" | "legacy_unvalidated";
  featureSpec: FeatureSpec;
  probes: SearchProbe[];
  candidates: CandidateRepo[];
  scoredCandidates: ScoredCandidate[];
  selectedRepos: string[];
  schemaVersion: 2;
  warnings: string[];
  observations: SourceObservation[];
  assessments: ClaimAssessment[];
  coverage: QuestionCoverage[];
  outcome: RunOutcome;
  candidateStates: CandidateState[];
  explanationResults: RepoExplanationResult[];
  evidence: EvidenceAnchor[];
  brief?: ResearchBrief;
  compiledProbes?: SearchProbeV2[];
  probeOutcomes?: ProbeOutcome[];
  budgetLedger?: BudgetLedger;
  parentRunId?: string;
};
```

The types above are compatibility-oriented projections. A full v2 run also
includes its `schemaVersion`, `evidencePolicyVersion`, `providerName`,
`candidateStates`, and `explanationResults`. Supported claims are tied to the
listed observation IDs and evidence policy; ranking and `selectedRepos` do not
grant support. Inline artifact input is treated as external evidence and
cannot be upgraded by the writer.

## Tool: `research.planResearch`

Accepts a `goal` plus optional request hints, or an existing `brief`. A brief
may be paired with a `submission` to return a new revision. Returns the brief,
readiness, and question-scoped `needs` containing `questionId`, `need`,
`suggestedSourceKinds`, and `remainingAllowance`. Planning does not call a
research provider.

```ts
type VocabularySubmission = {
  terms: VocabularyTerm[];
  lookupOutcomes: Array<{
    questionId: string;
    sourceRef: string;
    status: "succeeded" | "failed";
    termIdsGained: string[];
    detail?: string;
  }>;
};
```

Observed terms must cite a source reference from a successful outcome for the
same question. Other terms remain proposed hypotheses. Failed/denied lookups
are retained as gaps, and submitted content cannot change original question
statements, budgets, source allowlists, or egress policy. The resulting brief
includes incremented revision and parent lineage. `research.planResearch` also
accepts the `request.localArtifacts` paths or snippets described in the CLI
workflow; private local fingerprints remain restricted from probes by default.

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

### Trust boundary

Inline `researchRun` records use the same artifact and receipt derivation as cached runs, but all inline observations and assessments are treated as `external`, so they cannot acquire engine-supported status. Pass a cached `runId` to render engine-verified receipts. The cache boundary preserves provenance recorded by the research pipeline; inline input is never promoted by this tool.

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

Provider and validation errors are returned with structured codes where the
tool contract supports them. Do not assume all tools share the sample union
below; inspect each tool's current Zod input/output schema.

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
