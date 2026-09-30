> **Synthetic/mock evidence:** fixture observations are not live repository findings.

# Research: email magic-link authentication (PARTIAL)

> ⚠ **This run is PARTIAL.** No fully evidence-backed conclusion was reached.
> The sections below describe what was searched and why proof remained incomplete — they are
> diagnostics, not verified findings. Do not present this as completed research.

## Goal

Next.js + Convex app with email magic links via Resend

## Status

- **Status:** `partial`
- **Reasons:** 1 required question(s) remain unsatisfied., synthetic_evidence
- Candidates evaluated: 2
- Repositories selected: 1
- Evidence anchors: 17

## Summary

Run `run_mock_next_convex_magic_link_auth` evaluated 2 candidate(s), selected
1 repository/repositories, and captured 17
evidence anchor(s), but did not satisfy the complete proof contract. This is
**not** proof that the answer is negative. Treat these artifacts as diagnostics,
not completed findings.

## Question coverage

- `question_dependency_proof`: **satisfied**; supported claims: claim_dependency_proof_headcodecms_headcodecms_next, claim_dependency_proof_headcodecms_headcodecms_convex, claim_dependency_proof_headcodecms_headcodecms__convex-dev_auth, claim_dependency_proof_headcodecms_headcodecms__auth_core, claim_dependency_proof_headcodecms_headcodecms_resend; open obligations: none
- `question_server_auth_proof`: **satisfied**; supported claims: claim_server_auth_proof_headcodecms_headcodecms; open obligations: none
- `question_client_flow_proof`: **unresolved**; supported claims: none; open obligations: Client login flow calls useAuthActions().signIn for email link.
- `question_route_protection_proof`: **satisfied**; supported claims: claim_route_protection_proof_headcodecms_headcodecms; open obligations: none

## Claim assessments

- `claim_dependency_proof_headcodecms_headcodecms_next` (headcodecms/headcodecms, dependency_declaration): **supported** — The parsed declaration matches the package name and literal constraint in the same-subject observation.
- `claim_dependency_proof_headcodecms_headcodecms_convex` (headcodecms/headcodecms, dependency_declaration): **supported** — The parsed declaration matches the package name and literal constraint in the same-subject observation.
- `claim_dependency_proof_headcodecms_headcodecms__convex-dev_auth` (headcodecms/headcodecms, dependency_declaration): **supported** — The parsed declaration matches the package name and literal constraint in the same-subject observation.
- `claim_dependency_proof_headcodecms_headcodecms__auth_core` (headcodecms/headcodecms, dependency_declaration): **supported** — The parsed declaration matches the package name and literal constraint in the same-subject observation.
- `claim_dependency_proof_headcodecms_headcodecms_resend` (headcodecms/headcodecms, dependency_declaration): **supported** — The parsed declaration matches the package name and literal constraint in the same-subject observation.
- `claim_dependency_proof_justinwlin_convex-magic-link-authentication_next` (justinwlin/convex-magic-link-authentication, dependency_declaration): **not_assessed** — No same-repository, matching-revision observation was available for the asserted file.
- `claim_dependency_proof_justinwlin_convex-magic-link-authentication_convex` (justinwlin/convex-magic-link-authentication, dependency_declaration): **not_assessed** — No same-repository, matching-revision observation was available for the asserted file.
- `claim_dependency_proof_justinwlin_convex-magic-link-authentication__convex-dev_auth` (justinwlin/convex-magic-link-authentication, dependency_declaration): **not_assessed** — No same-repository, matching-revision observation was available for the asserted file.
- `claim_dependency_proof_justinwlin_convex-magic-link-authentication__auth_core` (justinwlin/convex-magic-link-authentication, dependency_declaration): **not_assessed** — No same-repository, matching-revision observation was available for the asserted file.
- `claim_dependency_proof_justinwlin_convex-magic-link-authentication_resend` (justinwlin/convex-magic-link-authentication, dependency_declaration): **not_assessed** — No same-repository, matching-revision observation was available for the asserted file.
- `claim_server_auth_proof_headcodecms_headcodecms` (headcodecms/headcodecms, exact_source_quotation): **supported** — One same-subject source observation from the requested path contains every required quotation signal.
- `claim_server_auth_proof_justinwlin_convex-magic-link-authentication` (justinwlin/convex-magic-link-authentication, exact_source_quotation): **unsupported** — The same-subject observations did not pass the Phase 1 exact quotation policy for this assertion.
- `claim_client_flow_proof_headcodecms_headcodecms` (headcodecms/headcodecms, exact_source_quotation): **unsupported** — The same-subject observations did not pass the Phase 1 exact quotation policy for this assertion.
- `claim_client_flow_proof_justinwlin_convex-magic-link-authentication` (justinwlin/convex-magic-link-authentication, exact_source_quotation): **unsupported** — The same-subject observations did not pass the Phase 1 exact quotation policy for this assertion.
- `claim_route_protection_proof_headcodecms_headcodecms` (headcodecms/headcodecms, exact_source_quotation): **supported** — One same-subject source observation from the requested path contains every required quotation signal.
- `claim_route_protection_proof_justinwlin_convex-magic-link-authentication` (justinwlin/convex-magic-link-authentication, exact_source_quotation): **unsupported** — The same-subject observations did not pass the Phase 1 exact quotation policy for this assertion.

## Run outcome

- **partial** — 1 required question(s) remain unsatisfied.; synthetic_evidence

## What was searched

- [high_precision] "convexAuth" "Resend" — Find exact anchors for: Convex auth provider configured with Resend or equivalent email provider.
- [high_precision] "useAuthActions" "signIn('resend'" — Find exact anchors for: Client login flow calls useAuthActions().signIn for email link.
- [high_precision] "convexAuthNextjsMiddleware" "createRouteMatcher" — Find exact anchors for: Middleware/proxy protects routes using Convex auth.
- [recall] "@convex-dev/auth" "Resend" — Find repos combining @convex-dev/auth with Resend, even with unusual formatting.
- [recall] "@auth/core" "Resend" — Find repos combining @auth/core with Resend, even with unusual formatting.
- [path_targeted] "Resend(" path:convex/auth.ts — Find conventional implementations inside convex/auth.ts.
- [path_targeted] "convexAuth" path:convex/http.ts — Find conventional implementations inside convex/http.ts.
- [path_targeted] "Resend(" path:convex/auth.config.ts — Find conventional implementations inside convex/auth.config.ts.
- [path_targeted] "convexAuthNextjsMiddleware" path:middleware.ts — Find conventional implementations inside middleware.ts.
- [repo_search] Next.js Convex email magic-link authentication — Discover repos by name/topic/readme when code search misses.

## Open questions (unresolved)

- Why did this run fail to produce evidence? Inspect the diagnostics and probes.

## Recovery steps

- Inspect research.md "What was searched" to confirm probes targeted the right entities.
- If discovery missed the project, add the official repo/docs URL as an explicit hint or candidate.
- Provide structured hints (requiredConcepts, likelyFiles, proofRequirements) for novel domains.
- Re-run into a new output directory and compare; do not overwrite inconclusive artifacts.

## Diagnostics (warnings)

- none

## Skeptic notes

- A non-complete run must never be presented as completed research.
- Re-run after fixing the highest-priority reason above before drawing any conclusion.
