# 01 Architecture

## System overview

```text
User goal
  ↓
Feature Spec Normalizer
  ↓
Probe Planner
  ↓
Candidate Collector
  ↓
Candidate Scorer
  ↓
Evidence Reader
  ↓
Repo Explainer
    ├─ DeepWiki adapter, optional
    └─ Octocode fallback adapter
  ↓
Pattern Synthesizer
  ↓
Artifact Writer
  ↓
Research Run Cache
```

## Components

### 1. Feature Spec Normalizer

Converts a user goal into a structured object.

Input:

```text
"Next.js + Convex app with email magic links via Resend"
```

Output:

```json
{
  "featureKey": "next-convex-magic-link-auth",
  "feature": "email magic-link authentication",
  "stack": ["Next.js", "Convex", "@convex-dev/auth"],
  "providers": ["Resend"],
  "requiredConcepts": [
    "convexAuth",
    "Resend provider",
    "useAuthActions",
    "signIn",
    "ConvexAuthNextjsProvider",
    "convexAuthNextjsMiddleware",
    "auth.addHttpRoutes"
  ]
}
```

### 2. Probe Planner

Generates high-precision and high-recall search probes.

Examples:

```text
"convexAuth" "Resend("
"signIn('resend'" "@convex-dev/auth/react"
"convexAuthNextjsMiddleware" "@convex-dev/auth/nextjs/server"
"ConvexAuthNextjsProvider" "ConvexAuthNextjsServerProvider"
"AUTH_RESEND_KEY" "convexAuth"
```

### 3. Candidate Collector

Runs probes against one or more evidence providers.

Initial providers:

```text
OctocodeEvidenceProvider
GitHubEvidenceProvider
MockEvidenceProvider
```

Optional later providers:

```text
LocalIndexProvider
OrgRepoProvider
PackageRegistryProvider
```

### 4. Candidate Scorer

Turns raw candidates into scored candidates.

Inputs:

- repo metadata
- dependency proof
- implementation proof
- file/path evidence
- recency/maintenance signals
- negative signals

Output:

```json
{
  "repo": "owner/repo",
  "score": 0.87,
  "class": "production",
  "positiveSignals": [],
  "negativeSignals": [],
  "missingProof": [],
  "nextAction": "extract"
}
```

### 5. Evidence Reader

Reads exact files or slices.

Evidence is promoted from `candidate` to `proved` only after exact source anchors exist.

### 6. Repo Explainer

Responsible for answering implementation questions.

Adapter interface:

```ts
interface RepoExplainer {
  canExplain(repo: RepoRef): Promise<CapabilityResult>;
  explain(input: ExplainInput): Promise<ExplainOutput>;
}
```

Adapters:

- `DeepWikiExplainer`
- `OctocodeRepoExplainer`
- `MockRepoExplainer`

### 7. Pattern Synthesizer

Extracts a cross-repo implementation pattern.

Output sections:

- files to create/modify
- dependencies
- server wiring
- client wiring
- middleware/routing
- environment variables
- tests
- risks
- deviations between repos
- copy/adapt/avoid guidance

### 8. Artifact Writer

Writes markdown and JSON artifacts.

Required initial artifacts:

```text
research.md
plan.md
evidence.json
implementation-checklist.md
```

### 9. Research Run Cache

The first implementation can use file-based cache.

Suggested shape:

```text
.research-cache/
  runs/
    <run-id>.json
  repos/
    owner__repo.json
  features/
    next-convex-magic-link-auth.json
```

Later, use SQLite if file cache becomes awkward.

## Interfaces

### EvidenceProvider

```ts
interface EvidenceProvider {
  searchCode(probes: SearchProbe[]): Promise<SearchResult[]>;
  searchRepos(query: RepoSearchQuery): Promise<RepoSearchResult[]>;
  getRepoMetadata(repo: RepoRef): Promise<RepoMetadata>;
  getFile(input: FileReadRequest): Promise<FileEvidence>;
  getRepoTree?(repo: RepoRef): Promise<RepoTree>;
  cloneRepo?(repo: RepoRef): Promise<LocalRepoRef>;
}
```

### Scorer

```ts
interface CandidateScorer {
  score(input: ScoreInput): ScoredCandidate;
}
```

### ArtifactWriter

```ts
interface ArtifactWriter {
  writeResearch(run: ResearchRun, outDir: string): Promise<ArtifactRef[]>;
}
```

## Recommended stack

- TypeScript
- Node.js
- Zod for schema validation
- Vitest or equivalent test runner
- Markdown artifacts
- JSON schemas for external contracts
- File-based cache for MVP
- MCP server after CLI vertical slice

## Runtime modes

### Mock mode

Uses fixtures only. Required for tests and coding-agent bootstrapping.

### Offline/local mode

Uses cached research runs and local files.

### Octocode mode

Uses Octocode MCP or CLI/library adapter.

### Hybrid mode

Uses Octocode for evidence and DeepWiki for explanation when available.

## Design rule

Core logic must not depend directly on Octocode, DeepWiki, or GitHub. Core logic depends on interfaces. Provider modules implement those interfaces.
