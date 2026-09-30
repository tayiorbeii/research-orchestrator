import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OctocodeEvidenceProvider } from "../src/adapters/OctocodeEvidenceProvider.js";
import { GitHubEvidenceProvider } from "../src/adapters/GitHubEvidenceProvider.js";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";
import { compileProbes } from "../src/core/brief/compileProbes.js";
import { draftBriefFromGoal } from "../src/core/brief/draftBriefFromGoal.js";
import { validateBrief } from "../src/core/brief/validateBrief.js";
import { DEFAULT_BRIEF_BUDGETS, type ResearchBrief } from "../src/schemas/researchBrief.js";
import type { BudgetLedger } from "../src/schemas/searchProbeV2.js";
const historical = JSON.parse(readFileSync(new URL("./fixtures/research-integrity/historical-goal.json", import.meta.url), "utf8")) as { goal: string };

const ledger = (queryUnits = 16): BudgetLedger => ({
  limits: { ...DEFAULT_BRIEF_BUDGETS, queryUnits },
  consumed: { queryUnits: 0, rpcCount: 0, reconnaissanceReads: 0, fileReads: 0, fileReadsByRepo: {}, refinementRounds: 0, refinementProbes: 0 },
  cancelled: false,
});

describe("brief adapter and compiler", () => {
  it("records an issue capability gap without searching code or claiming absence", () => {
    const draft = draftBriefFromGoal("Research custom rule proposals");
    const brief: ResearchBrief = {
      ...draft, readiness: { status: "ready" }, allowedSourceKinds: ["issue_proposal"],
      questions: [{ id: "proposal", statement: "Was custom rule support proposed?", intentHints: ["feature_exploration"], required: true, answerScope: "A user proposal.", obligations: [{ facts: [{ kind: "quotation", signals: ["custom rules"], claimScope: "proposed" }], combine: "all", scope: "same_repository" }] }],
      vocabulary: [{ id: "custom-rules", text: "custom rules", questionIds: ["proposal"], kind: "symbol", origin: "user_supplied", status: "proposed" }],
    };
    const provider = new OctocodeEvidenceProvider();
    expect(provider.searchCapabilities().issues).toBe(false);
    const compiled = compileProbes(brief, provider.searchCapabilities(), ledger());
    expect(compiled.probes).toEqual([]);
    expect(compiled.failures).toMatchObject([{ questionId: "proposal", qualifier: "source_access_unavailable", reason: expect.stringContaining("no absence claim was made") }]);

    const issueSourcesAllowed: ResearchBrief = {
      ...brief, questions: [{ ...brief.questions[0]!, obligations: [{ ...brief.questions[0]!.obligations[0]!, facts: [{ kind: "quotation", path: "issues/17", signals: ["custom rules"] }] }] }],
    };
    expect(compileProbes(issueSourcesAllowed, new MockEvidenceProvider().searchCapabilities(), ledger()).probes.some((probe) => probe.providerArgs.endpoint === "issueSearch")).toBe(true);
  });

  it("compiles the live pilot facts into path-scoped GitHub probes and labels degraded scopes", () => {
    const draft = draftBriefFromGoal("Pilot Python pre-review checks: ruff, mypy, diff-cover");
    const brief: ResearchBrief = {
      ...draft,
      id: "pilot-python-prereview",
      revision: 2,
      readiness: { status: "ready" },
      budgets: { ...DEFAULT_BRIEF_BUDGETS, queryUnits: 8, fileReads: 16, fileReadsPerRepo: 4 },
      questions: [
        { id: "q_ruff", statement: "A repository runs ruff from .pre-commit-config.yaml", intentHints: ["implementation_behavior"], required: true, answerScope: "One source-backed example.", obligations: [{ facts: [{ kind: "quotation", path: ".pre-commit-config.yaml", signals: ["ruff"], claimScope: "implemented" }], combine: "all", scope: "same_repository" }] },
        { id: "q_mypy", statement: "A repository runs mypy from .pre-commit-config.yaml", intentHints: ["implementation_behavior"], required: true, answerScope: "One source-backed example.", obligations: [{ facts: [{ kind: "quotation", path: ".pre-commit-config.yaml", signals: ["mypy"], claimScope: "implemented" }], combine: "all", scope: "same_repository" }] },
        { id: "q_diffcover", statement: "A GitHub Actions workflow invokes diff-cover", intentHints: ["implementation_behavior"], required: true, answerScope: "One source-backed example.", obligations: [{ facts: [{ kind: "workflow", command: "diff-cover" }], combine: "all", scope: "same_repository" }] },
      ],
      vocabulary: [
        { id: "v_ruff", text: "ruff", questionIds: ["q_ruff"], kind: "package", origin: "user_supplied", status: "proposed" },
        { id: "v_precommit", text: ".pre-commit-config.yaml", questionIds: ["q_ruff", "q_mypy"], kind: "config_key", origin: "user_supplied", status: "proposed" },
        { id: "v_mypy", text: "mypy", questionIds: ["q_mypy"], kind: "package", origin: "user_supplied", status: "proposed" },
        { id: "v_diffcover", text: "diff-cover", questionIds: ["q_diffcover"], kind: "package", origin: "user_supplied", status: "proposed" },
      ],
    };
    const github = compileProbes(brief, new GitHubEvidenceProvider({ token: "unused" }).searchCapabilities(), ledger(8));
    const primary = github.probes.filter((probe) => probe.questionIds[0] !== "q_ruff" || probe.providerQuery.startsWith("ruff "));
    expect(primary.map((probe) => probe.providerQuery)).toEqual(expect.arrayContaining([
      "ruff filename:.pre-commit-config.yaml",
      "mypy filename:.pre-commit-config.yaml",
      "diff-cover path:.github/workflows",
    ]));
    expect(github.probes.some((probe) => probe.rationale.includes("broader unqualified alternative"))).toBe(true);

    for (const provider of [new OctocodeEvidenceProvider(), new MockEvidenceProvider()]) {
      const degraded = compileProbes(brief, provider.searchCapabilities(), ledger(8), { allowDegraded: true });
      expect(degraded.probes).toHaveLength(3);
      expect(degraded.probes.find((probe) => probe.questionIds.includes("q_ruff"))?.rationale).toContain("Intended scope: filename:.pre-commit-config.yaml");
      expect(degraded.failures.some((failure) => failure.degraded && failure.reason.includes("actual scope"))).toBe(true);
    }
  });

  it("keeps late historical anchors and splits obvious subtopics", () => {
    const brief = draftBriefFromGoal(historical.goal);
    const texts = brief.vocabulary.map((term) => term.text.toLowerCase());
    for (const term of ["pyright", "pre-commit", "ast"]) expect(texts.join(" ")).toContain(term);
    expect(brief.questions.length).toBeGreaterThan(1);
    expect(brief.vocabulary.map((term) => term.text.toLowerCase())).not.toContain("proven");
    const compiled = compileProbes(brief, new OctocodeEvidenceProvider().searchCapabilities(), ledger());
    const compiledQueries = compiled.probes.map((probe) => probe.providerQuery.toLowerCase()).join("\n");
    for (const anchor of ["pyright", "pre-commit", "ast"]) expect(compiledQueries).toContain(anchor);
    const generic = new Set(["strict", "lint", "gradual", "baseline", "baselines", "forbidden", "vendor", "imports", "custom", "rules", "sensitive", "logging", "changed-line", "coverage", "parity", "checks", "ci", "pre-review"]);
    for (const probe of compiled.probes) {
      const tokens = probe.providerQuery.split(/\s+/);
      expect(tokens.some((token) => !generic.has(token.toLowerCase()))).toBe(true);
      expect(new Set(tokens.map((token) => token.toLowerCase())).size).toBe(tokens.length);
    }
    expect(compiledQueries).toContain("ruff strict lint");
    expect(compiledQueries).toContain("mypy gradual baselines");
    expect(compiled.probes.every((probe) => !/"[^\"]+\s+[^\"]+"/.test(probe.providerQuery))).toBe(true);
  });

  it("asks for input on vague goals and does not invent products", () => {
    const brief = draftBriefFromGoal("Find a way to improve project productivity");
    expect(brief.readiness).toMatchObject({ status: "needs_input", reasons: [{ code: "missing_vocabulary" }] });
    expect(brief.vocabulary).toEqual([]);
  });

  it("asks for input when a goal contains only generic modifiers", () => {
    const brief = draftBriefFromGoal("Research strict lint coverage");
    expect(brief.readiness.status).toBe("needs_input");
    expect(brief.vocabulary).toEqual([]);
  });

  it("does not compile a domain phrase such as feature as a standalone query", () => {
    const draft = draftBriefFromGoal("Research feature", {
      questions: [{ id: "q1", statement: "Find a feature", intentHints: ["feature_exploration"], required: true, answerScope: "one example", obligations: [{ facts: [{ kind: "quotation", signals: ["feature"] }], combine: "all", scope: "same_repository" }] }],
      vocabulary: [{ id: "feature", text: "feature", questionIds: ["q1"], kind: "domain_phrase", origin: "user_supplied", status: "proposed" }],
    });
    const brief = { ...draft, readiness: { status: "ready" as const } };
    expect(compileProbes(brief, new OctocodeEvidenceProvider().searchCapabilities(), ledger()).probes).toEqual([]);
    expect(draftBriefFromGoal("proven repository implementations").readiness.status).toBe("needs_input");
  });

  it("targets a precise package and API without reconnaissance", () => {
    const brief = draftBriefFromGoal("Use @convex-dev/auth through useAuthActions", { seeds: [{ repo: "acme/auth-example", origin: "planner_hypothesis" }] });
    expect(brief.readiness.status).toBe("ready");
    expect(brief.vocabulary.map((term) => term.text)).toEqual(expect.arrayContaining(["@convex-dev/auth", "useAuthActions"]));
    expect(brief.lookupOutcomes).toEqual([]);
    expect(brief.lookupNeeds).toEqual([]);
    expect(brief.seeds).toEqual([{ repo: "acme/auth-example", origin: "planner_hypothesis" }]);
    expect(compileProbes(brief, new OctocodeEvidenceProvider().searchCapabilities(), ledger()).probes.length).toBeGreaterThan(0);
  });

  it("reserves the first query for each required question before additional anchors", () => {
    const brief = draftBriefFromGoal("Research the following: alphaTool; betaTool; gammaTool");
    const limited = ledger(2);
    const compiled = compileProbes(brief, new OctocodeEvidenceProvider().searchCapabilities(), limited);
    expect(new Set(compiled.probes.flatMap((probe) => probe.questionIds)).size).toBe(2);
    // Compilation reserves capacity; only a physical probe attempt consumes a logical query unit.
    expect(compiled.ledger.consumed.queryUnits).toBe(0);
    expect(compiled.ledger.reserved?.queryUnits).toBe(2);
    expect(compiled.failures.some((failure) => failure.reason.startsWith("not_attempted"))).toBe(true);
  });

  it("preserves unsupported qualifier intent in failure and explicit degradation records", () => {
    const brief = draftBriefFromGoal("Find pyright usage");
    brief.vocabulary = brief.vocabulary.map((term) => ({ ...term, proposedQualifiers: ["language:python"] }));
    const capabilities = new OctocodeEvidenceProvider().searchCapabilities();
    const failed = compileProbes(brief, capabilities, ledger());
    expect(failed.failures[0]).toMatchObject({ qualifier: "language:python", degraded: false });
    expect(failed.probes).toHaveLength(0);
    const degraded = compileProbes(brief, capabilities, ledger(), { allowDegraded: true });
    expect(degraded.failures[0]).toMatchObject({ qualifier: "language:python", degraded: true });
    expect(degraded.probes[0]).toMatchObject({ intent: brief.questions[0]!.statement, providerQuery: "pyright" });
    expect(degraded.probes[0]!.rationale).toContain("Intended scope");
  });

  it("retains every required question and returns needs_input when there are more than six", () => {
    const brief = draftBriefFromGoal("Research these: toolAlpha, toolBeta, toolGamma, toolDelta, toolEpsilon, toolZeta, toolEta");
    const validated = validateBrief(brief);
    expect(validated.brief.questions).toHaveLength(7);
    expect(validated.brief.readiness).toMatchObject({ status: "needs_input", reasons: [{ code: "too_many_questions" }] });
    expect(validated.issues.map((issue) => issue.code)).toContain("too_many_questions");
  });
});

describe("brief validation policy", () => {
  it("downgrades unsourced observed terms, removes proof assertions, and retains explicit budget raises", () => {
    const brief = draftBriefFromGoal("Find pyright usage") as ResearchBrief & Record<string, unknown>;
    const input = structuredClone(brief) as ResearchBrief & Record<string, unknown>;
    (input.vocabulary[0] as unknown as Record<string, unknown>).status = "observed";
    (input.vocabulary[0] as unknown as Record<string, unknown>).verified = true;
    input.budgets.queryUnits = 20;
    const result = validateBrief(input);
    expect(result.brief.vocabulary[0]?.status).toBe("proposed");
    expect(result.issues.map((issue) => issue.code)).toContain("caller_evidence_label_removed");
    expect(result.issues.map((issue) => issue.code)).toContain("observed_term_missing_source");
    expect(result.issues.map((issue) => issue.code)).toContain("budget_explicitly_raised");
    expect(result.brief.budgets.queryUnits).toBe(20);
  });
});
