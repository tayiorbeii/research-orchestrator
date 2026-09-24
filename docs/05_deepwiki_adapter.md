# 05 DeepWiki Adapter

## Role

DeepWiki is an optional repo-explanation accelerator. It should help answer high-level implementation questions about a selected repository, but it should not be the sole source of proof.

## Adapter principle

```text
DeepWiki explains.
Octocode verifies.
```

## Adapter interface

```ts
interface RepoExplainer {
  canExplain(repo: RepoRef): Promise<CapabilityResult>;
  explain(input: ExplainInput): Promise<ExplainOutput>;
}
```

## Capability result

```ts
type CapabilityResult = {
  provider: "deepwiki";
  available: boolean;
  indexed?: boolean;
  lastIndexedAt?: string;
  indexedCommit?: string;
  stale?: boolean;
  reason?: string;
};
```

## Explain input

```ts
type ExplainInput = {
  repo: RepoRef;
  feature: FeatureSpec;
  questions: string[];
  freshnessPolicy?: {
    maxAgeDays?: number;
    requireCommitCheck?: boolean;
  };
};
```

## Explain output

```ts
type ExplainOutput = {
  provider: "deepwiki" | "octocode-fallback" | "hybrid";
  repo: string;
  answers: RepoQuestionAnswer[];
  freshness?: CapabilityResult;
  warnings: string[];
};
```

## Freshness policy

Default:

```json
{
  "maxAgeDays": 30,
  "fallbackWhenStale": true,
  "verifyCriticalClaimsWithOctocode": true
}
```

## Questions to ask per repo

1. Where is this feature wired from entry point to provider/client?
2. Which files define provider/configuration?
3. Which files define route protection or middleware?
4. Which client components call the auth/action API?
5. Which environment variables are required?
6. What redirect/callback flow is used?
7. What edge cases or pitfalls are visible?
8. What should be copied, adapted, or avoided?
9. Which parts are framework-specific versus library-specific?
10. What tests or test hooks exist?

## Fallback triggers

Use Octocode fallback if:

- DeepWiki page does not exist.
- DeepWiki is stale.
- DeepWiki provides no clear source files.
- DeepWiki answer lacks enough grounding.
- The repo is private.
- The user requests exact source proof.
- Browser/UI automation is unavailable.
- DeepWiki terms or stability make automation unsafe.

## Fallback flow

```text
ghViewRepoStructure
  -> ghSearchCode for anchors
  -> ghGetFileContent for exact slices
  -> ghCloneRepo if many files or AST/LSP needed
  -> localSearchCode / structural / LSP
  -> synthesize answers
```

## Avoid

Do not make DeepWiki a hard dependency. Do not scrape brittle UI state as the only implementation path. Do not trust high-level explanation without checking exact repo evidence for critical claims.

## Hybrid output model

Critical claims should include a verification status.

```json
{
  "claim": "The repo uses Resend as the Convex Auth email provider.",
  "fromDeepWiki": true,
  "verifiedWithExactSource": true,
  "evidence": [
    {
      "repo": "owner/repo",
      "path": "convex/auth.ts",
      "startLine": 12,
      "endLine": 25
    }
  ]
}
```
