import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";
import { FileResearchCache } from "../src/cache/FileResearchCache.js";
import type { EvidenceProvider } from "../src/adapters/EvidenceProvider.js";
import { executeBrief } from "../src/core/brief/executeBrief.js";
import type { ResearchBrief } from "../src/schemas/researchBrief.js";
import type { BudgetLedger, SearchProbeV2 } from "../src/schemas/searchProbeV2.js";
import { ResearchError } from "../src/core/errors.js";
import { compileProbes } from "../src/core/brief/compileProbes.js";
import { writeArtifacts } from "../src/core/writeArtifacts.js";

const budgets = { maxQuestions: 6, queryUnits: 16, reconnaissanceReads: 4, fileReads: 48, fileReadsPerRepo: 12, refinementRounds: 1, refinementProbes: 4, deadlineMs: 60_000 };
const baseBrief: ResearchBrief = {
  id: "brief-test", revision: 1, goal: "Find a repository declaring @convex-dev/auth",
  questions: [{ id: "q1", statement: "Is the package declared?", intentHints: ["library_usage"], required: true, answerScope: "one source-backed example", obligations: [{ facts: [{ kind: "dependency", packageName: "@convex-dev/auth", file: "package.json" }], combine: "all", scope: "same_repository" }] }],
  mechanisms: [], vocabulary: [{ id: "t1", text: "@convex-dev/auth", questionIds: ["q1"], kind: "package", origin: "user_supplied", status: "observed" }],
  seeds: [{ repo: "headcodecms/headcodecms", origin: "user_supplied" }], allowedSourceKinds: ["repository_file"], budgets,
  readiness: { status: "ready" }, lookupOutcomes: [],
};
const probe: SearchProbeV2 = { id: "p1", questionIds: ["q1"], mechanismIds: [], termIds: ["t1"], purpose: "discovery", intent: "find package declarations", providerQuery: "@convex-dev/auth", providerArgs: { endpoint: "codeSearch" }, expectedSourceKinds: ["repository_file"], expectedPaths: ["package.json"], rationale: "User named a package", alternativesLeftOpen: [], predecessorProbeIds: [] };
const fakeValidation = (brief: ResearchBrief) => ({ brief, issues: [] });
const fakeCompile = (_brief: ResearchBrief, _capabilities: ReturnType<EvidenceProvider["searchCapabilities"]>, ledger: BudgetLedger) => ({ probes: [probe], failures: [], ledger });

describe("executeBrief", () => {
  it("writes v2 probe outcomes and budget receipts into the artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "brief-artifacts-"));
    try {
      const provider = new MockEvidenceProvider();
      vi.spyOn(provider, "searchCode").mockResolvedValue([]);
      const run = await executeBrief({ ...baseBrief, seeds: [] }, { provider, validateBrief: fakeValidation, compileProbes: fakeCompile });
      await writeArtifacts(run, root);
      const evidence = JSON.parse(await readFile(join(root, "evidence.json"), "utf8")) as {
        brief: { id: string; revision: number };
        probes: SearchProbeV2[];
        probeOutcomes: Array<{ probeId: string }>;
        budgetLedger: BudgetLedger;
      };
      expect(evidence.brief).toEqual({ id: baseBrief.id, revision: baseBrief.revision });
      expect(evidence.probes[0]?.providerArgs).toEqual({ endpoint: "codeSearch" });
      expect(evidence.probeOutcomes[0]?.probeId).toBe("p1");
      expect(evidence.budgetLedger.consumed.unbudgetedMetadataCalls).toBe(0);
      const research = await readFile(join(root, "research.md"), "utf8");
      expect(research).toContain("| Question | Compiled query | Endpoint | Outcome | Results |");
      expect(research).toContain("@convex-dev/auth");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reserves and executes one valid probe within a one-unit budget", async () => {
    const provider = new MockEvidenceProvider();
    const search = vi.spyOn(provider, "searchCode");
    const brief = { ...baseBrief, seeds: [], budgets: { ...budgets, queryUnits: 1 } };
    const run = await executeBrief(brief, { provider, validateBrief: fakeValidation });
    expect(search).toHaveBeenCalledOnce();
    expect(run.probeOutcomes?.[0]?.status).toBe("succeeded");
    expect(run.budgetLedger?.consumed.queryUnits).toBe(1);
    expect(run.budgetLedger?.reserved?.queryUnits).toBe(0);
  });

  it("counts issue searches as query units and issue reads against file and per-repository budgets", async () => {
    const issue = { repo: "acme/tool", number: 17, title: "Custom rules", body: "Proposal: planned support for custom rules.\nGITHUB_TOKEN=ghp_123456789012345678901234567890", state: "open" as const, url: "https://example.invalid/acme/tool/issues/17", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-02T00:00:00Z" };
    const provider = new MockEvidenceProvider({ fixture: { candidates: [], fileContents: {}, issues: { "acme/tool": [issue] } } });
    const brief: ResearchBrief = {
      ...baseBrief, seeds: [], allowedSourceKinds: ["repository_file", "issue_proposal"],
      questions: [{ id: "q1", statement: "Was custom rule support proposed?", intentHints: ["feature_exploration"], required: true, answerScope: "A user proposal.", obligations: [{ facts: [{ kind: "quotation", path: "issues/17", signals: ["planned support", "custom rules"], claimScope: "proposed" }], combine: "all", scope: "same_repository" }] }],
      vocabulary: [{ id: "issue-search", text: "custom rules", questionIds: ["q1"], kind: "symbol", origin: "user_supplied", status: "proposed" }],
    };
    const run = await executeBrief(brief, { provider, validateBrief: fakeValidation });
    expect(run.budgetLedger?.consumed).toMatchObject({ queryUnits: 1, fileReads: 1, fileReadsByRepo: { "acme/tool": 1 } });
    expect(run.observations).toContainEqual(expect.objectContaining({ kind: "issue_proposal", url: issue.url, path: "issues/17", revisionStatus: "moving_ref", redacted: true, excerpt: expect.stringContaining("GITHUB_TOKEN=[REDACTED]") }));
    expect(run.observations[0]?.excerpt).not.toContain("ghp_123456789012345678901234567890");
    expect(run.assessments).toContainEqual(expect.objectContaining({ questionId: "q1", status: "supported" }));
  });

  it("skips disallowed repository file reads and records them as untouched", async () => {
    const provider = new MockEvidenceProvider();
    const read = vi.spyOn(provider, "getFile");
    const brief = { ...baseBrief, allowedSourceKinds: ["repository_metadata"] as const };
    const run = await executeBrief(brief, { provider, validateBrief: fakeValidation, compileProbes: (_brief, _caps, ledger) => ({ probes: [], failures: [], ledger }) });
    expect(read).not.toHaveBeenCalled();
    expect(run.budgetLedger?.exhaustion?.referencedFiles).toContainEqual(expect.objectContaining({ reason: "source_kind_not_allowed" }));
    expect(run.assessments.every((assessment) => assessment.status !== "supported")).toBe(true);
  });

  it("dispatches repository identity probes through repository search", async () => {
    const provider = new MockEvidenceProvider();
    const repos = vi.spyOn(provider, "searchRepos").mockResolvedValue([]);
    const code = vi.spyOn(provider, "searchCode");
    const run = await executeBrief(baseBrief, {
      provider, validateBrief: fakeValidation,
      compileProbes: (_brief, _caps, ledger) => ({ probes: [{ ...probe, providerArgs: { endpoint: "repoSearch" } }], failures: [], ledger }),
    });
    expect(repos).toHaveBeenCalledWith({ query: probe.providerQuery });
    expect(code).not.toHaveBeenCalled();
    expect(run.probeOutcomes?.[0]?.status).toBe("succeeded");
  });

  it("reserves query units while compiling probes", () => {
    const brief = { ...baseBrief, budgets: { ...budgets, queryUnits: 1 } };
    const ledger: BudgetLedger = { limits: brief.budgets, consumed: { queryUnits: 0, rpcCount: 0, reconnaissanceReads: 0, fileReads: 0, fileReadsByRepo: {}, refinementRounds: 0, refinementProbes: 0 }, cancelled: false };
    const compiled = compileProbes(brief, new MockEvidenceProvider().searchCapabilities(), ledger, { allowDegraded: true });
    expect(compiled.probes).toHaveLength(1);
    expect(compiled.ledger.reserved?.queryUnits).toBe(1);
    expect(compiled.ledger.consumed.queryUnits).toBe(0);
  });

  it("reads caller seeds and assesses them without discovery or seed proof credit", async () => {
    class Provider extends MockEvidenceProvider {
      override async searchCode() { throw new Error("seed should bypass discovery"); }
    }
    const run = await executeBrief(baseBrief, { provider: new Provider(), deterministic: true, validateBrief: fakeValidation, compileProbes: fakeCompile });
    expect(run.candidates.map((candidate) => candidate.repo)).toEqual(["headcodecms/headcodecms"]);
    expect(run.observations.some((observation) => observation.path === "package.json")).toBe(true);
    expect(run.budgetLedger?.consumed.queryUnits).toBe(1);
    expect(run.budgetLedger?.consumed.unbudgetedMetadataCalls).toBe(1);
    expect(run.assessments.some((item) => item.status === "supported" && item.assessorOrigin === "engine")).toBe(true);
    expect(run.candidateStates[0]?.reason).toContain("Caller supplied seed");
  });

  it("resolves once per repository, reads every file at the SHA, and binds assessments and URLs to it", async () => {
    const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    class PinnedProvider extends MockEvidenceProvider {
      resolutions = 0;
      resolvedRepos: string[] = [];
      refs: Array<string | undefined> = [];
      override async resolveRevision(input: Parameters<MockEvidenceProvider["resolveRevision"]>[0]) {
        this.resolutions += 1;
        this.resolvedRepos.push(input.repo);
        return { sha, ref: input.ref ?? "fixture", source: "provider" as const };
      }
      override async getFile(input: Parameters<MockEvidenceProvider["getFile"]>[0]) {
        this.refs.push(input.ref);
        return super.getFile(input);
      }
    }
    const provider = new PinnedProvider();
    // Exercise the external-provider receipt path while keeping every read local.
    Object.defineProperty(provider, "name", { value: "github" });
    const run = await executeBrief(baseBrief, { provider, deterministic: true, validateBrief: fakeValidation, compileProbes: fakeCompile });
    expect(provider.resolutions).toBe(run.candidates.length);
    expect(new Set(provider.resolvedRepos).size).toBe(run.candidates.length);
    expect(provider.refs.length).toBeGreaterThan(0);
    expect(provider.refs.every((ref) => ref === sha)).toBe(true);
    expect(run.observations.filter((item) => item.kind === "repository_file").every((item) => item.revisionStatus === "immutable" && item.resolvedRevision === sha)).toBe(true);
    expect(run.assessments[0]?.subject.revision).toBe(sha);
    expect(run.observations.find((item) => item.anchor)?.anchor?.url).toContain(`/blob/${sha}/`);
    expect(run.budgetLedger?.consumed.metadataCallBreakdown).toMatchObject({ repoMetadata: run.candidates.length, revisionResolution: run.candidates.length });
  });

  it("records a moving branch and an assessment limitation when pinning fails", async () => {
    class UnpinnedProvider extends MockEvidenceProvider {
      override async resolveRevision() { return { unavailableReason: "offline" }; }
    }
    const run = await executeBrief(baseBrief, { provider: new UnpinnedProvider(), deterministic: true, validateBrief: fakeValidation, compileProbes: fakeCompile });
    expect(run.observations.filter((item) => item.kind === "repository_file").every((item) => item.revisionStatus === "moving_ref" && item.requestedRevision === "main" && item.resolvedRevision === undefined)).toBe(true);
    expect(run.warnings.some((warning) => warning.includes("revision limitation"))).toBe(true);
    expect(run.assessments[0]?.limitations.join(" ")).toContain("moving branch");
    expect(run.observations.find((item) => item.anchor)?.anchor?.url).toContain("/blob/main/");

    class UnknownRevisionProvider extends MockEvidenceProvider {
      override async getRepoMetadata({ repo }: { repo: string }) {
        const metadata = await super.getRepoMetadata({ repo });
        return { ...metadata, defaultBranch: undefined };
      }
      override async resolveRevision() { return { unavailableReason: "default branch unavailable" }; }
    }
    const unknown = await executeBrief(baseBrief, { provider: new UnknownRevisionProvider(), deterministic: true, validateBrief: fakeValidation, compileProbes: fakeCompile });
    expect(unknown.observations.filter((item) => item.kind === "repository_file").every((item) => item.revisionStatus === "unknown" && item.requestedRevision === undefined && item.resolvedRevision === undefined)).toBe(true);
    expect(unknown.observations.flatMap((item) => item.anchor?.url ? [item.anchor.url] : []).some((url) => url.includes("/blob/main/"))).toBe(false);
  });

  it("returns needs_input without provider calls", async () => {
    const provider = new MockEvidenceProvider();
    const search = vi.spyOn(provider, "searchCode");
    const capabilities = vi.spyOn(provider, "searchCapabilities");
    const metadata = vi.spyOn(provider, "getRepoMetadata");
    const read = vi.spyOn(provider, "getFile");
    const repoSearch = vi.spyOn(provider, "searchRepos");
    const brief = { ...baseBrief, readiness: { status: "needs_input" as const, reasons: [{ code: "missing_vocabulary" as const, questionIds: ["q1"], detail: "Need the package name." }] } };
    const run = await executeBrief(brief, { provider, validateBrief: fakeValidation, compileProbes: fakeCompile });
    expect(run.outcome.status).toBe("needs_input");
    expect(search).not.toHaveBeenCalled();
    expect(capabilities).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(repoSearch).not.toHaveBeenCalled();
    expect(run.probeOutcomes).toEqual([]);
  });

  it("records an empty result separately from a failed probe", async () => {
    const twoProbes = [probe, { ...probe, id: "p2", providerQuery: "second query" }];
    const provider = new MockEvidenceProvider();
    vi.spyOn(provider, "searchCode").mockImplementationOnce(async () => []).mockImplementationOnce(async () => { throw new Error("transport down"); });
    const run = await executeBrief(baseBrief, { provider, validateBrief: fakeValidation, compileProbes: () => ({ probes: twoProbes, failures: [], ledger: { limits: budgets, consumed: { queryUnits: 0, rpcCount: 0, reconnaissanceReads: 0, fileReads: 0, fileReadsByRepo: {}, refinementRounds: 0, refinementProbes: 0 }, cancelled: false } }) });
    expect(run.probeOutcomes).toMatchObject([
      { probeId: "p1", status: "succeeded", resultClass: "empty", queryUnits: 1, requestCount: 1 },
      { probeId: "p2", status: "failed", errorClass: "Error", queryUnits: 1, requestCount: 1 },
    ]);
  });

  // Live pilot regression: artifacts re-derived coverage from the FeatureSpec projection,
  // whose question ids differ from the brief's, so evidence.json reported every
  // question unresolved and the run inconclusive while the engine reported partial.
  it("renders the same brief coverage and outcome in evidence.json as the engine computed", async () => {
    const run = await executeBrief(baseBrief, { provider: new MockEvidenceProvider(), deterministic: true, validateBrief: fakeValidation, compileProbes: fakeCompile });
    expect(run.coverage.map((item) => item.questionId)).toEqual(["q1"]);
    expect(run.coverage[0]?.status).toBe("satisfied");
    const root = await mkdtemp(join(tmpdir(), "ro-brief-coverage-"));
    try {
      await writeArtifacts(run, root);
      const evidence = JSON.parse(await readFile(join(root, "evidence.json"), "utf8")) as { coverage: Array<{ questionId: string; status: string }>; outcome: { status: string } };
      expect(evidence.coverage.map((item) => [item.questionId, item.status])).toEqual(run.coverage.map((item) => [item.questionId, item.status]));
      expect(evidence.outcome.status).toBe(run.outcome.status);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps same-repository obligations bound while allowing across-example aggregation", async () => {
    const provider = {
      name: "github" as const,
      searchCapabilities: () => ({ capabilityVersion: "test", revisionPinning: false, supportedQualifiers: { codeSearch: [], repoSearch: [] }, codeSearch: true, repoSearch: true, issues: false, batch: { codeSearch: true, repoSearch: false } }),
      searchCode: async () => [], searchRepos: async () => [], getRepoTree: async () => ({ repo: "", paths: [] }),
      getRepoMetadata: async ({ repo }: { repo: string }) => ({ repo, owner: "owner", name: repo.split("/")[1]! }),
      getFile: async ({ repo, path }: { repo: string; path: string }) => ({ provider: "github" as const, repo, path, readStatus: "complete" as const, content: JSON.stringify({ dependencies: repo.endsWith("one") ? { "package-one": "1.0.0" } : { "package-two": "2.0.0" } }) }),
    } as EvidenceProvider;
    const composite: ResearchBrief = {
      ...baseBrief,
      id: "scope-contract", goal: "Find examples of both declarations", seeds: [{ repo: "owner/one", origin: "user_supplied" }, { repo: "owner/two", origin: "user_supplied" }],
      questions: [{ id: "q1", statement: "Both packages are declared", intentHints: ["library_usage"], required: true, answerScope: "declarations in examples", obligations: [{ facts: [{ kind: "dependency", packageName: "package-one" }, { kind: "dependency", packageName: "package-two" }], combine: "all", scope: "same_repository" }] }],
    };
    const sameRepo = await executeBrief(composite, { provider, validateBrief: fakeValidation, compileProbes: (_brief, _cap, ledger) => ({ probes: [], failures: [], ledger }) });
    expect(sameRepo.coverage[0]?.status).not.toBe("satisfied");
    const acrossExamples = await executeBrief({ ...composite, id: "scope-cross", questions: composite.questions.map((question) => ({ ...question, obligations: question.obligations.map((obligation) => ({ ...obligation, scope: "across_examples" as const })) })) }, { provider, validateBrief: fakeValidation, compileProbes: (_brief, _cap, ledger) => ({ probes: [], failures: [], ledger }) });
    expect(acrossExamples.coverage[0]?.status).toBe("satisfied");
  });

  it("carries consumption and parent lineage into a new resume run", async () => {
    const resumeLedger: BudgetLedger = { limits: budgets, consumed: { queryUnits: 3, rpcCount: 2, reconnaissanceReads: 0, fileReads: 1, fileReadsByRepo: { "headcodecms/headcodecms": 1 }, refinementRounds: 0, refinementProbes: 0 }, cancelled: false };
    const run = await executeBrief(baseBrief, { provider: new MockEvidenceProvider(), deterministic: true, validateBrief: fakeValidation, compileProbes: fakeCompile, resumeLedger, parentRunId: "parent-run" });
    const original = await executeBrief(baseBrief, { provider: new MockEvidenceProvider(), deterministic: true, validateBrief: fakeValidation, compileProbes: fakeCompile });
    expect(run.id).not.toBe(original.id);
    expect(run.budgetLedger?.consumed).toMatchObject({ queryUnits: 4, rpcCount: 10, fileReads: 6 });
    expect((run as typeof run & { parentRunId?: string }).parentRunId).toBe("parent-run");
    const root = await mkdtemp(join(tmpdir(), "brief-resume-cache-"));
    try {
      const cache = new FileResearchCache(root);
      await cache.saveRun(run);
      const loaded = await cache.loadRun(run.id);
      expect((loaded as typeof loaded & { parentRunId?: string }).parentRunId).toBe("parent-run");
      expect((loaded as typeof loaded & { probesV2?: SearchProbeV2[] }).probesV2).toEqual(run.compiledProbes);
      expect((loaded as typeof loaded & { probesV2?: SearchProbeV2[] }).probesV2?.[0]?.providerArgs).toEqual(run.compiledProbes?.[0]?.providerArgs);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps required questions visible when the query budget stops before their first probe", async () => {
    const second: SearchProbeV2 = { ...probe, id: "p2", questionIds: ["q2"], providerQuery: "second" };
    const brief = { ...baseBrief, seeds: [], questions: [baseBrief.questions[0]!, { ...baseBrief.questions[0]!, id: "q2", statement: "Second required question", obligations: [{ ...baseBrief.questions[0]!.obligations[0]!, facts: [{ kind: "dependency" as const, packageName: "second-package", file: "second.json" }] }] }], budgets: { ...budgets, queryUnits: 1 } };
    const run = await executeBrief(brief, { provider: new MockEvidenceProvider(), validateBrief: fakeValidation, compileProbes: () => ({ probes: [probe, second], failures: [], ledger: { limits: { ...budgets, queryUnits: 1 }, consumed: { queryUnits: 0, rpcCount: 0, reconnaissanceReads: 0, fileReads: 0, fileReadsByRepo: {}, refinementRounds: 0, refinementProbes: 0 }, cancelled: false } }) });
    expect(run.coverage.find((item) => item.questionId === "q2")?.status).toBe("not_attempted");
    expect(run.outcome.status).not.toBe("complete");
    expect(run.budgetLedger?.exhaustion?.questions).toContainEqual({ questionId: "q2", reason: "No probe or source read was attempted." });
  });

  it("distinguishes an access denial from a transport failure without retrying it", async () => {
    const provider = new MockEvidenceProvider();
    const search = vi.spyOn(provider, "searchCode").mockRejectedValue(new ResearchError("access_denied", "Private repository."));
    const run = await executeBrief(baseBrief, { provider, validateBrief: fakeValidation, compileProbes: fakeCompile });
    expect(search).toHaveBeenCalledTimes(1);
    expect(run.probeOutcomes?.[0]).toMatchObject({ status: "failed", failureKind: "access_denied", queryUnits: 1, requestCount: 1 });
    expect(run.outcome.reasons).toContain("provider_access_denied");
  });

  it("keeps pagination truncation distinct from an empty search", async () => {
    const provider = new MockEvidenceProvider();
    vi.spyOn(provider, "searchCode").mockResolvedValue([{ repo: "owner/repo", path: "src/lint.ts", probeId: "p1", truncated: true }]);
    const run = await executeBrief(baseBrief, { provider, validateBrief: fakeValidation, compileProbes: fakeCompile });
    expect(run.probeOutcomes?.[0]).toMatchObject({ status: "succeeded", resultClass: "pagination_limit", truncated: true });
  });

  it("preserves an empty scoped probe and performs only one linked refinement", async () => {
    const provider = new MockEvidenceProvider();
    const search = vi.spyOn(provider, "searchCode").mockResolvedValueOnce([]).mockResolvedValueOnce([{ repo: "owner/repo", path: "README.md", probeId: "p1" }]);
    const scoped = { ...probe, providerQuery: "@convex-dev/auth language:typescript", providerArgs: { query: "@convex-dev/auth language:typescript" } };
    const run = await executeBrief(baseBrief, { provider, validateBrief: fakeValidation, compileProbes: () => ({ probes: [scoped], failures: [], ledger: { limits: budgets, consumed: { queryUnits: 0, rpcCount: 0, reconnaissanceReads: 0, fileReads: 0, fileReadsByRepo: {}, refinementRounds: 0, refinementProbes: 0 }, cancelled: false } }) });
    expect(search).toHaveBeenCalledTimes(2);
    expect(run.compiledProbes?.map((item) => item.id)).toEqual([scoped.id, `${scoped.id}-refine-1`]);
    expect(run.compiledProbes?.[1]).toMatchObject({ refinementReason: "empty_scoped_result", predecessorProbeIds: [scoped.id] });
    expect(run.probeOutcomes?.map((item) => item.probeId)).toEqual([scoped.id, `${scoped.id}-refine-1`]);
  });

  it("never semantically rewrites a failed transport query", async () => {
    const provider = new MockEvidenceProvider();
    const search = vi.spyOn(provider, "searchCode").mockRejectedValue(new Error("socket closed"));
    const scoped = { ...probe, providerQuery: "@convex-dev/auth language:typescript", providerArgs: { query: "@convex-dev/auth language:typescript" } };
    const run = await executeBrief(baseBrief, { provider, validateBrief: fakeValidation, compileProbes: () => ({ probes: [scoped], failures: [], ledger: { limits: budgets, consumed: { queryUnits: 0, rpcCount: 0, reconnaissanceReads: 0, fileReads: 0, fileReadsByRepo: {}, refinementRounds: 0, refinementProbes: 0 }, cancelled: false } }) });
    expect(search).toHaveBeenCalledTimes(1);
    expect(run.compiledProbes).toHaveLength(1);
    expect(run.probeOutcomes?.[0]?.failureKind).toBe("transport_failure");
  });

  it("does not duplicate completed probes on resume", async () => {
    const original = await executeBrief(baseBrief, { provider: new MockEvidenceProvider(), deterministic: true, validateBrief: fakeValidation, compileProbes: fakeCompile });
    const provider = new MockEvidenceProvider();
    const search = vi.spyOn(provider, "searchCode");
    const resumed = await executeBrief(baseBrief, { provider, deterministic: true, validateBrief: fakeValidation, compileProbes: fakeCompile, resumeLedger: original.budgetLedger, resumeRun: original, parentRunId: original.id });
    expect(search).not.toHaveBeenCalled();
    expect(resumed.parentRunId).toBe(original.id);
    expect(resumed.probeOutcomes?.filter((item) => item.probeId === "p1")).toHaveLength(1);
  });

  it("does not reuse prior support when the resolved SHA changes during resume", async () => {
    const firstSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const nextSha = "cccccccccccccccccccccccccccccccccccccccc";
    class RevisionProvider extends MockEvidenceProvider {
      constructor(private readonly sha: string) { super(); }
      override async resolveRevision(input: Parameters<MockEvidenceProvider["resolveRevision"]>[0]) {
        return { sha: this.sha, ref: input.ref ?? "fixture", source: "provider" as const };
      }
    }
    const original = await executeBrief(baseBrief, { provider: new RevisionProvider(firstSha), deterministic: true, validateBrief: fakeValidation, compileProbes: fakeCompile });
    const resumed = await executeBrief(baseBrief, { provider: new RevisionProvider(nextSha), deterministic: true, validateBrief: fakeValidation, compileProbes: fakeCompile, resumeLedger: original.budgetLedger, resumeRun: original, parentRunId: original.id });
    expect(original.assessments[0]?.subject.revision).toBe(firstSha);
    expect(resumed.observations.filter((item) => item.kind === "repository_file").every((item) => item.resolvedRevision === nextSha)).toBe(true);
    expect(resumed.assessments[0]?.subject.revision).toBe(nextSha);
    expect(resumed.assessments[0]?.requiredObservationIds.every((id) => resumed.observations.some((item) => item.id === id && item.resolvedRevision === nextSha))).toBe(true);
  });

  it("does not reuse a completed probe id after its provider query changes", async () => {
    const original = await executeBrief(baseBrief, { provider: new MockEvidenceProvider(), deterministic: true, validateBrief: fakeValidation, compileProbes: fakeCompile });
    const provider = new MockEvidenceProvider();
    const search = vi.spyOn(provider, "searchCode");
    const revisedProbe = { ...probe, providerQuery: "@convex-dev/auth revised" };
    await executeBrief(baseBrief, { provider, deterministic: true, validateBrief: fakeValidation, compileProbes: () => ({ probes: [revisedProbe], failures: [], ledger: { limits: budgets, consumed: { queryUnits: 0, rpcCount: 0, reconnaissanceReads: 0, fileReads: 0, fileReadsByRepo: {}, refinementRounds: 0, refinementProbes: 0 }, cancelled: false } }), resumeLedger: original.budgetLedger, resumeRun: original, parentRunId: original.id });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("spends extra search and the first read on the weaker covered question, keeping exhaustion in the receipt", async () => {
    const mixed: ResearchBrief = {
      ...baseBrief, id: "coverage-demo", seeds: [], budgets: { ...budgets, queryUnits: 3, fileReads: 1, fileReadsPerRepo: 1 },
      questions: [
        { ...baseBrief.questions[0]!, id: "lint", statement: "Lint configuration exists", obligations: [{ facts: [{ kind: "quotation", path: "lint.yml", signals: ["lint enabled"] }], combine: "all", scope: "same_repository" }] },
        { ...baseBrief.questions[0]!, id: "coverage", statement: "Coverage configuration exists", obligations: [{ facts: [{ kind: "quotation", path: "coverage.yml", signals: ["coverage threshold"] }], combine: "all", scope: "same_repository" }] },
      ],
    };
    const probes: SearchProbeV2[] = [
      { ...probe, id: "lint-first", questionIds: ["lint"], providerQuery: "lint" },
      { ...probe, id: "coverage-first", questionIds: ["coverage"], providerQuery: "coverage" },
      { ...probe, id: "lint-extra", questionIds: ["lint"], providerQuery: "lint-extra" },
      { ...probe, id: "coverage-extra", questionIds: ["coverage"], providerQuery: "coverage-extra" },
    ];
    class MixedProvider extends MockEvidenceProvider {
      calls: string[] = [];
      reads: string[] = [];
      override async searchCode(items: Parameters<MockEvidenceProvider["searchCode"]>[0]) {
        const query = items[0]?.query ?? "";
        this.calls.push(query);
        if (query === "lint") return ["lint/a", "lint/b", "lint/c"].map((repo) => ({ repo, path: "lint.yml", probeId: items[0]!.id }));
        if (query === "coverage" || query === "coverage-extra") return [{ repo: "coverage/one", path: "coverage.yml", probeId: items[0]!.id }];
        return [];
      }
      override async getFile(input: Parameters<MockEvidenceProvider["getFile"]>[0]) {
        this.reads.push(input.path);
        return { provider: "mock" as const, repo: input.repo, path: input.path, readStatus: "complete" as const, content: input.path === "lint.yml" ? "lint enabled" : "coverage threshold" };
      }
    }
    const provider = new MixedProvider();
    const run = await executeBrief(mixed, { provider, validateBrief: fakeValidation, compileProbes: (_brief, _caps, ledger) => ({ probes, failures: [], ledger }) });
    expect(provider.calls).toEqual(["lint", "coverage", "coverage-extra"]);
    expect(provider.reads[0]).toBe("coverage.yml");
    expect(run.budgetLedger?.exhaustion?.referencedFiles.length).toBeGreaterThan(0);
    expect(run.budgetLedger?.exhaustion?.repositories.length).toBeGreaterThan(0);
    expect(run.budgetLedger?.exhaustion?.questions.length).toBeGreaterThan(0);
    expect(run.outcome.status).not.toBe("complete");
  });
});
