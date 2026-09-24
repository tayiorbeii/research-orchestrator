# 06 Repository Scoring Rubric

## Candidate classes

| Class | Meaning |
|---|---|
| `production` | Real application/product with nontrivial implementation. |
| `reference` | Focused implementation example or starter that is complete enough to learn from. |
| `docs` | Primarily documentation or guide content. Useful, but not implementation proof. |
| `template` | Starter/template repo. Useful for scaffolding, may hide tradeoffs. |
| `toy` | Minimal demo. Useful for syntax only. |
| `false_positive` | Matches search terms but does not implement the feature. |
| `unknown` | Insufficient evidence. |

## Base scoring

| Signal | Weight |
|---|---:|
| Dependency proof | +20 |
| Multi-file implementation proof | +25 |
| Framework convention proof | +15 |
| Runtime flow proof | +15 |
| Env/deployment docs | +10 |
| Tests or test hooks | +5 |
| Production-shaped repo | +10 |
| Recent maintenance | +5 |
| Docs-only | -25 |
| Toy/minimal demo | -20 |
| Archived repo | -20 |
| No exact evidence | -30 |
| Stale/deprecated dependency | -15 |
| Generated/AI slop indicators | -10 |

## Proof levels

### Level 0: candidate

Search result or repo metadata only.

### Level 1: plausible

Multiple search probes match the same repo.

### Level 2: partial proof

At least one exact file confirms an important dependency or call.

### Level 3: implementation proof

Multiple exact files show the feature across its server/client/config flow.

### Level 4: production proof

Implementation proof plus production-shaped repo and operational details.

## Generic accepted-repo requirements

A repo should not be accepted unless it has:

- at least one dependency/config proof
- at least two implementation anchors
- no unresolved contradiction
- a known candidate class
- missing proof documented

## Magic-link auth proof requirements

For Next.js + Convex + email magic links, score these signals.

### Dependency proof

- `next`
- `convex`
- `@convex-dev/auth`
- `@auth/core` or provider package
- `resend` or `@auth/core/providers/resend`

### Server auth proof

- `convexAuth(...)`
- `Resend(...)` provider or equivalent
- optional callbacks
- user/session creation logic

### HTTP route proof

- `auth.addHttpRoutes(http)`
- Convex HTTP router wiring

### Next.js integration proof

- `ConvexAuthNextjsProvider`
- `ConvexAuthNextjsServerProvider`
- `convexAuthNextjsMiddleware`
- `middleware.ts`, `src/middleware.ts`, or `proxy.ts`

### Client flow proof

- `useAuthActions()`
- `signIn("resend", ...)` or `signIn('resend', ...)`
- redirect/callback handling
- "check your email" state

### Operational proof

- env vars
- JWT/JWKS notes
- email provider key/from address
- production callback URLs
- protected route list

## Score interpretation

| Score | Meaning |
|---:|---|
| 0.85–1.00 | Strong candidate. Extract pattern. |
| 0.70–0.84 | Good candidate. Read missing proof before final plan. |
| 0.50–0.69 | Partial candidate. Useful as supporting evidence only. |
| 0.25–0.49 | Weak candidate. Usually reject or classify as docs/toy. |
| 0.00–0.24 | Reject. |

## Rejection reasons

Use structured rejection reasons:

```json
[
  "no_dependency_proof",
  "no_implementation_files",
  "docs_only",
  "toy_demo",
  "archived",
  "stale_dependency",
  "ambiguous_feature",
  "conflicting_evidence",
  "private_or_unreadable",
  "rate_limited_or_incomplete"
]
```
