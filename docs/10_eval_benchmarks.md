# 10 Evaluation Benchmarks

## Purpose

Measure whether Research Orchestrator produces better implementation plans with less wasted context and fewer false positives.

## Benchmark lanes

| Lane | Description |
|---|---|
| `octocode_only` | Agent manually uses Octocode tools. |
| `orchestrator_mock` | Mock deterministic flow. |
| `orchestrator_octocode` | Orchestrator using Octocode provider. |
| `orchestrator_hybrid` | Octocode plus DeepWiki enrichment. |
| `custom_github` | Direct GitHub provider where available. |

## Metrics

```ts
type ResearchRunMetrics = {
  taskId: string;
  lane: string;
  wallMs: number;
  toolCalls: number;
  providerCalls: number;
  tokensIn?: number;
  tokensOut?: number;
  candidateRepos: number;
  provedRepos: number;
  falsePositiveRepos: number;
  exactEvidenceAnchors: number;
  artifactCompletenessScore: number;
  humanCorrectionCount: number;
};
```

## Initial benchmark tasks

1. Next.js + Convex + Resend magic links.
2. Next.js + Convex + Clerk organizations.
3. Next.js + Resend contact form/server action.
4. Convex + Stripe checkout.
5. Convex + file upload/storage.
6. Hono + OpenAPI + Zod validation.
7. Next.js middleware auth protection.
8. Trigger.dev background job from a web app.
9. Supabase magic link auth in App Router.
10. Email verification flow with Resend.

## Completeness rubric

Score each artifact 0–5.

| Score | Meaning |
|---:|---|
| 0 | No useful plan. |
| 1 | Generic plan with no evidence. |
| 2 | Some relevant repos but weak proof. |
| 3 | Good evidence but missing key implementation steps. |
| 4 | Strong plan with exact evidence and minor gaps. |
| 5 | Implementation-ready plan with evidence, risks, tests, and clear steps. |

## Acceptance targets

- Mock flow completeness score >= 4.
- Real flow completeness score >= 4 on at least 6 of 10 benchmark tasks.
- False-positive rate under 25%.
- Every accepted repo has at least three evidence anchors.
- Discovery under 45 seconds for top 10 candidates.
- Deep proof under 3 minutes for top 3 repos.

## Regression tests

Create golden output snapshots for mock runs:

```text
tests/fixtures/next-convex-magic-link/
  expected-research.md
  expected-evidence.json
  expected-plan.md
```

The exact prose may change, but the core sections and evidence counts should be stable.

## Human evaluation questions

Ask the reviewer:

1. Would you trust this plan enough to start implementation?
2. What key implementation detail is missing?
3. Which repo evidence was most useful?
4. Which repo should have been rejected?
5. What did the system overclaim?
6. What should the next research pass ask?
