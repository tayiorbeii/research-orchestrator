import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";
import { FileResearchCache, ResearchCacheReadError } from "../src/cache/FileResearchCache.js";
import { runResearch } from "../src/core/pipeline.js";
import { writeArtifacts } from "../src/core/writeArtifacts.js";
import { claimAssessorRegistry } from "../src/core/assessment/types.js";
import { isExactQuotationSupport } from "../src/core/evidencePolicy.js";
import { downgradeInlineRun, writePlanArtifact } from "../src/mcp/tools/writePlanArtifact.js";
import { HybridRepoExplainer } from "../src/adapters/HybridRepoExplainer.js";
import { normalizeFeatureSpec } from "../src/core/normalizeFeatureSpec.js";
import { explainRepoPattern } from "../src/mcp/tools/explainRepoPattern.js";
import type { ClaimAssessor } from "../src/core/assessment/types.js";
import { collectEvidence } from "../src/core/collectEvidence.js";
import type { EvidenceProvider } from "../src/adapters/EvidenceProvider.js";

const GOAL = "Build a Next.js + Convex app with email magic links via Resend.";

describe("Phase 2 v2 wiring", () => {
  afterEach(() => vi.restoreAllMocks());

  it("persists observation excerpts, ranges, immutable revisions, and receipts through artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "p2b2-cache-"));
    try {
      const cache = new FileResearchCache(root);
      class RangedProvider extends MockEvidenceProvider {
        private reads = 0;
        override async getFile(input: Parameters<MockEvidenceProvider["getFile"]>[0]) {
          const file = await super.getFile(input);
          this.reads += 1;
          return {
            ...file, ...(this.reads === 1 ? { resolvedRevision: "a".repeat(40) } : {}), readStatus: "partial" as const,
            startLine: 20, endLine: 19 + (file.content?.split("\n").length ?? 1),
            offsetStart: 400, offsetSemantics: "UTF-8 byte offset from file start",
          };
        }
      }
      const { run } = await runResearch({ goal: GOAL, provider: new RangedProvider(), deterministic: true });
      const source = run.observations[0]!;
      expect(source).toMatchObject({
        path: expect.any(String), requestedRevision: expect.any(String),
        resolvedRevision: "a".repeat(40), revisionStatus: "immutable",
        startLine: 20, endLine: expect.any(Number), readStatus: "partial", origin: "synthetic",
        offsetStart: 400, offsetSemantics: "UTF-8 byte offset from file start",
      });
      expect(source.contentHash).toBe(createHash("sha256").update(source.excerpt!).digest("hex"));
      await cache.saveRun(run);
      const loaded = await cache.loadRun(run.id);
      expect(loaded?.observations[0]).toEqual(source);
      expect(loaded.observations.filter((item) => item.kind === "repository_file").every((item) => item.revisionStatus === "immutable")).toBe(true);
      const outDir = join(root, "artifacts");
      await writeArtifacts(loaded!, outDir);
      const artifact = JSON.parse(await readFile(join(outDir, "evidence.json"), "utf8"));
      expect(artifact.observations[0]).toEqual(source);
      expect(artifact.assessments).toEqual(run.assessments);
      expect(artifact.coverage).toEqual(run.coverage);
      expect(artifact.outcome).toEqual(run.outcome);
      expect(artifact.observations.filter((item: { kind: string }) => item.kind === "repository_file").every((item: { revisionStatus: string }) => item.revisionStatus === "immutable")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks redacted excerpts, rehashes stored text, and removes exact-quote status", async () => {
    const root = await mkdtemp(join(tmpdir(), "p2b2-redaction-"));
    try {
      const { run } = await runResearch({ goal: GOAL, provider: new MockEvidenceProvider(), deterministic: true });
      const source = run.observations.find((item) => item.excerpt?.includes("AUTH_RESEND_KEY="));
      expect(source).toBeDefined();
      const sourceLines = source!.excerpt!.split("\n");
      const secretLineIndex = sourceLines.findIndex((line) => line.includes("AUTH_RESEND_KEY="));
      const sourceAnchor = source!.anchor!;
      const redactionAnchor = {
        ...sourceAnchor, id: "anchor-redacted-quote",
        startLine: (source!.startLine ?? 1) + secretLineIndex,
        endLine: (source!.startLine ?? 1) + secretLineIndex,
        matchText: sourceLines[secretLineIndex]!,
      };
      const sourceCandidate = run.candidates.find((candidate) => candidate.repo === source!.repo)!;
      const runWithRedactionAnchor = {
        ...run,
        candidates: run.candidates.map((candidate) => candidate.repo === source!.repo
          ? { ...candidate, candidateSignals: [...candidate.candidateSignals, { key: "redaction-test", label: "redaction test", source: "file" as const, confidence: 0.9, evidence: [redactionAnchor] }] }
          : candidate),
      };
      expect(sourceCandidate).toBeDefined();
      const cache = new FileResearchCache(join(root, "cache"));
      const savedPath = await cache.saveRun(runWithRedactionAnchor);
      const persisted = JSON.parse(await readFile(savedPath, "utf8")) as typeof runWithRedactionAnchor;
      const stored = persisted.observations.find((item) => item.id === source!.id)!;
      expect(stored.redacted).toBe(true);
      expect(stored.redactionNotes).toContain("Source excerpt was redacted before persistence.");
      expect(stored.excerpt).toContain("AUTH_RESEND_KEY=[REDACTED]");
      expect(stored.excerpt).not.toContain("re_FAKEFAKEFAKEFAKEFAKE1234");
      expect(stored.contentHash).toBe(createHash("sha256").update(stored.excerpt!).digest("hex"));
      expect(stored.anchor && isExactQuotationSupport(stored.anchor)).toBe(true);

      const loaded = await cache.loadRun(runWithRedactionAnchor.id);
      const outDir = join(root, "artifacts");
      await writeArtifacts(loaded, outDir);
      const artifact = JSON.parse(await readFile(join(outDir, "evidence.json"), "utf8"));
      const artifactObservation = artifact.observations.find((item: { id: string }) => item.id === source!.id);
      expect(artifactObservation.redacted).toBe(true);
      expect(artifactObservation.contentHash).toBe(createHash("sha256").update(artifactObservation.excerpt).digest("hex"));
      const affectedAnchors = artifact.evidence.filter((anchor: { repo?: string; path: string }) => anchor.repo === source!.repo && anchor.path === source!.path);
      expect(affectedAnchors.length).toBeGreaterThan(0);
      const redactedAnchor = artifact.evidence.find((anchor: { id: string }) => anchor.id === "anchor-redacted-quote");
      expect(redactedAnchor.evidencePolicyVersion).toBe("legacy_unvalidated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records failed and unavailable source reads as observations", async () => {
    const { run } = await runResearch({ goal: GOAL, provider: new MockEvidenceProvider(), deterministic: true });
    const candidate = run.candidates[0]!;
    const failedProvider = {
      name: "mock",
      getFile: async () => { throw new Error("transport reset"); },
    } as unknown as EvidenceProvider;
    const failed = await collectEvidence(failedProvider, run.featureSpec, candidate, () => new Date(0));
    expect(failed.observations).toHaveLength(candidate.matchedPaths.length);
    expect(failed.observations.every((item) => item.readStatus === "failed" && item.retrievedAt === new Date(0).toISOString())).toBe(true);
    const unavailableProvider = {
      name: "mock",
      getFile: async ({ repo, path }: { repo: string; path: string }) => ({
        provider: "mock" as const, repo, path: `provider/${path}`, unavailableReason: "not indexed",
      }),
    } as unknown as EvidenceProvider;
    const unavailable = await collectEvidence(unavailableProvider, run.featureSpec, candidate, () => new Date(0));
    expect(unavailable.observations[0]).toMatchObject({ path: `provider/${candidate.matchedPaths[0]}`, readStatus: "unavailable" });
  });

  it("stores bounded excerpts for large source reads with matching line ranges", async () => {
    const { run } = await runResearch({ goal: GOAL, provider: new MockEvidenceProvider(), deterministic: true });
    const candidate = { ...run.candidates[0]!, matchedPaths: ["src/large.ts"] };
    const signal = run.featureSpec.proofRequirements.find((requirement) => requirement.required && requirement.key !== "dependency_proof")?.signals[0] ?? "feature";
    const lines = Array.from({ length: 2_000 }, (_, index) => index === 1_000 ? `// ${signal}` : `// filler ${index}`);
    const content = lines.join("\n");
    const provider = {
      name: "mock",
      getFile: async ({ repo, path }: { repo: string; path: string }) => ({ provider: "mock" as const, repo, path, content }),
    } as unknown as EvidenceProvider;
    const collected = await collectEvidence(provider, run.featureSpec, candidate);
    const observation = collected.observations[0]!;
    expect(observation.excerpt?.length).toBeLessThan(content.length);
    expect(observation.contentHash).toBe(createHash("sha256").update(observation.excerpt!).digest("hex"));
    expect(observation.startLine).toBeLessThanOrEqual(collected.anchors[0]!.startLine!);
    expect(observation.endLine).toBeGreaterThanOrEqual(collected.anchors[0]!.endLine!);
  });

  it("distinguishes absent, corrupt, unknown-version, and legacy cache records", async () => {
    const root = await mkdtemp(join(tmpdir(), "p2b2-cache-errors-"));
    try {
      const cache = new FileResearchCache(root);
      await expect(cache.loadRun("missing")).rejects.toMatchObject({ code: "not_found" });
      const { run } = await runResearch({ goal: GOAL, provider: new MockEvidenceProvider(), deterministic: true });
      const savedPath = await cache.saveRun(run);
      const valid = await readFile(savedPath, "utf8");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(savedPath, "{bad json", "utf8");
      await expect(cache.loadRun(run.id)).rejects.toMatchObject({ code: "corrupt_json" });
      await writeFile(savedPath, JSON.stringify({ schemaVersion: 99 }), "utf8");
      await expect(cache.loadRun(run.id)).rejects.toMatchObject({ code: "unknown_schema_version" });
      const legacy = JSON.parse(valid) as Record<string, unknown>;
      delete legacy.schemaVersion;
      for (const field of ["observations", "assessments", "coverage", "outcome", "candidateStates", "explanationResults"]) delete legacy[field];
      await writeFile(savedPath, JSON.stringify(legacy), "utf8");
      const result = await cache.loadRunDetailed(run.id);
      expect(result.status).toBe("legacy_v1");
      if (result.status === "legacy_v1") {
        expect(result.run.evidencePolicyVersion).toBe("legacy_unvalidated");
        const artifactDir = join(root, "legacy-artifacts");
        await writeArtifacts(result.run, artifactDir);
        const evidence = JSON.parse(await readFile(join(artifactDir, "evidence.json"), "utf8"));
        expect(evidence.status).toBe("legacy_unvalidated");
      }
      await expect(cache.loadRun("missing")).rejects.toBeInstanceOf(ResearchCacheReadError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps inline assessments external and excludes them from supported coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "p2b2-inline-"));
    try {
      const { run } = await runResearch({ goal: GOAL, provider: new MockEvidenceProvider(), deterministic: true });
      const first = run.assessments[0]!;
      const callerRun = {
        ...run,
        observations: run.observations.map((observation) => ({ ...observation, origin: "synthetic" as const })),
        assessments: [{ ...first, status: "supported" as const, assessorOrigin: "engine" as const, evidenceOrigin: "synthetic" as const }],
        coverage: run.coverage.map((coverage) => ({ ...coverage, status: "satisfied" as const, supportedClaimIds: [first.claimId] })),
        outcome: { status: "complete" as const, reasons: [] },
      };
      const result = await writePlanArtifact({ researchRun: callerRun, outDir: join(root, "inline"), formats: ["evidence_json"] });
      expect(result.outcome?.status).not.toBe("complete");
      const artifact = JSON.parse(await readFile(join(root, "inline", "evidence.json"), "utf8"));
      expect(artifact.assessments[0].assessorOrigin).toBe("external");
      expect(artifact.assessments[0]).not.toHaveProperty("evidenceOrigin");
      expect(artifact.observations.every((observation: { origin: string }) => observation.origin === "external")).toBe(true);
      expect(artifact.coverage.find((item: { questionId: string }) => item.questionId === first.questionId).supportedClaimIds).toEqual([]);
      expect(artifact.status).not.toBe("complete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a synthetic complete run visibly labeled when no other mock markers remain", async () => {
    const root = await mkdtemp(join(tmpdir(), "p2b2-synthetic-banner-"));
    try {
      const { run } = await runResearch({ goal: GOAL, provider: new MockEvidenceProvider(), deterministic: true });
      const syntheticCompleteRun = {
        ...run,
        evidenceOrigin: "repository_observation" as const,
        assessments: run.assessments.map((assessment) => ({ ...assessment, status: "supported" as const, evidenceOrigin: "synthetic" as const })),
        candidateStates: run.candidateStates.map((state) => ({ ...state, state: "eligible" as const })),
        candidates: run.candidates.map((candidate) => ({
          ...candidate,
          candidateSignals: candidate.candidateSignals.map((signal) => ({
            ...signal, source: "file" as const, evidence: signal.evidence?.map((anchor) => ({ ...anchor, provider: "github" as const })),
          })),
        })),
      };
      const outDir = join(root, "artifacts");
      await writeArtifacts(syntheticCompleteRun, outDir);
      for (const name of ["research.md", "plan.md", "implementation-checklist.md"]) {
        expect(await readFile(join(outDir, name), "utf8")).toContain("**Synthetic/mock evidence:** fixture observations are not live repository findings.");
      }
      const evidence = JSON.parse(await readFile(join(outDir, "evidence.json"), "utf8"));
      expect(evidence.status).toBe("complete");
      expect(evidence.statusReasons).toContain("synthetic_evidence");
      expect(evidence.evidenceOrigin).toBe("synthetic_mock");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders equivalent artifacts for inline and cached runs after normalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "p2b2-equivalence-"));
    try {
      const { run } = await runResearch({ goal: GOAL, provider: new MockEvidenceProvider(), deterministic: true });
      const imported = downgradeInlineRun(run);
      const cache = new FileResearchCache(join(root, "cache"));
      await cache.saveRun(imported);
      const cached = await cache.loadRun(imported.id);
      const inlineDir = join(root, "inline");
      const cachedDir = join(root, "cached");
      await writePlanArtifact({ researchRun: run, outDir: inlineDir });
      await writeArtifacts(cached, cachedDir);
      for (const name of ["research.md", "plan.md", "evidence.json", "implementation-checklist.md"]) {
        const inline = await readFile(join(inlineDir, name), "utf8");
        const fromCache = await readFile(join(cachedDir, name), "utf8");
        const normalize = (artifact: string) => name === "evidence.json" ? JSON.parse(artifact) : artifact;
        expect(normalize(inline), name).toEqual(normalize(fromCache));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cannot compose quotation evidence across repositories for a single claim", () => {
    const assessor = claimAssessorRegistry.exact_source_quotation!;
    const claim = { claimId: "claim-1", questionId: "question-1", subject: { repo: "owner/one" }, assertion: "literal setting" };
    const otherRepoObservation = {
      id: "obs-two", kind: "repository_file" as const, repo: "owner/two", path: "config.yml",
      revisionStatus: "unknown" as const, excerpt: "literal setting", startLine: 1, endLine: 1,
      retrievedAt: new Date(0).toISOString(), retrievalMethod: "getFile", readStatus: "complete" as const,
      origin: "engine" as const, anchor: {
        id: "anchor-two", provider: "mock" as const, repo: "owner/two", path: "config.yml", startLine: 1,
        endLine: 1, matchText: "literal setting", role: "config_proof", proofLevel: "partial" as const,
        evidencePolicyVersion: "phase1_exact_quotation_v1" as const, supportMethod: "exact_source_quotation" as const,
      },
    };
    expect(assessor(claim, [otherRepoObservation]).status).toBe("not_assessed");
  });

  it("rejects forged external quotation support and anchors detached from their observations", () => {
    const assessor = claimAssessorRegistry.exact_source_quotation!;
    const claim = { claimId: "claim-quote", questionId: "question-quote", subject: { repo: "owner/repo", revision: "a".repeat(40) }, assertion: "literal setting" };
    const anchor = {
      id: "anchor-quote", provider: "mock" as const, repo: "owner/repo", ref: "a".repeat(40), path: "config.yml",
      startLine: 2, endLine: 2, matchText: "literal setting", role: "config_proof", proofLevel: "partial" as const,
      evidencePolicyVersion: "phase1_exact_quotation_v1" as const, supportMethod: "exact_source_quotation" as const,
    };
    const observation = {
      id: "obs-quote", kind: "repository_file" as const, repo: "owner/repo", path: "config.yml", resolvedRevision: "a".repeat(40),
      revisionStatus: "immutable" as const, excerpt: "first line\nliteral setting\nlast line", startLine: 1, endLine: 3,
      retrievedAt: new Date(0).toISOString(), retrievalMethod: "getFile", readStatus: "complete" as const,
      origin: "engine" as const, anchor,
    };
    const external = assessor(claim, [{ ...observation, origin: "external" }]);
    expect(external.status).toBe("not_assessed");
    expect(external.rationale).toMatch(/non-engine observations/i);
    const synthetic = assessor(claim, [{ ...observation, origin: "synthetic" }]);
    expect(synthetic).toMatchObject({ status: "supported", evidenceOrigin: "synthetic" });
    expect(synthetic.limitations).toContain("Synthetic fixture observation; not a live repository finding.");
    for (const detachedAnchor of [
      { ...anchor, repo: "owner/other" },
      { ...anchor, path: "other.yml" },
      { ...anchor, startLine: 3, endLine: 3 },
      { ...anchor, ref: "b".repeat(40) },
    ]) {
      expect(assessor(claim, [{ ...observation, anchor: detachedAnchor }]).status, JSON.stringify(detachedAnchor)).toBe("unsupported");
    }
  });

  it("uses only a registered bounded assessor for a positive non-quotation claim", async () => {
    const registry = claimAssessorRegistry as Record<string, ClaimAssessor>;
    registry.dependency_declaration = (claim, observations) => ({
      claimId: claim.claimId, questionId: claim.questionId, subject: claim.subject,
      assertion: claim.assertion, requiredObservationIds: observations.map((item) => item.id),
      status: "supported", method: "dependency_declaration", assessorOrigin: "engine",
      evidencePolicyVersion: "phase2_claim_evidence_v2", rationale: "Stub declaration parser found the named dependency.",
      remainingObligations: [], limitations: ["Does not establish runtime invocation."],
    });
    try {
      const { run } = await runResearch({ goal: GOAL, provider: new MockEvidenceProvider(), deterministic: true });
      const declaration = run.assessments.find((item) => item.method === "dependency_declaration");
      expect(declaration?.status).toBe("supported");
      expect(run.coverage.find((item) => item.questionId === declaration?.questionId)?.status).toBe("satisfied");
    } finally {
      delete registry.dependency_declaration;
    }
  });

  it("accounts for every requested explanation repo when one fails", async () => {
    const originalExplain = HybridRepoExplainer.prototype.explain;
    vi.spyOn(HybridRepoExplainer.prototype, "explain").mockImplementation(async function (input) {
      if (input.repo.repo === "owner/repo-8") throw new Error("fixture outage");
      return originalExplain.call(this, input);
    });
    vi.spyOn(FileResearchCache.prototype, "saveRun").mockResolvedValue("memory-cache");
    const repos = Array.from({ length: 8 }, (_, index) => `owner/repo-${index + 1}`);
    const result = await explainRepoPattern({ featureSpec: normalizeFeatureSpec(GOAL), repos, mode: "mock" });
    expect(result.runId).toBeTruthy();
    expect(result.explanationResults).toHaveLength(8);
    expect(result.explanationResults.filter((item) => item.status === "succeeded")).toHaveLength(7);
    expect(result.explanationResults[7]).toMatchObject({ repo: "owner/repo-8", status: "failed", error: "fixture outage" });
  });
});
