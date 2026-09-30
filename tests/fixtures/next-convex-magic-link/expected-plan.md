> **Synthetic/mock evidence:** fixture observations are not live repository findings.

# Plan: email magic-link authentication — PARTIAL (no evidence-backed plan)

> ⚠ No implementation plan is safe until the proof contract is complete. This
> file lists recovery actions, not steps to implement. Do not build from it.

## Objective

Next.js + Convex app with email magic links via Resend

## Status: inconclusive

Reasons: 1 required question(s) remain unsatisfied., synthetic_evidence

## Why there is no plan

The run selected 1 repository/repositories and captured
17 evidence anchor(s) (17 exact-quotation supports), but the proof contract
is still incomplete. Source quotations establish only what a source states; they do not establish runtime behavior.
No implementation steps are established. Resolve the reasons above and re-run before implementing.

## Recovery actions

1. Inspect research.md "What was searched" to confirm probes targeted the right entities.
2. If discovery missed the project, add the official repo/docs URL as an explicit hint or candidate.
3. Provide structured hints (requiredConcepts, likelyFiles, proofRequirements) for novel domains.
4. Re-run into a new output directory and compare; do not overwrite inconclusive artifacts.

## Probes attempted

- [high_precision] "convexAuth" "Resend"
- [high_precision] "useAuthActions" "signIn('resend'"
- [high_precision] "convexAuthNextjsMiddleware" "createRouteMatcher"
- [recall] "@convex-dev/auth" "Resend"
- [recall] "@auth/core" "Resend"
- [path_targeted] "Resend(" path:convex/auth.ts
- [path_targeted] "convexAuth" path:convex/http.ts
- [path_targeted] "Resend(" path:convex/auth.config.ts
- [path_targeted] "convexAuthNextjsMiddleware" path:middleware.ts
- [repo_search] Next.js Convex email magic-link authentication

## References

- [headcodecms/headcodecms](https://github.com/headcodecms/headcodecms) (partially supported; do not implement yet)
