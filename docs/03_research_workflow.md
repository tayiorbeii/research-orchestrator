# 03 Research Workflow

## Workflow summary

```text
1. Normalize the feature
2. Generate probes
3. Search broadly
4. Deduplicate repos
5. Score candidates cheaply
6. Read exact evidence for promising candidates
7. Enrich with DeepWiki if useful
8. Fall back to Octocode/local proof
9. Extract implementation pattern
10. Write artifacts
11. Run skeptic pass
12. Finalize plan
```

## Stage 1: Normalize the feature

Input:

```text
"Find examples of a Next.js + Convex app that uses email magic links."
```

Output:

```json
{
  "feature": "email magic-link authentication",
  "stack": ["Next.js", "Convex"],
  "libraries": ["@convex-dev/auth"],
  "providers": ["Resend"],
  "requiredProof": [
    "dependency proof",
    "provider config",
    "auth route wiring",
    "Next.js provider setup",
    "client sign-in flow",
    "route protection",
    "environment variables"
  ]
}
```

## Stage 2: Generate probes

Generate at least three categories.

### High precision

Find exact implementation anchors.

```text
"convexAuth" "Resend("
"signIn('resend'" "@convex-dev/auth/react"
"convexAuthNextjsMiddleware" "@convex-dev/auth/nextjs/server"
```

### Recall

Find likely repos that may use different formatting.

```text
"@convex-dev/auth" "Resend"
"@auth/core/providers/resend" "convex"
"magic link" "convex"
```

### Path-targeted

Find conventional files.

```text
"Resend(" path:convex/auth.ts
"convexAuth(" path:convex/auth.ts
"convexAuthNextjsMiddleware" path:middleware.ts
"convexAuthNextjsMiddleware" path:proxy.ts
```

## Stage 3: Collect candidates

For every result:

- parse `owner/repo`
- record source probe
- record matched path
- record snippet if present
- do not treat snippets as proof yet

## Stage 4: Cheap score

Before reading many files, score from:

- number of independent probes matching repo
- paths matched
- package names visible
- repo metadata
- archived/non-archived status
- docs-only indicators
- size/stars/updated if available

## Stage 5: Proof read

For the top candidates, read exact files.

Recommended order:

1. `package.json`
2. likely auth config file
3. middleware/proxy file
4. login page file
5. app provider/layout file
6. README/env docs
7. tests if present

## Stage 6: Score again

Promote only claims backed by exact evidence.

Classify:

- production
- reference
- docs
- template
- toy
- false positive
- unknown

## Stage 7: DeepWiki enrichment

For top candidates:

1. Check whether DeepWiki page exists.
2. Check freshness/index metadata if available.
3. Ask/extract high-level repo explanation if stable.
4. Verify any critical implementation claim with Octocode exact file reads.

## Stage 8: Fallback explainer

If DeepWiki is unavailable or stale:

```text
repo tree
  -> targeted code search
  -> exact file reads
  -> local clone if needed
  -> local search / AST / LSP if needed
  -> question-specific explanation
```

## Stage 9: Pattern extraction

Extract:

- dependencies
- files to create/modify
- server-side wiring
- client-side wiring
- route protection
- env vars
- edge cases
- tests
- implementation steps
- copy/adapt/avoid guidance

## Stage 10: Artifact writing

Write:

```text
research.md
plan.md
evidence.json
implementation-checklist.md
```

## Stage 11: Skeptic pass

The skeptic should ask:

- Is every accepted repo actually implementing the feature?
- Are any docs-only repos misclassified?
- Are critical claims backed by exact evidence?
- Did the workflow confuse similar libraries?
- Did it miss route protection?
- Did it miss env/config requirements?
- Did it rely on stale DeepWiki content?
- Are any copied patterns outdated or unsafe?

## Progressive cost ladder

```text
Level 0: repo metadata only
Level 1: code search snippets
Level 2: exact file slices
Level 3: repo tree + package manifests
Level 4: selected implementation files
Level 5: sparse clone
Level 6: AST/LSP
Level 7: PR/history
Level 8: tests/build/run
```

Do not escalate unless needed.

## Stop conditions

Reject if:

- no dependency proof
- no implementation proof
- only docs mention the feature
- repo is archived and no better candidates exist
- evidence is stale or ambiguous
- code uses a deprecated package or pattern without a strong reason

Accept if:

- dependency proof exists
- at least two implementation files prove the flow
- exact source anchors exist
- candidate class is known
- missing proof is documented
