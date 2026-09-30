import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileResearchCache } from "../src/cache/FileResearchCache.js";
import { collectEvidence } from "../src/core/collectEvidence.js";
import { deriveRunStatus } from "../src/core/writeArtifacts.js";
import { scoreRepos } from "../src/mcp/tools/scoreRepos.js";
import { writePlanArtifact } from "../src/mcp/tools/writePlanArtifact.js";
import { EVIDENCE_POLICY_VERSION } from "../src/core/evidencePolicy.js";
import type { CandidateRepo, FeatureSpec, ResearchRun } from "../src/schemas/index.js";
import type { EvidenceProvider } from "../src/adapters/EvidenceProvider.js";

const spec: FeatureSpec = {
  featureKey: "exact-source",
  goal: "Research the source statement for feature X",
  feature: "feature X",
  goalKind: "research",
  stack: [], libraries: [], providers: [], mustHave: [], shouldHave: [], exclude: [],
  requiredConcepts: ["feature X"], likelyFiles: ["README.md"],
  proofRequirements: [{ key: "behavior_proof", description: "Source states feature X", required: true, signals: ["feature X"] }],
};

const candidate: CandidateRepo = {
  repo: "acme/example", owner: "acme", name: "example", discoveredBy: ["test"],
  matchedPaths: ["README.md"], candidateSignals: [],
};

const provider = {
  name: "mock",
  getFile: async ({ repo, path }: { repo: string; path: string }) => ({
    provider: "mock", repo, path, content: "This source states feature X exactly.",
  }),
} as unknown as EvidenceProvider;

function legacyRun(anchor: Record<string, unknown>): ResearchRun {
  return {
    id: "run_legacy", createdAt: "2026-01-01T00:00:00.000Z", goal: spec.goal,
    featureSpec: spec, probes: [],
    candidates: [{ ...candidate, candidateSignals: [{ key: "file", label: "file", source: "file", confidence: 0.99, evidence: [anchor] as never }] }],
    scoredCandidates: [], selectedRepos: [candidate.repo], explanations: [], artifacts: [], warnings: [],
  };
}

describe("Phase 1 evidence policy", () => {
  it("case 19: imported proof flags cannot mint score support", async () => {
    const anchor = {
      id: "caller-proof", provider: "mock", repo: candidate.repo, path: "README.md",
      role: "behavior_proof", proofLevel: "proved", matchedSignal: "feature X",
      matchText: "This source states feature X exactly.", startLine: 1, endLine: 1,
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION, supportMethod: "exact_source_quotation",
    };
    const result = await scoreRepos({ featureSpec: spec, candidates: [candidate], evidence: [anchor] as never });
    expect(result.scoredCandidates[0]!.missingProof).toContain("behavior_proof: Source states feature X");
    expect(result.summary.accepted).toBe(0);
  });

  it("an exact read quotation supports only its role and can satisfy a complete run", async () => {
    const { anchors } = await collectEvidence(provider, spec, candidate);
    const anchor = anchors.find((item) => item.role === "behavior_proof")!;
    expect(anchor).toMatchObject({
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      supportMethod: "exact_source_quotation",
      path: "README.md", startLine: 1, endLine: 1,
    });
    const run: ResearchRun = {
      ...legacyRun(anchor), evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      candidates: [candidate],
    };
    expect(deriveRunStatus(run, anchors)).toEqual({ status: "complete", reasons: [] });
  });

  it("downgrades asserted markers and implementation evidence on inline artifact runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "ro-inline-policy-"));
    try {
      const claimed = {
        id: "caller-proof", provider: "mock", repo: candidate.repo, path: "README.md",
        role: "behavior_proof", proofLevel: "proved", matchedSignal: "feature X",
        matchText: "This source states feature X exactly.", startLine: 1, endLine: 1,
        evidencePolicyVersion: EVIDENCE_POLICY_VERSION, supportMethod: "exact_source_quotation",
      };
      const result = await writePlanArtifact({
        researchRun: { ...legacyRun(claimed), evidencePolicyVersion: EVIDENCE_POLICY_VERSION },
        outDir: root,
      });
      const evidence = JSON.parse(await readFile(result.artifacts.find((a) => a.kind === "evidence")!.path, "utf8")) as {
        status: string;
        evidencePolicyVersion: string;
        evidence: Array<{ proofLevel: string; evidencePolicyVersion?: string }>;
      };
      expect(evidence.status).toBe("legacy_unvalidated");
      expect(evidence.evidencePolicyVersion).toBe("legacy_unvalidated");
      expect(evidence.evidence[0]).toMatchObject({ proofLevel: "partial", evidencePolicyVersion: "legacy_unvalidated" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cases 21 and 30: legacy cache reads are conservative and never rewrite bytes; new runs carry a marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "ro-policy-"));
    try {
      const cache = new FileResearchCache(root);
      const legacyAnchor = {
        id: "legacy", provider: "mock", repo: candidate.repo, path: "README.md",
        role: "behavior_proof", proofLevel: "proved", matchText: "feature X",
        startLine: 1, endLine: 1, evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
        supportMethod: "exact_source_quotation",
      };
      const run = legacyRun(legacyAnchor);
      run.scoredCandidates = [{
        repo: candidate.repo, score: 0.9, class: "reference", positiveSignals: [{
          key: "behavior_proof", label: "source says feature X", weight: 0.9,
          source: "file", confidence: 0.95, evidence: [legacyAnchor as never],
        }], negativeSignals: [], missingProof: [], rejectionReasons: [], nextAction: "extract",
      }];
      run.explanations = [{
        repo: candidate.repo, evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
        evidenceOrigin: "synthetic_mock", source: "mock",
        answers: [{ question: "q", answer: "a", evidence: [legacyAnchor as never], confidence: 0.99, verified: true }],
        implementationMap: {
          dependencies: [], files: [{ path: "README.md", role: "behavior", evidence: [legacyAnchor as never] }],
          serverFlow: [], clientFlow: [], environmentVariables: [], pitfalls: [],
        },
        warnings: [],
      }];
      const raw = JSON.stringify(run, null, 2);
      await mkdir(join(root, "runs"), { recursive: true });
      const file = join(root, "runs", "run_legacy.json");
      await writeFile(file, raw, "utf8");

      const loaded = await cache.loadRun("run_legacy");
      expect(loaded?.evidencePolicyVersion).toBe("legacy_unvalidated");
      expect(loaded?.candidates[0]!.candidateSignals[0]!.evidence![0]).toMatchObject({
        proofLevel: "partial", evidencePolicyVersion: "legacy_unvalidated", supportMethod: undefined,
      });
      expect(loaded?.scoredCandidates[0]).toMatchObject({
        score: 0.4, class: "unknown", nextAction: "read_more",
      });
      expect(loaded?.scoredCandidates[0]?.positiveSignals[0]?.evidence?.[0]).toMatchObject({
        proofLevel: "partial", evidencePolicyVersion: "legacy_unvalidated", supportMethod: undefined,
      });
      expect(loaded?.explanations[0]).toMatchObject({
        evidencePolicyVersion: "legacy_unvalidated",
        answers: [{ verified: false, confidence: 0.5 }],
      });
      expect(loaded?.explanations[0]?.answers[0]?.evidence[0]).toMatchObject({
        proofLevel: "partial", evidencePolicyVersion: "legacy_unvalidated", supportMethod: undefined,
      });
      expect(loaded?.explanations[0]?.implementationMap.files[0]?.evidence[0]).toMatchObject({
        proofLevel: "partial", evidencePolicyVersion: "legacy_unvalidated", supportMethod: undefined,
      });
      expect(await readFile(file, "utf8")).toBe(raw);

      await cache.saveRun({ ...legacyRun(legacyAnchor), id: "run_current", evidencePolicyVersion: EVIDENCE_POLICY_VERSION });
      expect((await cache.loadRun("run_current"))?.evidencePolicyVersion).toBe(EVIDENCE_POLICY_VERSION);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
