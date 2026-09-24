/** Benchmark tasks from docs/10_eval_benchmarks.md. Extensible list. */
export interface BenchmarkTask {
  id: string;
  goal: string;
  /** Tasks with mock fixtures can run without network. */
  mockReady: boolean;
}

export const BENCHMARK_TASKS: BenchmarkTask[] = [
  {
    id: "next-convex-resend-magic-links",
    goal: "Build a Next.js + Convex app with email magic links via Resend.",
    mockReady: true,
  },
  { id: "next-convex-clerk-orgs", goal: "Next.js + Convex + Clerk organizations.", mockReady: false },
  { id: "next-resend-contact-form", goal: "Next.js + Resend contact form with a server action.", mockReady: false },
  { id: "convex-stripe-checkout", goal: "Convex + Stripe checkout.", mockReady: false },
  { id: "convex-file-upload", goal: "Convex file upload and storage.", mockReady: false },
  { id: "hono-openapi-zod", goal: "Hono + OpenAPI + Zod validation.", mockReady: false },
  { id: "next-middleware-auth", goal: "Next.js middleware auth protection.", mockReady: false },
  { id: "triggerdev-background-job", goal: "Trigger.dev background job from a web app.", mockReady: false },
  { id: "supabase-magic-link", goal: "Supabase magic link auth in the Next.js App Router.", mockReady: false },
  { id: "resend-email-verification", goal: "Email verification flow with Resend.", mockReady: false },
];
