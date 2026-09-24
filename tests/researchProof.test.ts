import { describe, expect, it } from "vitest";
import type {
  CandidateRepo,
  EvidenceAnchor,
  FeatureSpec,
  ResearchRun,
} from "../src/schemas/index.js";
import type {
  EvidenceProvider,
  FileEvidence,
  FileReadRequest,
  NormalizedSearchResult,
  RepoMetadata,
  RepoRef,
  RepoSearchQuery,
  RepoSearchResult,
} from "../src/adapters/EvidenceProvider.js";
import { collectEvidence, lineHasSignal } from "../src/core/collectEvidence.js";
import { extractPattern } from "../src/core/extractPattern.js";
import { generateSearchProbes } from "../src/core/generateSearchProbes.js";
import { normalizeFeatureSpec } from "../src/core/normalizeFeatureSpec.js";
import { getMissingRequiredProof } from "../src/core/scoreCandidate.js";
import { deriveRunStatus } from "../src/core/writeArtifacts.js";
import { ResearchError } from "../src/core/errors.js";

class FileProvider implements EvidenceProvider {
  readonly name = "mock" as const;

  constructor(private readonly files: Record<string, string>) {}

  async searchCode(): Promise<NormalizedSearchResult[]> {
    return [];
  }

  async searchRepos(_query: RepoSearchQuery): Promise<RepoSearchResult[]> {
    return [];
  }

  async getRepoMetadata(repo: RepoRef): Promise<RepoMetadata> {
    const [owner = "acme", name = "project"] = repo.repo.split("/");
    return { repo: repo.repo, owner, name, defaultBranch: "main" };
  }

  async getFile(input: FileReadRequest): Promise<FileEvidence> {
    return {
      provider: "mock",
      repo: input.repo,
      path: input.path,
      content: this.files[`${input.repo}:${input.path}`] ?? this.files[input.path],
    };
  }
}

function candidate(paths: string[], repo = "acme/project"): CandidateRepo {
  const [owner = "acme", name = "project"] = repo.split("/");
  return {
    repo,
    owner,
    name,
    defaultBranch: "main",
    discoveredBy: ["test"],
    matchedPaths: paths,
    candidateSignals: [],
  };
}

function runFor(spec: FeatureSpec, evidence: EvidenceAnchor[]): ResearchRun {
  return {
    id: "run_test",
    createdAt: "2026-01-01T00:00:00.000Z",
    goal: spec.goal,
    featureSpec: spec,
    probes: [],
    candidates: [candidate([...new Set(evidence.map((anchor) => anchor.path))])],
    scoredCandidates: [],
    selectedRepos: [
      ...new Set(evidence.map((anchor) => anchor.repo).filter((repo): repo is string => Boolean(repo))),
    ],
    explanations: [],
    artifacts: [],
    warnings: [],
  };
}

describe("research intent and entity preservation", () => {
  it("preserves lowercase products and creates repo probes even for a recognized provider", () => {
    const spec = normalizeFeatureSpec(
      "Migrate flowdeck to stripe while preserving keyboard navigation",
    );

    expect(spec.goalKind).toBe("research");
    expect(spec.requiredConcepts).toEqual(
      expect.arrayContaining(["flowdeck", "stripe", "navigation"]),
    );
    const existence = spec.proofRequirements.find((req) => req.key === "existence_proof");
    expect(existence?.signals).toEqual(expect.arrayContaining(["flowdeck", "stripe"]));

    const repoQueries = generateSearchProbes(spec)
      .filter((probe) => probe.kind === "repo_search")
      .map((probe) => probe.query.toLowerCase());
    expect(repoQueries).toEqual(expect.arrayContaining(["flowdeck", "stripe"]));
  });

  it("keeps technology comparisons research-shaped instead of applying app profiles", () => {
    const spec = normalizeFeatureSpec(
      "Compare Convex authentication with Supabase authentication",
    );
    expect(spec.goalKind).toBe("research");
    expect(spec.proofRequirements.map((req) => req.key)).not.toContain("dependency_proof");
    expect(spec.proofRequirements.map((req) => req.key)).toEqual(
      expect.arrayContaining(["existence_proof", "behavior_proof"]),
    );
  });

  it("does not classify an explicit build goal as research because it contains guide", () => {
    expect(normalizeFeatureSpec("Build a guide app for new users").goalKind).toBe(
      "application",
    );
  });

  it("rejects research goals containing only generic proof signals", () => {
    expect(() => normalizeFeatureSpec("Research migration configuration")).toThrowError(
      ResearchError,
    );
  });
});

describe("research proof collection", () => {
  const goal = "Migrate Flowdeck to WezTerm while preserving keyboard navigation";

  it("matches case-insensitively and requires existence proof for every named system", async () => {
    const spec = normalizeFeatureSpec(goal);
    const { anchors } = await collectEvidence(
      new FileProvider({
        "README.md": "flowdeck supports keyboard navigation and compares itself with wezterm.",
      }),
      spec,
      candidate(["README.md"], "flowdeck/flowdeck"),
    );

    expect(anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "existence_proof",
          matchedSignal: "Flowdeck",
          proofLevel: "proved",
        }),
        expect.objectContaining({ role: "behavior_proof", proofLevel: "proved" }),
      ]),
    );
    expect(getMissingRequiredProof(spec, anchors).join("\n")).toContain("WezTerm");
    expect(deriveRunStatus(runFor(spec, anchors), anchors)).toMatchObject({
      status: "inconclusive",
      reasons: expect.arrayContaining(["missing_required_proof"]),
    });
  });

  it("records one existence anchor per named system and completes the proof contract", async () => {
    const spec = normalizeFeatureSpec(goal);
    const provider = new FileProvider({
      "flowdeck/flowdeck:README.md": "flowdeck documents keyboard navigation.",
      "wezterm/wezterm:README.md": "wezterm documents keyboard navigation.",
    });
    const flowdeck = await collectEvidence(
      provider,
      spec,
      candidate(["README.md"], "flowdeck/flowdeck"),
    );
    const wezterm = await collectEvidence(
      provider,
      spec,
      candidate(["README.md"], "wezterm/wezterm"),
    );
    const anchors = [...flowdeck.anchors, ...wezterm.anchors];

    const existenceSignals = anchors
      .filter((anchor) => anchor.role === "existence_proof")
      .map((anchor) => anchor.matchedSignal?.toLowerCase());
    expect(existenceSignals).toEqual(expect.arrayContaining(["flowdeck", "wezterm"]));
    expect(getMissingRequiredProof(spec, anchors)).toEqual([]);
    const run = runFor(spec, anchors);
    run.selectedRepos = ["flowdeck/flowdeck", "wezterm/wezterm"];
    expect(deriveRunStatus(run, anchors).status).toBe("complete");
  });

  it("keeps research documents out of implementation files and server/client flows", () => {
    const spec = normalizeFeatureSpec(goal);
    const pattern = extractPattern(spec, [], [
      {
        id: "ev_docs",
        provider: "mock",
        repo: "acme/project",
        path: "README.md",
        role: "existence_proof",
        proofLevel: "proved",
        matchedSignal: "Flowdeck",
      },
    ]);

    expect(pattern.implementationMap.files).toEqual([]);
    expect(pattern.implementationMap.dependencies).toEqual([]);
    expect(pattern.implementationMap.serverFlow).toEqual([]);
    expect(pattern.implementationMap.clientFlow).toEqual([]);
    expect(pattern.implementationSteps.join(" ")).not.toMatch(/Server:|Client:/);
  });

  it("classifies repository-discovery transport failures structurally", async () => {
    const spec = normalizeFeatureSpec(goal);
    const { anchors } = await collectEvidence(
      new FileProvider({ "README.md": "Flowdeck and WezTerm support keyboard navigation." }),
      spec,
      candidate(["README.md"]),
    );
    const run = runFor(spec, anchors);
    run.warnings = ['[provider_search_failed] Repo discovery failed for "Flowdeck": offline'];
    expect(deriveRunStatus(run, anchors).reasons).toContain("provider_search_failed");
  });

  it("does not accept manifest text as research behavior proof", async () => {
    const spec = normalizeFeatureSpec(goal);
    const { anchors } = await collectEvidence(
      new FileProvider({
        "package.json": JSON.stringify({
          description: "Flowdeck to WezTerm migration with keyboard navigation",
        }),
      }),
      spec,
      candidate(["package.json"], "flowdeck/flowdeck"),
    );

    expect(anchors.some((anchor) => anchor.role === "behavior_proof")).toBe(false);
    expect(getMissingRequiredProof(spec, anchors).join("\n")).toContain("behavior_proof");
  });

  it("recognizes common non-Node dependency manifests", async () => {
    const spec: FeatureSpec = {
      featureKey: "python-widget",
      goal: "Build a Python widget",
      feature: "Python widget",
      goalKind: "application",
      stack: ["Python"],
      libraries: [],
      providers: [],
      mustHave: [],
      shouldHave: [],
      exclude: [],
      requiredConcepts: ["fastapi"],
      likelyFiles: ["pyproject.toml"],
      proofRequirements: [
        {
          key: "dependency_proof",
          description: "Manifest contains FastAPI",
          required: true,
          signals: ["fastapi"],
        },
      ],
    };
    const { anchors } = await collectEvidence(
      new FileProvider({
        "pyproject.toml": 'dependencies = ["FastAPI"]',
        "poetry.lock": 'name = "fastapi"',
      }),
      spec,
      candidate(["pyproject.toml", "poetry.lock"]),
    );
    expect(anchors).toEqual([
      expect.objectContaining({
        path: "pyproject.toml",
        role: "dependency_proof",
        matchedSignal: "fastapi",
      }),
    ]);
  });
});

describe("signal boundaries", () => {
  it("matches case-insensitively without matching inside longer identifiers", () => {
    expect(lineHasSignal("uses FLOWDECK today", "Flowdeck")).toBe(true);
    expect(lineHasSignal("convexAuthNextjsMiddleware", "convexAuth")).toBe(false);
  });
});
