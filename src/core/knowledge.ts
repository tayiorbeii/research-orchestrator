import type { FeatureSpec, ProofRequirement } from "../schemas/index.js";

/**
 * Small, deterministic knowledge tables used by feature normalization,
 * probe generation, and pattern extraction. This is intentionally NOT a
 * semantic engine — it is a lookup layer that can grow over time.
 */

export interface StackEntry {
  name: string;
  token: string;
  pattern: RegExp;
  packages: string[];
}

export const STACKS: StackEntry[] = [
  { name: "Next.js", token: "next", pattern: /next\.?js\b|(?:^|[^a-z])next(?:[^a-z]|$)/i, packages: ["next"] },
  { name: "Convex", token: "convex", pattern: /convex/i, packages: ["convex"] },
  { name: "Supabase", token: "supabase", pattern: /supabase/i, packages: ["@supabase/supabase-js"] },
  { name: "Remix", token: "remix", pattern: /remix/i, packages: ["@remix-run/node"] },
  { name: "SvelteKit", token: "sveltekit", pattern: /svelte\s?kit/i, packages: ["@sveltejs/kit"] },
  { name: "Nuxt", token: "nuxt", pattern: /nuxt/i, packages: ["nuxt"] },
  { name: "Hono", token: "hono", pattern: /hono/i, packages: ["hono"] },
  { name: "Express", token: "express", pattern: /express/i, packages: ["express"] },
];

export interface ProviderEntry {
  name: string;
  token: string;
  pattern: RegExp;
  packages: string[];
}

export const PROVIDERS: ProviderEntry[] = [
  { name: "Resend", token: "resend", pattern: /resend/i, packages: ["resend"] },
  { name: "Clerk", token: "clerk", pattern: /clerk/i, packages: ["@clerk/nextjs"] },
  { name: "Stripe", token: "stripe", pattern: /stripe/i, packages: ["stripe"] },
  { name: "Postmark", token: "postmark", pattern: /postmark/i, packages: ["postmark"] },
  { name: "SendGrid", token: "sendgrid", pattern: /sendgrid/i, packages: ["@sendgrid/mail"] },
  { name: "Trigger.dev", token: "triggerdev", pattern: /trigger\.dev/i, packages: ["@trigger.dev/sdk"] },
];

export interface FeatureProfile {
  /** Stable token used inside the featureKey, e.g. "magic-link-auth". */
  key: string;
  feature: string;
  match: (goal: string) => boolean;
  /** Mutates a draft spec with profile-specific knowledge. */
  enrich: (draft: FeatureSpecDraft) => void;
  /** Extraction knowledge used by extractPattern. */
  pattern?: FeaturePatternKnowledge;
}

export interface FeaturePatternKnowledge {
  environmentVariables: string[];
  serverFlow: string[];
  clientFlow: string[];
  pitfalls: string[];
  routeProtection?: string[];
  tests?: string[];
}

export interface FeatureSpecDraft {
  goal: string;
  feature: string;
  stack: string[];
  libraries: string[];
  providers: string[];
  mustHave: string[];
  shouldHave: string[];
  exclude: string[];
  requiredConcepts: string[];
  likelyFiles: string[];
  proofRequirements: ProofRequirement[];
}

function has(list: string[], value: string): boolean {
  return list.some((v) => v.toLowerCase() === value.toLowerCase());
}

function pushUnique(list: string[], ...values: string[]): void {
  for (const value of values) {
    if (!list.includes(value)) list.push(value);
  }
}

const magicLinkConvexPattern: FeaturePatternKnowledge = {
  environmentVariables: [
    "AUTH_RESEND_KEY",
    "CONVEX_DEPLOYMENT",
    "NEXT_PUBLIC_CONVEX_URL",
    "CONVEX_SITE_URL",
    "SITE_URL",
    "JWT_PRIVATE_KEY",
    "JWKS",
  ],
  serverFlow: [
    "convex/auth.ts exports convexAuth({ providers: [Resend({ ... })] })",
    "convex/http.ts wires auth routes via auth.addHttpRoutes(http)",
    "convex/auth.config.ts declares the auth provider domain/application ID",
    "Magic-link email is sent by the Resend provider with a callback URL back to the Convex site",
  ],
  clientFlow: [
    "App is wrapped in ConvexAuthNextjsServerProvider (server) and ConvexAuthNextjsProvider (client)",
    "Login page calls useAuthActions().signIn(\"resend\", formData) with the user email",
    "UI shows a 'check your email' state after sending the link",
    "Clicking the emailed link completes sign-in and redirects to the app",
  ],
  routeProtection: [
    "middleware.ts / src/middleware.ts / proxy.ts uses convexAuthNextjsMiddleware",
    "createRouteMatcher defines which routes require authentication",
    "Unauthenticated users are redirected to the login page",
  ],
  tests: [
    "Unit test the login form submit path (email captured, signIn called with 'resend')",
    "Integration test that protected routes redirect unauthenticated users",
    "Manual smoke test of the full email round trip",
  ],
  pitfalls: [
    "Missing auth.addHttpRoutes(http) in convex/http.ts silently breaks the callback flow",
    "AUTH_RESEND_KEY must be set on the Convex deployment, not just the Next.js app",
    "middleware matcher must exclude static assets and the auth callback routes",
    "Magic-link callback URL must match the deployed site URL in production",
    "Do not confuse @convex-dev/auth with next-auth adapters — the wiring differs",
  ],
};

export const FEATURE_PROFILES: FeatureProfile[] = [
  {
    key: "magic-link-auth",
    feature: "email magic-link authentication",
    match: (goal) => /magic[\s-]?link/i.test(goal),
    pattern: magicLinkConvexPattern,
    enrich: (draft) => {
      if (has(draft.stack, "Convex")) {
        pushUnique(draft.libraries, "@convex-dev/auth", "@auth/core");
        if (draft.providers.length === 0) pushUnique(draft.providers, "Resend");
        pushUnique(
          draft.requiredConcepts,
          "convexAuth",
          "Resend",
          "useAuthActions",
          "signIn",
          "ConvexAuthNextjsProvider",
          "ConvexAuthNextjsServerProvider",
          "convexAuthNextjsMiddleware",
          "auth.addHttpRoutes",
        );
        pushUnique(
          draft.likelyFiles,
          "package.json",
          "convex/auth.ts",
          "convex/http.ts",
          "convex/auth.config.ts",
          "middleware.ts",
          "proxy.ts",
          "src/middleware.ts",
          "app/**/login/page.tsx",
          "src/app/**/login/page.tsx",
          "components/*Provider*.tsx",
        );
        draft.proofRequirements = [
          {
            key: "dependency_proof",
            description:
              "package.json proves Next.js, Convex, Convex Auth, and email provider dependencies.",
            required: true,
            signals: ["next", "convex", "@convex-dev/auth", "@auth/core", "resend"],
          },
          {
            key: "server_auth_proof",
            description:
              "Convex auth provider configured with Resend or equivalent email provider.",
            required: true,
            signals: ["convexAuth", "Resend"],
          },
          {
            key: "client_flow_proof",
            description: "Client login flow calls useAuthActions().signIn for email link.",
            required: true,
            signals: ["useAuthActions", "signIn('resend'", 'signIn("resend"'],
          },
          {
            key: "route_protection_proof",
            description: "Middleware/proxy protects routes using Convex auth.",
            required: true,
            signals: ["convexAuthNextjsMiddleware", "createRouteMatcher"],
          },
        ];
        pushUnique(draft.mustHave, "email magic link", "route protection", "implementation proof");
        pushUnique(
          draft.shouldHave,
          "App Router",
          "production-shaped repo",
          "env var docs",
          "tests or test hook",
        );
        pushUnique(draft.exclude, "docs-only as primary source", "deprecated auth pattern");
      } else if (has(draft.stack, "Supabase")) {
        pushUnique(draft.libraries, "@supabase/supabase-js", "@supabase/ssr");
        pushUnique(
          draft.requiredConcepts,
          "signInWithOtp",
          "createServerClient",
          "auth callback route",
          "exchangeCodeForSession",
        );
        pushUnique(
          draft.likelyFiles,
          "package.json",
          "app/auth/callback/route.ts",
          "middleware.ts",
        );
        pushUnique(draft.mustHave, "email magic link", "implementation proof");
      } else {
        pushUnique(draft.requiredConcepts, "magic link", "signIn", "verification token", "callback");
        pushUnique(draft.likelyFiles, "package.json", "middleware.ts");
        pushUnique(draft.mustHave, "email magic link", "implementation proof");
      }
    },
  },
  {
    key: "checkout-payments",
    feature: "checkout and payments",
    match: (goal) => /checkout|payment/i.test(goal),
    enrich: (draft) => {
      if (has(draft.providers, "Stripe")) {
        pushUnique(draft.libraries, "stripe");
        pushUnique(
          draft.requiredConcepts,
          "checkout.sessions.create",
          "webhook",
          "stripe.webhooks.constructEvent",
        );
        pushUnique(draft.likelyFiles, "package.json", "app/api/webhooks/stripe/route.ts");
      }
      pushUnique(draft.mustHave, "checkout flow", "implementation proof");
    },
  },
  {
    key: "file-upload",
    feature: "file upload and storage",
    match: (goal) => /file upload|upload.*(file|image)|storage/i.test(goal),
    enrich: (draft) => {
      pushUnique(draft.requiredConcepts, "upload", "storage", "generateUploadUrl");
      pushUnique(draft.likelyFiles, "package.json");
      pushUnique(draft.mustHave, "file upload flow", "implementation proof");
    },
  },
  {
    key: "email-verification",
    feature: "email verification flow",
    match: (goal) => /email verification|verify.*email/i.test(goal),
    enrich: (draft) => {
      pushUnique(draft.requiredConcepts, "verification token", "verify email", "expiration");
      pushUnique(draft.likelyFiles, "package.json");
      pushUnique(draft.mustHave, "email verification flow", "implementation proof");
    },
  },
  {
    key: "background-jobs",
    feature: "background job processing",
    match: (goal) => /background job|queue|cron|trigger\.dev/i.test(goal),
    enrich: (draft) => {
      pushUnique(draft.requiredConcepts, "task", "trigger", "schedule");
      pushUnique(draft.likelyFiles, "package.json");
      pushUnique(draft.mustHave, "background job flow", "implementation proof");
    },
  },
  {
    key: "auth",
    feature: "authentication",
    match: (goal) => /\bauth(entication)?\b|log ?in|sign ?in/i.test(goal),
    enrich: (draft) => {
      pushUnique(draft.requiredConcepts, "signIn", "session", "middleware");
      pushUnique(draft.likelyFiles, "package.json", "middleware.ts");
      pushUnique(draft.mustHave, "authentication flow", "implementation proof");
    },
  },
];

export function detectStacks(goal: string, hints?: string[]): StackEntry[] {
  const found: StackEntry[] = [];
  for (const stack of STACKS) {
    const hinted = hints?.some((h) => h.toLowerCase() === stack.name.toLowerCase());
    if (hinted || stack.pattern.test(goal)) found.push(stack);
  }
  return found;
}

export function detectProviders(goal: string, hints?: string[]): ProviderEntry[] {
  const found: ProviderEntry[] = [];
  for (const provider of PROVIDERS) {
    const hinted = hints?.some((h) => h.toLowerCase() === provider.name.toLowerCase());
    if (hinted || provider.pattern.test(goal)) found.push(provider);
  }
  return found;
}

export function detectFeatureProfile(goal: string): FeatureProfile | undefined {
  return FEATURE_PROFILES.find((profile) => profile.match(goal));
}

export function getFeatureProfileForSpec(spec: FeatureSpec): FeatureProfile | undefined {
  return FEATURE_PROFILES.find((profile) => spec.featureKey.endsWith(profile.key));
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Generic goal mining (novel / non-application research goals)
// ---------------------------------------------------------------------------
//
// The registry above only knows a handful of feature families. For anything
// else (e.g. "Develop a migration guide for a WezTerm config to Flowdeck") the
// normalizer used to truncate the goal to its first few words, throwing away
// every named product and concept. The helpers below mine the goal text itself
// for distinctive terms so entities survive normalization and reach probe
// generation. They are deliberately lexical (no semantic model) and
// deterministic.

/** Filler words that never count as key terms. Lower-cased comparison. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "for", "to", "in", "on", "at", "by",
  "with", "without", "into", "from", "as", "is", "are", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "their", "our", "your", "my",
  "all", "any", "some", "each", "every", "both", "other", "another", "such",
  "should", "would", "could", "can", "may", "might", "must", "will", "shall",
  "do", "does", "did", "done", "have", "has", "had", "not", "no", "nor", "so",
  "if", "then", "than", "too", "very", "also", "across", "between", "whether",
  "while", "when", "where", "which", "who", "whom", "how", "why", "what",
  // Common lead verbs / generics that are not themselves the feature.
  "develop", "build", "create", "make", "generate", "write", "produce", "design",
  "implement", "add", "support", "enable", "allow", "provide", "include",
  "find", "look", "search", "get", "set", "use", "using", "used", "run", "running",
  "existing", "current", "new", "old", "safe", "unsafe", "good", "best",
  "app", "application", "project", "code", "file", "files", "data", "value",
  "values", "example", "examples", "case", "cases", "way", "ways", "thing",
  "things", "stuff", "work", "working", "works", "need", "needs", "want",
  "wanted", "like", "map", "maps", "mapped", "preserve", "preserved", "preserving",
  "keep", "identify", "pattern", "patterns",
  "evaluate", "assess", "compare", "investigate", "research", "guide", "explore", "understand",
  "describe", "explain", "summarize", "review", "check", "verify", "confirm",
]);

/**
 * Behavior/system nouns worth preserving as concepts even when lowercase.
 * Intentionally broad and domain-agnostic (terminals, auth, data, infra...) so
 * novel goals keep their central concepts without a bespoke profile.
 */
const DOMAIN_NOUNS = new Set([
  // terminal / window manager / editor workflow surface
  "navigation", "workspace", "workspaces", "layout", "layouts", "session",
  "sessions", "pane", "panes", "window", "windows", "tab", "tabs", "split",
  "splits", "terminal", "terminal-emulator", "keyboard", "keymap", "keymaps", "keybinding",
  "keybindings", "keybinding", "resize", "zoom", "picker", "pickers", "theme",
  "themes", "font", "fonts", "shader", "shaders", "resurrect", "tmux",
  "multiplexer", "multiplexing", "ssh", "shell", "shells", "prompt",
  // generic software nouns
  "migration", "migrations", "config", "configuration", "plugin", "plugins",
  "extension", "extensions", "integration", "integrations", "adapter",
  "adapters", "provider", "providers", "hook", "hooks", "event", "events",
  "command", "commands", "mode", "modes", "api", "sdk", "auth", "authentication",
  "authorization", "session", "login", "logout", "callback", "webhook",
  "middleware", "route", "routes", "router", "schema", "migration", "query",
  "queries", "mutation", "cache", "queue", "worker", "cron", "schedule",
  "stream", "streaming", "websocket", "upload", "storage", "render", "rendering",
  "state", "store", "context", "service", "services", "client", "server",
  "database", "deployment", "ci", "test", "tests", "benchmark", "benchmarks",
]);

/**
 * Terms that are too generic to be trustworthy proof signals (they match far
 * too much unrelated code/docs). Excluded from research-goal proof signals so a
 * repo must mention a distinctive product/concept to count as evidence.
 */
export const GENERIC_SIGNAL_NOISE = new Set([
  "macos", "mac-os", "linux", "windows", "unix", "posix", "android", "ios", "wsl",
  "migration", "migrations", "migrate", "configuration", "config", "configure",
  "integration", "integrations", "guide", "setup", "install", "installation",
]);

export type GoalKind = "application" | "research";

const STRONG_RESEARCH_GOAL_PATTERN =
  /\b(migrat\w*|port\w*|upgrade\w*|adopt\w*|evaluat\w*|compar\w*|assess\w*|investigat\w*|research)\b/i;
const WEAK_RESEARCH_GOAL_PATTERN = /\b(guide|tutorial|overview|whether|vs\.?)\b/i;
const APPLICATION_GOAL_PATTERN = /^\s*(build|implement|create|develop|add|enable|support)\b/i;

/**
 * Classify a goal as an application-build goal vs. a research/migration goal.
 * Strong research verbs win; otherwise an explicit build verb wins over weak
 * documentation words (for example, "Build a guide app").
 */
export function detectGoalKind(goal: string): GoalKind {
  if (STRONG_RESEARCH_GOAL_PATTERN.test(goal)) return "research";
  if (APPLICATION_GOAL_PATTERN.test(goal)) return "application";
  return WEAK_RESEARCH_GOAL_PATTERN.test(goal) ? "research" : "application";
}

function isStopToken(token: string): boolean {
  const lower = token.toLowerCase();
  if (STOPWORDS.has(lower)) return true;
  // Pure punctuation or 1-2 char lowercase filler.
  if (lower.length <= 2 && /^[a-z]+$/.test(lower)) return true;
  return false;
}

function isKeyToken(token: string): boolean {
  if (/[A-Z]/.test(token.slice(1))) return true; // internal capital: WezTerm, macOS
  if (/[0-9]/.test(token)) return true; // version/suffix digit: iTerm2
  if (/^[A-Z][a-z]/.test(token) && token.length > 3) return true; // Capitalized name: Flowdeck
  if (DOMAIN_NOUNS.has(token.toLowerCase())) return true; // behavior noun
  // Unknown lowercase content words may be product names (wezterm, kubernetes,
  // nomad). Stopwords were removed before this check; generic/noise terms are
  // filtered when proof requirements are built.
  return /^[a-z][a-z0-9.+]*$/i.test(token) && token.length > 2;
}

/**
 * Mine a goal for distinctive terms (named products + behavior concepts),
 * preserving original case and hyphenated compounds. Deterministic and ordered
 * by first appearance so the same goal always yields the same terms.
 */
export function extractKeyTerms(goal: string, max = 16): string[] {
  const cleaned = goal.replace(/[^A-Za-z0-9\s.+-]/g, " ");
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (term: string): void => {
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(term);
  };
  for (const token of cleaned.split(/\s+/).filter(Boolean)) {
    if (isStopToken(token)) continue;
    if (token.includes("-")) {
      push(token);
      continue;
    }
    if (isKeyToken(token)) push(token);
  }
  return terms.slice(0, max);
}

/** Does a term read like a named product/system rather than a behavior noun? */
export function looksLikeProperNoun(term: string): boolean {
  if (!term) return false;
  const lower = term.toLowerCase();
  if (DOMAIN_NOUNS.has(lower)) return false;
  if (/[A-Z]/.test(term.slice(1))) return true; // internal capital
  if (/[0-9]/.test(term)) return true; // digit suffix
  if (/^[A-Z][a-z]/.test(term) && term.length > 2) return true; // Capitalized name
  if (GENERIC_SIGNAL_NOISE.has(lower)) return false;
  // Lowercase hyphenated compounds are usually behavior qualifiers
  // (keyboard-only, coding-agent), not product names.
  if (term.includes("-")) return false;
  // Lowercase unknown nouns are treated as entity candidates. This favors
  // recall; research proof still requires exact, line-level evidence.
  return /^[a-z][a-z0-9.+]*$/.test(term) && term.length > 2;
}

/** Split key terms into named products vs. behavior concepts. */
export function partitionKeyTerms(terms: string[]): {
  products: string[];
  behaviors: string[];
} {
  const products: string[] = [];
  const behaviors: string[] = [];
  for (const term of terms) {
    if (looksLikeProperNoun(term)) products.push(term);
    else behaviors.push(term);
  }
  return { products, behaviors };
}
