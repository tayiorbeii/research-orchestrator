# Implementation Checklist: email magic-link authentication

## Dependencies
- [ ] Install or verify `next`.
- [ ] Install or verify `convex`.
- [ ] Install or verify `@convex-dev/auth`.
- [ ] Install or verify `@auth/core`.
- [ ] Install or verify `resend`.

## Environment
- [ ] Set `AUTH_RESEND_KEY` (name only; store the value in your secret store).
- [ ] Set `CONVEX_DEPLOYMENT` (name only; store the value in your secret store).
- [ ] Set `NEXT_PUBLIC_CONVEX_URL` (name only; store the value in your secret store).
- [ ] Set `CONVEX_SITE_URL` (name only; store the value in your secret store).
- [ ] Set `SITE_URL` (name only; store the value in your secret store).
- [ ] Set `JWT_PRIVATE_KEY` (name only; store the value in your secret store).
- [ ] Set `JWKS` (name only; store the value in your secret store).

## Files to create or modify
- [ ] `package.json` — dependency manifest (follow the proved pattern from 1 anchor).
- [ ] `convex/auth.ts` — server auth configuration (follow the proved pattern from 1 anchor).
- [ ] `convex/http.ts` — http route wiring (no direct proof; verify against the selected repos).
- [ ] `convex/auth.config.ts` — auth provider config (no direct proof; verify against the selected repos).
- [ ] `middleware.ts` — route protection (no direct proof; verify against the selected repos).
- [ ] `proxy.ts` — route protection (follow the proved pattern from 2 anchors).
- [ ] `src/middleware.ts` — route protection (no direct proof; verify against the selected repos).
- [ ] `app/(admin)/admin/login/page.tsx` — server_auth_proof (follow the proved pattern from 1 anchor).

## Implementation flow
- [ ] Server: convex/auth.ts exports convexAuth({ providers: [Resend({ ... })] })
- [ ] Server: convex/http.ts wires auth routes via auth.addHttpRoutes(http)
- [ ] Server: convex/auth.config.ts declares the auth provider domain/application ID
- [ ] Server: Magic-link email is sent by the Resend provider with a callback URL back to the Convex site
- [ ] Client: App is wrapped in ConvexAuthNextjsServerProvider (server) and ConvexAuthNextjsProvider (client)
- [ ] Client: Login page calls useAuthActions().signIn("resend", formData) with the user email
- [ ] Client: UI shows a 'check your email' state after sending the link
- [ ] Client: Clicking the emailed link completes sign-in and redirects to the app
- [ ] Routing: middleware.ts / src/middleware.ts / proxy.ts uses convexAuthNextjsMiddleware
- [ ] Routing: createRouteMatcher defines which routes require authentication
- [ ] Routing: Unauthenticated users are redirected to the login page

## Tests
- [ ] Unit test the login form submit path (email captured, signIn called with 'resend')
- [ ] Integration test that protected routes redirect unauthenticated users
- [ ] Manual smoke test of the full email round trip

## Verification & rollout
- [ ] Re-check every accepted repo's evidence anchors against live source before relying on them.
- [ ] Land the change behind small, isolated commits so a single revert removes it.
- [ ] Update README / internal docs and resolve or explicitly accept open questions.
