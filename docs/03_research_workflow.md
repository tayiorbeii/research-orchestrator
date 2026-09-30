# 03 Research Workflow

## Current brief-first execution

The v2 path is the authoritative workflow. `plan` creates or revises a
`ResearchBrief`; `find --brief` executes its required questions, obligations,
source policy, and budgets. Results preserve observations, claim assessments,
question coverage, provider outcomes, and budget consumption in a v2 run.
Candidate ranking and selected repository lists are discovery aids, not proof.
Only claims supported by the run's same-subject source observations are
reported as supported.

## Workflow summary

The brief workflow has two explicit operations: `plan` drafts/revises a
bounded brief, then `find --brief` executes that brief through the configured
provider. Planning reports `needs_input` and question-scoped vocabulary work
when the request lacks grounded terms or a bounded evidence scope; it does not
claim a web lookup occurred. A host can perform authorized lookups and submit
source references, acquired terms, and failed lookup outcomes in a revised
brief before execution. The host's external lookup cost is provenance, not
engine-measured budget consumption.

An abstract request returns `readiness.status: "needs_input"` with a `lookupNeeds`
entry for each affected question: the kind of lookup needed, suggested source
kinds, and the remaining reconnaissance allowance. Submit `{ "terms": [],
"lookupOutcomes": [] }` to `plan --brief ... --submit ...` after the host lookup.
Terms become `observed` only when `sourceRefs` cite a successful submitted
lookup; unsourced terms remain visible `planner_hypothesis` proposals. Submit
failed or denied attempts as `status: "failed"`; they remain planning gaps and
never mean a capability is absent. A revision records its parent id/revision,
keeps the original question statements fixed, and can be passed to `find` only
when ready.

`plan --request` may also name explicit `localArtifacts` paths or inline
`snippets`. The planner reads only those paths and extracts narrow import, API,
configuration, and CLI fingerprints. Sensitive literals and user identifiers
are redacted or omitted before terms are created. Private package names and
internal symbols carry `egress: "restricted"`; they are omitted from outbound
probes unless `egressPolicy.allowRestrictedLocalTerms` is explicitly true.

```sh
research-orchestrator plan --request request.json --out brief.json
research-orchestrator plan --brief brief.json --submit submission.json --out revised-brief.json
research-orchestrator find --brief brief.json --out .research/run --mode mock
research-orchestrator find --resume RUN_ID --brief revised-brief.json --out .research/resume --mode mock
```

`find --goal` remains as a compatibility adapter, but now uses the same brief
engine. Its conservative vocabulary policy intentionally tightens behavior:
unsupported vague goals return `needs_input` instead of generating generic
searches. The selected provider mode stays visible; an explicit live mode never
falls back to mock. Mock runs are synthetic fixtures and are labeled as such.

## Compatibility staged workflow

The following stages describe the original candidate-oriented flow. They remain
useful as a high-level explanation of discovery, but they are not the v2 proof
contract. In particular, ranking scores, snippets, keyword overlap, and
incoming confidence do not verify claims.

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
