# 07 Data Models

The structures below include compatibility projections. New executions use
`ResearchRunV2`: a versioned brief plus observations, assessments, coverage,
provider outcomes, and a budget ledger. Legacy runs without an
`evidencePolicyVersion` are read as `legacy_unvalidated`; importing old proof
flags never upgrades historical evidence.

## FeatureSpec

```ts
type FeatureSpec = {
  featureKey: string;
  goal: string;
  feature: string;
  goalKind: "application" | "research";
  stack: string[];
  libraries: string[];
  providers: string[];
  mustHave: string[];
  shouldHave: string[];
  exclude: string[];
  requiredConcepts: string[];
  likelyFiles: string[];
  proofRequirements: ProofRequirement[];
};
```

## SearchProbe

```ts
type SearchProbe = {
  id: string;
  kind: "high_precision" | "recall" | "path_targeted" | "repo_search";
  query: string;
  rationale: string;
  expectedSignals: string[];
};
```

## CandidateRepo

```ts
type CandidateRepo = {
  repo: string;
  owner: string;
  name: string;
  defaultBranch?: string;
  url?: string;
  archived?: boolean;
  stars?: number;
  pushedAt?: string;
  discoveredBy: string[];
  matchedPaths: string[];
  candidateSignals: Signal[];
  raw?: unknown;
};
```

## Signal

```ts
type Signal = {
  key: string;
  label: string;
  weight?: number;
  source: "metadata" | "search" | "file" | "deepwiki" | "human" | "mock";
  evidence?: EvidenceAnchor[];
  confidence: number;
};
```

## EvidenceAnchor

```ts
type EvidenceAnchor = {
  id: string;
  provider: "octocode" | "github" | "deepwiki" | "local" | "mock";
  repo?: string;
  ref?: string;
  path: string;
  startLine?: number;
  endLine?: number;
  matchText?: string;
  matchedSignal?: string;
  url?: string;
  role: string;
  proofLevel: "candidate" | "partial" | "proved";
};
```

## ScoredCandidate

```ts
type ScoredCandidate = {
  repo: string;
  score: number;
  class:
    | "production"
    | "reference"
    | "docs"
    | "template"
    | "toy"
    | "false_positive"
    | "unknown";
  positiveSignals: Signal[];
  negativeSignals: Signal[];
  missingProof: string[];
  rejectionReasons: string[];
  nextAction: "reject" | "read_more" | "deepwiki" | "clone" | "extract";
};
```

## RepoPatternExplanation

```ts
type RepoPatternExplanation = {
  repo: string;
  source: "deepwiki" | "octocode_fallback" | "hybrid" | "mock";
  freshness?: {
    checkedAt: string;
    lastIndexedAt?: string;
    indexedCommit?: string;
    stale?: boolean;
  };
  answers: RepoQuestionAnswer[];
  implementationMap: ImplementationMap;
  warnings: string[];
};
```

## RepoQuestionAnswer

```ts
type RepoQuestionAnswer = {
  question: string;
  answer: string;
  evidence: EvidenceAnchor[];
  confidence: number;
  verified: boolean;
};
```

## ImplementationMap

```ts
type ImplementationMap = {
  dependencies: string[];
  files: {
    path: string;
    role: string;
    keyExports?: string[];
    evidence: EvidenceAnchor[];
  }[];
  serverFlow: string[];
  clientFlow: string[];
  environmentVariables: string[];
  routeProtection?: string[];
  tests?: string[];
  pitfalls: string[];
};
```

## ResearchRun

```ts
type ResearchRun = {
  id: string;
  createdAt: string;
  goal: string;
  featureSpec: FeatureSpec;
  probes: SearchProbe[];
  candidates: CandidateRepo[];
  scoredCandidates: ScoredCandidate[];
  selectedRepos: string[];
  explanations: RepoPatternExplanation[];
  artifacts: ArtifactRef[];
  warnings: string[];
};
```

## Research brief and v2 evidence ledger

`ResearchBrief` records the goal, required questions and fact obligations,
intent hints, vocabulary provenance, source kinds, and explicit budgets.
`ResearchRunV2` adds source observations, claim assessments, per-question
coverage, provider outcomes, candidate states, and the final run outcome. See
the matching JSON Schema files in `schemas/`; the schema contract test checks
required keys and enums for every Zod schema exported from `src/schemas/index.ts`.

The mock provider and all committed replay fixtures are synthetic. Their
receipts carry a synthetic origin and are not live repository results.

## ArtifactRef

```ts
type ArtifactRef = {
  path: string;
  kind: "research" | "plan" | "evidence" | "checklist" | "report";
  createdAt: string;
};
```
