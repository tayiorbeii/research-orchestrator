import type { CandidateRepo } from "../schemas/candidateRepo.js";
import type { ResearchBrief } from "../schemas/researchBrief.js";

export interface ReplaySource {
  id: string;
  repo: string;
  path: string;
  content: string;
  relevance: "relevant" | "negative" | "noisy";
  kind?: "issue_proposal";
  state?: "open" | "closed";
}

export interface BenchmarkTask {
  id: string;
  title: string;
  synthetic: true;
  provenance: string;
  split: "tuning" | "held_out";
  surface: "brief" | "goal";
  goal: string;
  brief: ResearchBrief;
  sources: ReplaySource[];
  labels: {
    relevantSourceIds: string[];
    supportedFacts: Array<{ questionId: string; assertionIncludes: string; sourceId: string }>;
    expectedQuestionCoverage: Record<string, "satisfied" | "unresolved" | "not_attempted">;
    expectedUntouchedQuestions: string[];
  };
  knownDefect?: string;
}

const budgets = {
  maxQuestions: 6, queryUnits: 12, reconnaissanceReads: 0, fileReads: 24,
  fileReadsPerRepo: 8, refinementRounds: 0, refinementProbes: 0, deadlineMs: 60_000,
};

function task(input: Omit<BenchmarkTask, "synthetic" | "provenance">): BenchmarkTask {
  return {
    ...input,
    synthetic: true,
    provenance: "Authored for Phase 6 from synthetic source text; no provider output or external repository was copied.",
  };
}

function brief(
  id: string,
  goal: string,
  questions: ResearchBrief["questions"],
  vocabulary: ResearchBrief["vocabulary"],
  readiness: ResearchBrief["readiness"] = { status: "ready" },
): ResearchBrief {
  return {
    id, revision: 1, goal, questions, mechanisms: [], vocabulary, seeds: [],
    allowedSourceKinds: ["repository_file", "documentation_page", "issue_proposal"],
    budgets, readiness, lookupOutcomes: [], egressPolicy: { allowRestrictedLocalTerms: false },
  };
}

function q(id: string, statement: string, intent: ResearchBrief["questions"][number]["intentHints"][number], signals: string[]) {
  return {
    id, statement, intentHints: [intent], required: true, answerScope: "The narrow fact stated by a frozen synthetic source.",
    obligations: [{ facts: [{ kind: "quotation" as const, signals, claimScope: intent === "feature_exploration" ? "advertised" as const : undefined }], combine: "all" as const, scope: "same_repository" as const }],
  };
}

function terms(questionIds: string[], values: string[]): ResearchBrief["vocabulary"] {
  return values.map((text, index) => ({
    id: `term-${index + 1}`, text, questionIds, kind: "symbol", origin: "user_supplied", status: "proposed",
  }));
}

function source(id: string, repo: string, path: string, content: string, relevance: ReplaySource["relevance"]): ReplaySource {
  return { id, repo, path, content, relevance };
}

const webhook = q("api", "Does the handler invoke webhook signature verification?", "library_usage", ["verifyWebhookSignature", "request.rawBody"]);
const retry = q("retry", "Is retry bounded and cancellation checked?", "implementation_behavior", ["maxAttempts", "signal.aborted"]);
const projection = q("projection", "Can the projection be rebuilt from retained events?", "architecture_pattern", ["rebuildProjection", "eventStore.readFrom"]);
const advertised = q("advertised", "Which review-tool capabilities are documented?", "feature_exploration", ["Review bundles", "inline findings"]);
const proposed = q("proposed", "Which capability is only proposed in an issue?", "feature_exploration", ["planned support for custom rules"]);

export const BENCHMARK_TASKS: BenchmarkTask[] = [
  task({
    id: "library-webhook-signature", title: "Webhook signature API invocation", split: "tuning", surface: "brief",
    goal: "Show a source-backed webhook signature API invocation.", brief: brief("library-webhook-signature", "Show a source-backed webhook signature API invocation.", [webhook], terms(["api"], ["verifyWebhookSignature", "request.rawBody"])),
    sources: [
      source("webhook-positive", "synthetic/webhook-handler", "src/handler.ts", "const event = verifyWebhookSignature(request.rawBody, request.headers);", "relevant"),
      source("webhook-negative", "synthetic/webhook-name-only", "README.md", "Webhook integrations are planned. No signature API is invoked here.", "negative"),
      source("webhook-noise", "synthetic/webhook-noise", "docs/overview.md", "Webhook signature verification is a concern for this service.", "noisy"),
    ],
    labels: { relevantSourceIds: ["webhook-positive"], supportedFacts: [{ questionId: "api", assertionIncludes: "verifyWebhookSignature", sourceId: "webhook-positive" }], expectedQuestionCoverage: { api: "satisfied" }, expectedUntouchedQuestions: [] },
  }),
  task({
    id: "bounded-retry-cancellation", title: "Bounded retry and cancellation behavior", split: "tuning", surface: "brief",
    goal: "Verify bounded retries and abort handling.", brief: brief("bounded-retry-cancellation", "Verify bounded retries and abort handling.", [retry], terms(["retry"], ["maxAttempts", "signal.aborted"])),
    sources: [
      source("retry-positive", "synthetic/retrying-worker", "src/worker.ts", "for (let attempt = 0; attempt < maxAttempts; attempt += 1) { if (signal.aborted) throw new Error('cancelled'); await run(); }", "relevant"),
      source("retry-negative", "synthetic/unbounded-worker", "src/worker.ts", "// maxAttempts is documented but this loop does not use it; signal is only logged.", "negative"),
      source("retry-noise", "synthetic/retry-article", "docs/notes.md", "Retries and cancellation are discussed as future reliability work.", "noisy"),
    ],
    labels: { relevantSourceIds: ["retry-positive"], supportedFacts: [{ questionId: "retry", assertionIncludes: "maxAttempts", sourceId: "retry-positive" }], expectedQuestionCoverage: { retry: "satisfied" }, expectedUntouchedQuestions: [] },
  }),
  task({
    id: "projection-rebuilding", title: "Event-sourced projection rebuilding", split: "tuning", surface: "brief",
    goal: "Find an architecture pattern for rebuilding a projection from events.", brief: brief("projection-rebuilding", "Find an architecture pattern for rebuilding a projection from events.", [projection], terms(["projection"], ["rebuildProjection", "eventStore.readFrom"])),
    sources: [
      source("projection-positive", "synthetic/event-ledger", "src/projection.ts", "export async function rebuildProjection() { for await (const event of eventStore.readFrom(0)) await applyProjection(event); }", "relevant"),
      source("projection-negative", "synthetic/read-model-only", "src/view.ts", "// A projection is loaded from a snapshot; retained events cannot be replayed.", "negative"),
      source("projection-noise", "synthetic/projection-docs", "README.md", "Projection rebuilding is a goal for a future architecture revision.", "noisy"),
    ],
    labels: { relevantSourceIds: ["projection-positive"], supportedFacts: [{ questionId: "projection", assertionIncludes: "rebuildProjection", sourceId: "projection-positive" }], expectedQuestionCoverage: { projection: "satisfied" }, expectedUntouchedQuestions: [] },
  }),
  task({
    id: "review-tool-capabilities", title: "Advertised versus proposed review-tool capabilities", split: "held_out", surface: "brief",
    goal: "Separate advertised capabilities from proposed features.", brief: brief("review-tool-capabilities", "Separate advertised capabilities from proposed features.", [advertised, { ...proposed, obligations: [{ ...proposed.obligations[0]!, facts: [{ kind: "quotation", path: "issues/17", signals: ["planned support for custom rules"], claimScope: "proposed" }] }] }], terms(["advertised", "proposed"], ["Review bundles", "inline findings", "planned support for custom rules"])),
    sources: [
      source("review-docs", "synthetic/review-tool", "docs/features.md", "Review bundles include inline findings for changed files.", "relevant"),
      { ...source("review-issue", "synthetic/review-tool", "issues/17", "Proposal: planned support for custom rules; not implemented.", "relevant"), kind: "issue_proposal", state: "open" },
      source("review-negative", "synthetic/review-tool-no-impl", "src/review.ts", "// No review bundles or inline findings are implemented in this package.", "negative"),
      source("review-noise", "synthetic/review-chat", "docs/roadmap.md", "Users asked whether review bundles could eventually include inline findings.", "noisy"),
    ],
    labels: { relevantSourceIds: ["review-docs", "review-issue"], supportedFacts: [{ questionId: "advertised", assertionIncludes: "Review bundles", sourceId: "review-docs" }, { questionId: "proposed", assertionIncludes: "planned support for custom rules", sourceId: "review-issue" }], expectedQuestionCoverage: { advertised: "satisfied", proposed: "satisfied" }, expectedUntouchedQuestions: [] },
  }),
  task({
    id: "mixed-api-and-retry", title: "Mixed library and behavior request", split: "held_out", surface: "brief",
    goal: "Find a handler using the verifier and confirm retries honor cancellation.",
    brief: brief("mixed-api-and-retry", "Find a handler using the verifier and confirm retries honor cancellation.", [webhook, retry], terms(["api", "retry"], ["verifyWebhookSignature", "request.rawBody", "maxAttempts", "signal.aborted"])),
    sources: [
      source("mixed-handler", "synthetic/mixed-handler", "src/handler.ts", "verifyWebhookSignature(request.rawBody, request.headers);", "relevant"),
      source("mixed-worker", "synthetic/mixed-worker", "src/worker.ts", "for (let attempt = 0; attempt < maxAttempts; attempt++) { if (signal.aborted) return; await run(); }", "relevant"),
      source("mixed-negative", "synthetic/mixed-decoy", "README.md", "Verifier and retries are listed as desired capabilities; no invocation is shown.", "negative"),
      source("mixed-noise", "synthetic/mixed-blog", "docs/notes.md", "Signature verification and cancellation are unrelated considerations.", "noisy"),
    ],
    labels: { relevantSourceIds: ["mixed-handler", "mixed-worker"], supportedFacts: [{ questionId: "api", assertionIncludes: "verifyWebhookSignature", sourceId: "mixed-handler" }, { questionId: "retry", assertionIncludes: "maxAttempts", sourceId: "mixed-worker" }], expectedQuestionCoverage: { api: "satisfied", retry: "satisfied" }, expectedUntouchedQuestions: [] },
  }),
  task({
    id: "underspecified-improvement", title: "Under-specified request", split: "held_out", surface: "goal",
    goal: "Find a way to improve project productivity",
    brief: brief("underspecified-improvement", "Find a way to improve project productivity", [q("q1", "Find a way to improve project productivity", "implementation_behavior", ["productivity"])], [], { status: "needs_input", reasons: [{ code: "missing_vocabulary", questionIds: ["q1"], detail: "Name a package, API, project, or behavior." }] }),
    sources: [
      source("vague-negative", "synthetic/productivity-decoy", "README.md", "No product or behavior is specified.", "negative"),
      source("vague-noise", "synthetic/productivity-noise", "docs/notes.md", "Productivity improvements are an open research area.", "noisy"),
    ],
    labels: { relevantSourceIds: [], supportedFacts: [], expectedQuestionCoverage: { q1: "not_attempted" }, expectedUntouchedQuestions: ["q1"] },
  }),
];

export interface ReplayCorpus {
  candidates: CandidateRepo[];
  fileContents: Record<string, Record<string, string>>;
  issues: Record<string, Array<{ repo: string; number: number; title: string; body: string; state: "open" | "closed"; url: string; createdAt: string; updatedAt: string }>>;
}

export function corpusFor(task: BenchmarkTask): ReplayCorpus {
  const byRepo = new Map<string, ReplaySource[]>();
  for (const item of task.sources) byRepo.set(item.repo, [...(byRepo.get(item.repo) ?? []), item]);
  const candidates = [...byRepo.entries()].map(([repo, items]) => {
    const fileItems = items.filter((item) => item.kind !== "issue_proposal");
    const [owner = "synthetic", name = "candidate"] = repo.split("/");
    const path = items[0]!.path;
    return {
      repo, owner, name, defaultBranch: "main", url: `https://example.invalid/${repo}`,
      discoveredBy: ["replay"], matchedPaths: [...new Set(fileItems.map((item) => item.path))],
      candidateSignals: fileItems.map((item) => ({ key: item.id, label: item.content.slice(0, 100), source: "mock" as const, confidence: 0.5 })),
      raw: { synthetic: true, relevance: items.map((item) => item.relevance) },
    } satisfies CandidateRepo;
  });
  const fileContents: ReplayCorpus["fileContents"] = {};
  const issues: ReplayCorpus["issues"] = {};
  for (const item of task.sources) {
    if (item.kind === "issue_proposal") {
      const number = Number(item.path.match(/\d+$/)?.[0] ?? 0);
      issues[item.repo] = [...(issues[item.repo] ?? []), { repo: item.repo, number, title: `Issue #${number}: custom rules`, body: item.content, state: item.state ?? "open", url: `https://example.invalid/${item.repo}/issues/${number}`, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-02T00:00:00.000Z" }];
    } else fileContents[item.repo] = { ...(fileContents[item.repo] ?? {}), [item.path]: item.content };
  }
  return { candidates, fileContents, issues };
}
