import { afterEach, describe, expect, it } from "vitest";
import {
  DeepWikiExplainer,
  applyFreshnessPolicy,
} from "../src/adapters/DeepWikiExplainer.js";
import {
  HybridRepoExplainer,
  verifyAnswerAgainstAnchors,
} from "../src/adapters/HybridRepoExplainer.js";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";
import type { EvidenceProvider } from "../src/adapters/EvidenceProvider.js";
import { setDeepWikiAskQuestion } from "../src/adapters/bridge.js";
import { collectEvidence } from "../src/core/collectEvidence.js";
import { normalizeFeatureSpec } from "../src/core/normalizeFeatureSpec.js";
import { explainRepoPattern } from "../src/mcp/tools/explainRepoPattern.js";
import { syntheticCases } from "./fixtures/research-integrity/synthetic-cases.js";

const GOAL = "Build a Next.js + Convex app with email magic links via Resend.";
const REPO = "headcodecms/headcodecms";
const NOW = () => new Date("2026-07-06T00:00:00.000Z");
const spec = normalizeFeatureSpec(GOAL);

function syntheticSpec(signal: string) {
  return normalizeFeatureSpec(`Research whether ${signal} is configured.`, {
    goalKind: "research",
    requiredConcepts: [signal],
    proofRequirements: [
      {
        key: "behavior_proof",
        description: `Configuration of ${signal}`,
        required: true,
        signals: [signal],
      },
    ],
  });
}

function syntheticAnchor(signal: string, proofLevel: "proved" | "partial" = "proved") {
  return {
    id: "synthetic_anchor",
    provider: "mock",
    repo: "synthetic/example",
    path: "src/coverage.ts",
    role: "behavior_proof",
    proofLevel,
    matchedSignal: signal,
    matchText: `${signal} is configured`,
    startLine: 1,
    endLine: 1,
  } as const;
}

/** Fake fetch for the DeepWiki HEAD probe. */
function fakeFetch(status: number, lastModified?: string): typeof fetch {
  return (async () =>
    new Response(null, {
      status,
      headers: lastModified ? { "last-modified": lastModified } : {},
    })) as unknown as typeof fetch;
}

const answerWithSignals = async (_repo: string, question: string) =>
  `For "${question}": the repo wires convexAuth with the Resend provider in convex/auth.ts.`;

afterEach(() => {
  setDeepWikiAskQuestion(undefined);
});

describe("DeepWiki freshness metadata (docs/05)", () => {
  it("collects lastIndexedAt from the last-modified header and stays fresh inside the window", async () => {
    const explainer = new DeepWikiExplainer({
      askQuestion: answerWithSignals,
      fetchImpl: fakeFetch(200, "Sat, 20 Jun 2026 00:00:00 GMT"),
      now: NOW,
    });
    const capability = await explainer.canExplain({ repo: REPO });
    expect(capability.available).toBe(true);
    expect(capability.lastIndexedAt).toBe("2026-06-20T00:00:00.000Z");
    expect(capability.stale).toBe(false);
  });

  it("marks the index stale when older than maxAgeDays", async () => {
    const explainer = new DeepWikiExplainer({
      askQuestion: answerWithSignals,
      fetchImpl: fakeFetch(200, "Wed, 01 Apr 2026 00:00:00 GMT"),
      maxAgeDays: 30,
      now: NOW,
    });
    const capability = await explainer.canExplain({ repo: REPO });
    expect(capability.stale).toBe(true);
    expect(capability.reason).toMatch(/day\(s\) old/);
  });

  it("prefers the injected getFreshness bridge over HTTP headers", async () => {
    const explainer = new DeepWikiExplainer({
      askQuestion: answerWithSignals,
      fetchImpl: fakeFetch(200, "Wed, 01 Apr 2026 00:00:00 GMT"),
      getFreshness: async () => ({
        lastIndexedAt: "2026-07-01T00:00:00.000Z",
        indexedCommit: "abc1234",
      }),
      now: NOW,
    });
    const capability = await explainer.canExplain({ repo: REPO });
    expect(capability.lastIndexedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(capability.indexedCommit).toBe("abc1234");
    expect(capability.stale).toBe(false);
  });

  it("explain applies the per-call freshnessPolicy (maxAgeDays + requireCommitCheck)", async () => {
    const explainer = new DeepWikiExplainer({
      askQuestion: answerWithSignals,
      fetchImpl: fakeFetch(200, "Sat, 20 Jun 2026 00:00:00 GMT"),
      now: NOW,
    });
    const strict = await explainer.explain({
      repo: { repo: REPO },
      feature: spec,
      questions: ["Where is the provider configured?"],
      freshnessPolicy: { maxAgeDays: 7 },
    });
    expect(strict.freshness?.stale).toBe(true);
    expect(strict.warnings.some((w) => w.includes("stale"))).toBe(true);
    // Raw DeepWiki answers stay unverified enrichment.
    expect(strict.answers.every((a) => a.verified === false)).toBe(true);

    const commitCheck = await explainer.explain({
      repo: { repo: REPO },
      feature: spec,
      questions: ["Where is the provider configured?"],
      freshnessPolicy: { requireCommitCheck: true },
    });
    expect(commitCheck.freshness?.stale).toBe(true);
    expect(commitCheck.freshness?.reason).toMatch(/indexed-commit check/);
  });

  it("applyFreshnessPolicy only escalates toward stale", () => {
    const fresh = { provider: "deepwiki", available: true, lastIndexedAt: "2026-07-01T00:00:00.000Z" };
    expect(applyFreshnessPolicy(fresh, { maxAgeDays: 30 }, NOW).stale).toBe(false);
    const alreadyStale = { ...fresh, stale: true, reason: "known stale" };
    const result = applyFreshnessPolicy(alreadyStale, { maxAgeDays: 3650 }, NOW);
    expect(result.stale).toBe(true);
    expect(result.reason).toBe("known stale");
  });
});

describe("hybrid source selection", () => {
  it("reads Python workflow and ecosystem configuration before dotfile/tree order under a tight cap", async () => {
    const reads: string[] = [];
    const provider = {
      name: "mock",
      getRepoMetadata: async () => ({ repo: REPO, owner: "headcodecms", name: "headcodecms", defaultBranch: "main" }),
      getRepoTree: async () => ({
        repo: REPO,
        paths: [".gitignore", "src/lint.py", "ruff.toml", ".github/workflows/lint.yml", "pyproject.toml"],
      }),
      getFile: async ({ repo, path }: { repo: string; path: string }) => {
        reads.push(path);
        return { provider: "mock", repo, path, content: "ruff = true" };
      },
    } as unknown as EvidenceProvider;
    const hybrid = new HybridRepoExplainer({ provider, maxFiles: 3 });
    await hybrid.explain({
      repo: { repo: REPO },
      feature: normalizeFeatureSpec("Research Python Ruff CI configuration", { stack: ["Python"] }),
      questions: ["How is Ruff configured?"],
    });

    expect(reads).toEqual(["ruff.toml", ".github/workflows/lint.yml", "pyproject.toml"]);
  });
});

describe("HybridRepoExplainer (DeepWiki explains, exact evidence verifies)", () => {
  // flips in Phase 1: Keywords only in the question cannot verify an answer.
  it("does not verify unrelated prose from a keyword that appears only in the question", () => {
    const fixture = syntheticCases.questionOnlyKeyword;
    const signal = fixture.anchorSignal;
    const answer = verifyAnswerAgainstAnchors(
      {
        question: fixture.question,
        answer: fixture.answer,
        evidence: [],
        confidence: 0.2,
        verified: false,
      },
      syntheticSpec(signal),
      [syntheticAnchor(signal)],
    );

    expect(answer.verified).toBe(false);
    expect(answer.confidence).toBeLessThan(0.85);
  });

  // flips in Phase 1: Fallback explanations identify unanswered questions even when observations exist.
  it("does not mark every fallback answer verified because one unrelated anchor is proved", async () => {
    const fixture = syntheticCases.fallbackAnswers;
    const provider = {
      name: "mock",
      getFile: async ({ repo, path }: { repo: string; path: string }) => ({
        provider: "mock" as const,
        repo,
        path,
        content: fixture.anchorText,
      }),
    } as unknown as EvidenceProvider;
    const hybrid = new HybridRepoExplainer({
      provider,
      resolveCandidate: async () => ({
        repo: REPO,
        owner: "headcodecms",
        name: "headcodecms",
        defaultBranch: "main",
        discoveredBy: [],
        matchedPaths: ["src/coverage.ts"],
        candidateSignals: [],
      }),
    });

    const output = await hybrid.explain({
      repo: { repo: REPO },
      feature: syntheticSpec(fixture.anchorSignal),
      questions: [...fixture.questions],
    });

    expect(output.anchors.some((anchor) => anchor.supportMethod === "exact_source_quotation")).toBe(true);
    expect(output.answers.every((answer) => answer.verified === false)).toBe(true);
  });

  // flips in Phase 1: A supported sentence plus an unsupported sentence does not yield a verified answer.
  it("does not blanket verify an answer containing a supported and an invented sentence", () => {
    const fixture = syntheticCases.supportedAndInvented;
    const answer = verifyAnswerAgainstAnchors(
      {
        question: fixture.question,
        answer: fixture.answer,
        evidence: [],
        confidence: 0.4,
        verified: false,
      },
      syntheticSpec(fixture.anchorSignal),
      [syntheticAnchor(fixture.anchorSignal)],
    );

    expect(answer.verified).toBe(false);
  });

  // flips in Phase 1: Caller-provided proof/confidence flags cannot restore verification.
  it("does not trust caller-supplied proof and verified flags on imported anchors", () => {
    const fixture = syntheticCases.importedProofFlags;
    const anchor = fixture.importedAnchor as unknown as Parameters<
      typeof verifyAnswerAgainstAnchors
    >[2][number];
    const answer = verifyAnswerAgainstAnchors(
      {
        question: fixture.question,
        answer: fixture.answer,
        evidence: [anchor],
        confidence: 0.2,
        verified: true,
      },
      syntheticSpec(fixture.anchorSignal),
      [anchor],
    );

    expect(answer.verified).toBe(false);
    expect(answer.confidence).toBeLessThan(0.85);
  });

  it("keeps enrichment answers unverified even when exact quotations are available", async () => {
    const provider = new MockEvidenceProvider();
    const deepwiki = new DeepWikiExplainer({
      askQuestion: async (_repo, question) =>
        question.includes("unrelated")
          ? "This claim mentions no proved implementation signal at all."
          : `The repo wires convexAuth with the Resend provider, and the client calls useAuthActions.`,
      fetchImpl: fakeFetch(200, "Wed, 01 Jul 2026 00:00:00 GMT"),
      now: NOW,
    });
    const hybrid = new HybridRepoExplainer({ provider, explainer: deepwiki, now: NOW });

    const out = await hybrid.explain({
      repo: { repo: REPO },
      feature: spec,
      questions: ["How is the email provider wired?", "Something unrelated?"],
    });

    expect(out.provider).toBe("hybrid");
    expect(out.freshness?.stale).toBe(false);

    const [verified, unverified] = out.answers;
    // Source quotations support only "this source states X" in Phase 1, not free prose.
    expect(verified!.verified).toBe(false);
    expect(verified!.evidence).toEqual([]);
    expect(out.anchors?.some((a) => a.supportMethod === "exact_source_quotation")).toBe(true);
    expect(verified!.confidence).toBeLessThanOrEqual(0.5);

    // Claims that no proved anchor backs stay unverified — never guessed.
    expect(unverified!.verified).toBe(false);
    expect(out.warnings.some((w) => w.includes("Hybrid verification: 0/2"))).toBe(true);
  });

  it("falls back to the exact-evidence explainer when DeepWiki is stale", async () => {
    // Wrap the mock provider under an octocode name to assert fallback labeling.
    const mock = new MockEvidenceProvider();
    const provider = {
      name: "octocode",
      searchCode: mock.searchCode.bind(mock),
      searchRepos: mock.searchRepos.bind(mock),
      getRepoMetadata: mock.getRepoMetadata.bind(mock),
      getFile: mock.getFile.bind(mock),
      getRepoTree: mock.getRepoTree.bind(mock),
    } as unknown as EvidenceProvider;

    const deepwiki = new DeepWikiExplainer({
      askQuestion: async () => {
        throw new Error("stale DeepWiki must not be asked when fallbackWhenStale is set");
      },
      fetchImpl: fakeFetch(200, "Wed, 01 Apr 2026 00:00:00 GMT"),
      now: NOW,
    });
    const hybrid = new HybridRepoExplainer({ provider, explainer: deepwiki, now: NOW });

    const out = await hybrid.explain({
      repo: { repo: REPO },
      feature: spec,
      questions: ["How is the email provider wired?"],
    });

    expect(out.provider).toBe("octocode-fallback");
    expect(out.freshness?.stale).toBe(true);
    expect(out.warnings.some((w) => w.includes("exact-evidence fallback"))).toBe(true);
    // A source excerpt alone does not establish the free-form fallback answer.
    expect(out.answers[0]!.verified).toBe(false);
    expect(out.answers[0]!.evidence.length).toBeGreaterThan(0);
  });

  it("falls back when DeepWiki is unavailable (HTTP error)", async () => {
    const provider = new MockEvidenceProvider();
    const deepwiki = new DeepWikiExplainer({
      askQuestion: answerWithSignals,
      fetchImpl: fakeFetch(404),
      now: NOW,
    });
    const hybrid = new HybridRepoExplainer({ provider, explainer: deepwiki, now: NOW });
    const out = await hybrid.explain({
      repo: { repo: REPO },
      feature: spec,
      questions: ["How is the email provider wired?"],
    });
    expect(out.provider).toBe("mock"); // fallback labeled by the evidence provider
    expect(out.warnings.some((w) => w.includes("unavailable"))).toBe(true);
    expect(out.answers[0]!.verified).toBe(false);
  });

  it("verifyAnswerAgainstAnchors never verifies from docs-only (partial) anchors", async () => {
    const provider = new MockEvidenceProvider();
    const docsCandidate = (await provider.getCandidates()).find(
      (c) => c.repo === "justinwlin/convex-magic-link-authentication",
    )!;
    const { anchors } = await collectEvidence(provider, spec, docsCandidate);
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.every((a) => a.proofLevel !== "proved")).toBe(true);

    const verified = verifyAnswerAgainstAnchors(
      {
        question: "q",
        answer: "The repo wires convexAuth with the Resend provider.",
        evidence: [],
        confidence: 0.5,
        verified: false,
      },
      spec,
      anchors,
    );
    expect(verified.verified).toBe(false);
  });
});

describe("research.explainRepoPattern (hybrid MCP tool)", () => {
  it("uses the exact-evidence flow in mock mode without a DeepWiki bridge", async () => {
    const output = await explainRepoPattern({
      featureSpec: spec,
      repos: [REPO],
      preferDeepWiki: true,
    });
    expect(output.explanations).toHaveLength(1);
    const explanation = output.explanations[0]!;
    expect(explanation.source).toBe("mock");
    expect(explanation.answers.every((a) => !a.verified)).toBe(true);
    expect(explanation.evidencePolicyVersion).toBe("phase1_exact_quotation_v1");
    expect(explanation.implementationMap.files).toEqual([]);
    expect(output.warnings.some((w) => w.includes("DeepWiki bridge not configured"))).toBe(true);
  });

  it("fails fast with a structured error in octocode mode when nothing is wired", async () => {
    await expect(
      explainRepoPattern({ featureSpec: spec, repos: [REPO], mode: "octocode" }),
    ).rejects.toMatchObject({ code: "provider_not_configured" });
  });
});
