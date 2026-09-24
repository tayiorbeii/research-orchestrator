# 11 Example Feature: Next.js + Convex Magic Links

## Goal

Find examples of a Next.js + Convex app using email magic links, determine the libraries and files involved, and generate an implementation plan.

## Normalized feature spec

```json
{
  "featureKey": "next-convex-magic-link-auth",
  "feature": "email magic-link authentication",
  "stack": ["Next.js", "Convex"],
  "libraries": ["@convex-dev/auth", "@auth/core"],
  "providers": ["Resend"],
  "requiredConcepts": [
    "convexAuth",
    "Resend",
    "useAuthActions",
    "signIn",
    "ConvexAuthNextjsProvider",
    "ConvexAuthNextjsServerProvider",
    "convexAuthNextjsMiddleware",
    "auth.addHttpRoutes"
  ]
}
```

## Search probes

### High precision

```text
"convexAuth" "Resend("
"signIn('resend'" "@convex-dev/auth/react"
"signIn(\"resend\"" "@convex-dev/auth/react"
"convexAuthNextjsMiddleware" "@convex-dev/auth/nextjs/server"
"ConvexAuthNextjsProvider" "ConvexAuthNextjsServerProvider"
"auth.addHttpRoutes" "@convex-dev/auth"
```

### Recall

```text
"@convex-dev/auth" "Resend"
"@auth/core/providers/resend" "convex"
"magic link" "convex"
"passwordless" "convex"
"email" "useAuthActions" "convex"
```

### Path-targeted

```text
"Resend(" path:convex/auth.ts
"convexAuth(" path:convex/auth.ts
"signIn" path:/app/**/login/
"convexAuthNextjsMiddleware" path:middleware.ts
"convexAuthNextjsMiddleware" path:proxy.ts
```

## Proof checklist

A strong candidate should prove:

- `package.json` contains `next`, `convex`, `@convex-dev/auth`, and email/auth provider dependencies.
- `convex/auth.ts` configures `convexAuth`.
- Auth provider includes `Resend` or equivalent email provider.
- `convex/http.ts` adds auth routes.
- App provider wraps React/Next app with Convex auth provider.
- Login page calls `useAuthActions().signIn(...)`.
- Middleware/proxy protects routes.
- Redirect/callback behavior is handled.
- Environment variables are documented or referenced.

## Expected implementation pattern

```text
1. Install dependencies.
2. Add auth tables to Convex schema.
3. Configure Convex Auth with Resend provider.
4. Add auth HTTP routes.
5. Configure Convex auth provider in Next root layout.
6. Create login form with email input.
7. Call signIn("resend", ...) with redirect target.
8. Protect routes with middleware/proxy.
9. Add env vars for JWT/JWKS and email provider.
10. Verify sign-in, callback, protected-route redirect, and sign-out.
```

## Pitfalls to search for

- Middleware redirects before magic-link callback completes.
- Provider setup uses generic Convex provider instead of Next-specific provider.
- Missing `auth.config.ts`.
- JWT private key and JWKS mismatch.
- Env vars configured locally but not in production.
- Hardcoded redirect URLs.
- Unprotected server routes.
- No sign-out path.
- No allowlist or access control where needed.

## Artifact output

The generated `research.md` should include:

- selected source repos
- repo classifications
- evidence map
- common implementation pattern
- copied/adapted/avoided choices
- open questions
- risks

The generated `plan.md` should include:

- files to modify
- step-by-step implementation
- config/env setup
- testing plan
- rollback plan
