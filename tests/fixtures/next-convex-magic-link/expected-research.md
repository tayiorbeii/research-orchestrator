# Research: email magic-link authentication

## Goal

Next.js + Convex app with email magic links via Resend

## Summary

Run `run_mock_next_convex_magic_link_auth` evaluated 2 candidate repo(s) against 4 proof requirement(s), selected 1 repo(s), and captured 7 evidence anchor(s) (6 proved).

## Selected repositories

| Repo | Class | Score | Why selected |
|---|---:|---:|---|
| [headcodecms/headcodecms](https://github.com/headcodecms/headcodecms) | production | 0.85 | dependency_proof, multi_file_implementation, framework_convention_proof, runtime_flow_proof |

## Candidate analysis

### headcodecms/headcodecms
- Class: `production` — Score: **0.85** — Next action: `extract`
- Positive signals: dependency_proof, multi_file_implementation, framework_convention_proof, runtime_flow_proof, production_shaped
- Negative signals: none
- Evidence anchors: 6
- Missing proof: none

### justinwlin/convex-magic-link-authentication
- Class: `docs` — Score: **0.00** — Next action: `reject`
- Positive signals: env_deployment_docs
- Negative signals: docs_only, no_exact_evidence
- Evidence anchors: 1
- Missing proof:
  - dependency_proof: package.json proves Next.js, Convex, Convex Auth, and email provider dependencies.
  - server_auth_proof: Convex auth provider configured with Resend or equivalent email provider.
  - client_flow_proof: Client login flow calls useAuthActions().signIn for email link.
  - route_protection_proof: Middleware/proxy protects routes using Convex auth.
- Rejection reasons: docs_only, no_dependency_proof, no_implementation_files

## Implementation pattern

**Server flow**
- convex/auth.ts exports convexAuth({ providers: [Resend({ ... })] })
- convex/http.ts wires auth routes via auth.addHttpRoutes(http)
- convex/auth.config.ts declares the auth provider domain/application ID
- Magic-link email is sent by the Resend provider with a callback URL back to the Convex site

**Client flow**
- App is wrapped in ConvexAuthNextjsServerProvider (server) and ConvexAuthNextjsProvider (client)
- Login page calls useAuthActions().signIn("resend", formData) with the user email
- UI shows a 'check your email' state after sending the link
- Clicking the emailed link completes sign-in and redirects to the app

**Route protection**
- middleware.ts / src/middleware.ts / proxy.ts uses convexAuthNextjsMiddleware
- createRouteMatcher defines which routes require authentication
- Unauthenticated users are redirected to the login page

## Evidence map

### headcodecms/headcodecms

- `app/(admin)/admin/login/page.tsx:14` [server_auth_proof, proved] — `void signIn('resend', formData).then(() => setSent(true));` ([link](https://github.com/headcodecms/headcodecms/blob/main/app/(admin)/admin/login/page.tsx#L14))
- `app/(admin)/admin/login/page.tsx:2` [client_flow_proof, proved] — `import { useAuthActions } from "@convex-dev/auth/react";` ([link](https://github.com/headcodecms/headcodecms/blob/main/app/(admin)/admin/login/page.tsx#L2))
- `convex/auth.ts:1` [server_auth_proof, proved] — `import { convexAuth } from "@convex-dev/auth/server";` ([link](https://github.com/headcodecms/headcodecms/blob/main/convex/auth.ts#L1))
- `package.json:5` [dependency_proof, proved] — `"next": "^15.0.0",` ([link](https://github.com/headcodecms/headcodecms/blob/main/package.json#L5))
- `proxy.ts:9` [server_auth_proof, proved] — `export default convexAuthNextjsMiddleware(async (request, { convexAuth }) => {` ([link](https://github.com/headcodecms/headcodecms/blob/main/proxy.ts#L9))
- `proxy.ts:2` [route_protection_proof, proved] — `convexAuthNextjsMiddleware,` ([link](https://github.com/headcodecms/headcodecms/blob/main/proxy.ts#L2))

## Libraries and dependencies

- `next`
- `convex`
- `@convex-dev/auth`
- `@auth/core`
- `resend`

## Files likely needed in target project

- `package.json` — dependency manifest (proved in 1 anchor)
- `convex/auth.ts` — server auth configuration (proved in 1 anchor)
- `convex/http.ts` — http route wiring
- `convex/auth.config.ts` — auth provider config
- `middleware.ts` — route protection
- `proxy.ts` — route protection (proved in 2 anchors)
- `src/middleware.ts` — route protection
- `app/(admin)/admin/login/page.tsx` — server_auth_proof (proved in 1 anchor)

## Pitfalls and edge cases

- Missing auth.addHttpRoutes(http) in convex/http.ts silently breaks the callback flow
- AUTH_RESEND_KEY must be set on the Convex deployment, not just the Next.js app
- middleware matcher must exclude static assets and the auth callback routes
- Magic-link callback URL must match the deployed site URL in production
- Do not confuse @convex-dev/auth with next-auth adapters — the wiring differs

## Open questions

- None outstanding.

## Skeptic notes

- Verify every accepted repo actually implements the feature end to end.
- Confirm no docs-only repo was misclassified as implementation proof.
- Re-check anchors against live repository contents before relying on them.

