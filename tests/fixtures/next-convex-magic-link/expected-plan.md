# Plan: email magic-link authentication

## Objective

Next.js + Convex app with email magic links via Resend

## Recommended approach

Follow the pattern proved by 1 selected repo(s). Dependencies: `next`, `convex`, `@convex-dev/auth`, `@auth/core`, `resend`.

## Files to create or modify

| Path | Role | Action |
|---|---|---|
| `package.json` | dependency manifest | create/modify (proved pattern) |
| `convex/auth.ts` | server auth configuration | create/modify (proved pattern) |
| `convex/http.ts` | http route wiring | create |
| `convex/auth.config.ts` | auth provider config | create |
| `middleware.ts` | route protection | create |
| `proxy.ts` | route protection | create/modify (proved pattern) |
| `src/middleware.ts` | route protection | create |
| `app/(admin)/admin/login/page.tsx` | server_auth_proof | create/modify (proved pattern) |

## Step-by-step implementation

1. Install dependencies: next, convex, @convex-dev/auth, @auth/core, resend.
2. Configure environment variables (names only, values stay in your secret store): AUTH_RESEND_KEY, CONVEX_DEPLOYMENT, NEXT_PUBLIC_CONVEX_URL, CONVEX_SITE_URL, SITE_URL, JWT_PRIVATE_KEY, JWKS.
3. Server: convex/auth.ts exports convexAuth({ providers: [Resend({ ... })] }).
4. Server: convex/http.ts wires auth routes via auth.addHttpRoutes(http).
5. Server: convex/auth.config.ts declares the auth provider domain/application ID.
6. Server: Magic-link email is sent by the Resend provider with a callback URL back to the Convex site.
7. Client: App is wrapped in ConvexAuthNextjsServerProvider (server) and ConvexAuthNextjsProvider (client).
8. Client: Login page calls useAuthActions().signIn("resend", formData) with the user email.
9. Client: UI shows a 'check your email' state after sending the link.
10. Client: Clicking the emailed link completes sign-in and redirects to the app.
11. Routing: middleware.ts / src/middleware.ts / proxy.ts uses convexAuthNextjsMiddleware.
12. Routing: createRouteMatcher defines which routes require authentication.
13. Routing: Unauthenticated users are redirected to the login page.
14. Test: Unit test the login form submit path (email captured, signIn called with 'resend').
15. Test: Integration test that protected routes redirect unauthenticated users.
16. Test: Manual smoke test of the full email round trip.

## Environment variables

- `AUTH_RESEND_KEY` (name only — set the value in your secret store)
- `CONVEX_DEPLOYMENT` (name only — set the value in your secret store)
- `NEXT_PUBLIC_CONVEX_URL` (name only — set the value in your secret store)
- `CONVEX_SITE_URL` (name only — set the value in your secret store)
- `SITE_URL` (name only — set the value in your secret store)
- `JWT_PRIVATE_KEY` (name only — set the value in your secret store)
- `JWKS` (name only — set the value in your secret store)

## Testing plan

- Unit test the login form submit path (email captured, signIn called with 'resend')
- Integration test that protected routes redirect unauthenticated users
- Manual smoke test of the full email round trip

## Rollback plan

- Land the change behind a small, isolated commit series so a single revert removes the feature.
- Keep the previous auth/feature path working until the new flow passes smoke tests.
- Document the env vars added so they can be removed cleanly on rollback.

## Dependencies

- `next`
- `convex`
- `@convex-dev/auth`
- `@auth/core`
- `resend`

## References

- [headcodecms/headcodecms](https://github.com/headcodecms/headcodecms) (production, score 0.85)
  - `app/(admin)/admin/login/page.tsx:14` [server_auth_proof, proved] — `void signIn('resend', formData).then(() => setSent(true));` ([link](https://github.com/headcodecms/headcodecms/blob/main/app/(admin)/admin/login/page.tsx#L14))
  - `app/(admin)/admin/login/page.tsx:2` [client_flow_proof, proved] — `import { useAuthActions } from "@convex-dev/auth/react";` ([link](https://github.com/headcodecms/headcodecms/blob/main/app/(admin)/admin/login/page.tsx#L2))
  - `convex/auth.ts:1` [server_auth_proof, proved] — `import { convexAuth } from "@convex-dev/auth/server";` ([link](https://github.com/headcodecms/headcodecms/blob/main/convex/auth.ts#L1))
  - `package.json:5` [dependency_proof, proved] — `"next": "^15.0.0",` ([link](https://github.com/headcodecms/headcodecms/blob/main/package.json#L5))
  - `proxy.ts:9` [server_auth_proof, proved] — `export default convexAuthNextjsMiddleware(async (request, { convexAuth }) => {` ([link](https://github.com/headcodecms/headcodecms/blob/main/proxy.ts#L9))
  - `proxy.ts:2` [route_protection_proof, proved] — `convexAuthNextjsMiddleware,` ([link](https://github.com/headcodecms/headcodecms/blob/main/proxy.ts#L2))

## Risks

- Missing auth.addHttpRoutes(http) in convex/http.ts silently breaks the callback flow
- AUTH_RESEND_KEY must be set on the Convex deployment, not just the Next.js app
- middleware matcher must exclude static assets and the auth callback routes
