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
import { EVIDENCE_POLICY_VERSION } from "../src/core/evidencePolicy.js";
import { ResearchError } from "../src/core/errors.js";
import { readFileSync } from "node:fs";
import { syntheticCases } from "./fixtures/research-integrity/synthetic-cases.js";

const historicalGoal = JSON.parse(
  readFileSync(new URL("./fixtures/research-integrity/historical-goal.json", import.meta.url), "utf8"),
) as { goal: string; provenance: string };

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
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
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
  it("keeps known mappings and behavior terms while excluding unknown lowercase entities", () => {
    const spec = normalizeFeatureSpec(
      "Migrate flowdeck to stripe while preserving keyboard navigation",
    );

    expect(spec.goalKind).toBe("research");
    expect(spec.requiredConcepts).toEqual(expect.arrayContaining(["stripe", "navigation"]));
    expect(spec.requiredConcepts).not.toContain("flowdeck");
    const existence = spec.proofRequirements.find((req) => req.key === "existence_proof");
    expect(existence?.signals).toContain("stripe");
    expect(existence?.signals).not.toContain("flowdeck");

    const repoQueries = generateSearchProbes(spec)
      .filter((probe) => probe.kind === "repo_search")
      .map((probe) => probe.query.toLowerCase());
    expect(repoQueries).toContain("stripe");
    expect(repoQueries).not.toContain("flowdeck");
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
          supportMethod: "exact_source_quotation",
        }),
        expect.objectContaining({ role: "behavior_proof", supportMethod: "exact_source_quotation" }),
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

  it("requires all research-role signals in one quoted excerpt", async () => {
    const spec: FeatureSpec = {
      featureKey: "ruff-ci", goal: "Research CI enforcement of Ruff", feature: "Ruff CI",
      goalKind: "research", stack: [], libraries: [], providers: [], mustHave: [], shouldHave: [], exclude: [],
      requiredConcepts: ["Ruff", "CI"], likelyFiles: ["README.md"],
      proofRequirements: [{
        key: "behavior_proof", description: "CI enforcement of Ruff", required: true, signals: ["Ruff", "CI"],
      }],
    };
    const { anchors } = await collectEvidence(
      new FileProvider({ "README.md": "Ruff replaces Flake8.\nCI runs tests." }),
      spec,
      candidate(["README.md"]),
    );
    expect(anchors.filter((anchor) => anchor.role === "behavior_proof")).toHaveLength(2);
    expect(getMissingRequiredProof(spec, anchors)).toContain(
      "behavior_proof: one source quotation must contain Ruff and CI: CI enforcement of Ruff",
    );
    expect(deriveRunStatus(runFor(spec, anchors), anchors)).toMatchObject({
      status: "inconclusive",
      reasons: expect.arrayContaining(["missing_required_proof"]),
    });
  });

  it("records no quotation support when a file read returns a different path", async () => {
    const spec: FeatureSpec = {
      featureKey: "ruff-ci", goal: "Research CI enforcement of Ruff", feature: "Ruff CI",
      goalKind: "research", stack: [], libraries: [], providers: [], mustHave: [], shouldHave: [], exclude: [],
      requiredConcepts: ["Ruff", "CI"], likelyFiles: ["README.md"],
      proofRequirements: [{ key: "behavior_proof", description: "CI enforcement of Ruff", required: true, signals: ["Ruff", "CI"] }],
    };
    const mismatched = {
      name: "mock" as const,
      getFile: async ({ repo }: { repo: string }) => ({
        provider: "mock" as const, repo, path: "docs/redirected.md", content: "CI runs Ruff.",
      }),
    } as unknown as EvidenceProvider;
    const { anchors, warnings } = await collectEvidence(mismatched, spec, candidate(["README.md"]));
    expect(anchors).toEqual([]);
    expect(warnings.some((warning) => warning.includes("returned content for a different path"))).toBe(true);
  });

  // flips in Phase 1: Ignore-file/changelog mentions do not prove unrelated implementation behavior.
  it("does not promote ignore-file or changelog hits to implementation proof", async () => {
    const fixture = syntheticCases.ignoreAndChangelog;
    const spec = normalizeFeatureSpec(fixture.goal, {
      goalKind: "research",
      requiredConcepts: ["Ruff", "CI"],
      proofRequirements: [
        {
          key: "behavior_proof",
          description: "CI enforcement of Ruff lint",
          required: true,
          signals: ["Ruff", "CI"],
        },
      ],
    });
    const { anchors } = await collectEvidence(
      new FileProvider(fixture.files),
      spec,
      candidate(Object.keys(fixture.files)),
    );

    expect(anchors.length).toBeGreaterThan(0);
    expect(
      anchors.some((anchor) => anchor.role === "behavior_proof" && anchor.proofLevel === "proved"),
    ).toBe(false);
  });

  it("does not generate standalone repo probes from introductory goal wording", () => {
    const probes = generateSearchProbes(normalizeFeatureSpec(historicalGoal.goal));
    const genericGoalTerms = new Set(["proven", "repository", "implementations"]);
    const taskLanguageOnlyProbes = probes.filter((probe) => probe.kind === "repo_search" &&
      probe.query.toLowerCase().split(/\s+/).filter(Boolean).every((token) => genericGoalTerms.has(token)));

    expect(taskLanguageOnlyProbes).toHaveLength(0);
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

  it("follows a workflow script reference within budget and records its source observation", async () => {
    const spec: FeatureSpec = {
      featureKey: "python-lint", goal: "Research Python lint workflow", feature: "Python lint workflow",
      goalKind: "research", stack: ["Python"], libraries: [], providers: [], mustHave: [], shouldHave: [], exclude: [],
      requiredConcepts: ["Ruff"], likelyFiles: [],
      proofRequirements: [{ key: "behavior_proof", description: "Ruff workflow", required: true, signals: ["Ruff"] }],
    };
    const { observations, readPlan, warnings } = await collectEvidence(new FileProvider({
      ".github/workflows/lint.yml": "jobs:\n  lint:\n    steps:\n      - run: ./scripts/lint.py",
      "scripts/lint.py": "ruff check .",
    }), spec, candidate([".github/workflows/lint.yml"]));

    expect(observations.map((item) => item.path)).toEqual([".github/workflows/lint.yml", "scripts/lint.py"]);
    expect(readPlan[1]).toMatchObject({
      path: "scripts/lint.py", reason: "implementation_path",
      referencedBy: { path: ".github/workflows/lint.yml", observationId: observations[0]!.id, detail: "run: ./scripts/lint.py" },
    });
    expect(warnings.some((warning) => warning.includes(`${observations[0]!.id}) references scripts/lint.py`))).toBe(true);
  });

  // Live pilot regression: `bash scripts/ci/self-hosted/diff-cover.sh` was scheduled as the
  // directory `scripts`, spending a read on an unavailable path instead of the script.
  it("follows interpreter-invoked script references by their full path", async () => {
    const spec: FeatureSpec = {
      featureKey: "diff-cover", goal: "Research diff-cover workflow", feature: "diff-cover workflow",
      goalKind: "research", stack: ["Python"], libraries: [], providers: [], mustHave: [], shouldHave: [], exclude: [],
      requiredConcepts: ["diff-cover"], likelyFiles: [],
      proofRequirements: [{ key: "behavior_proof", description: "diff-cover workflow", required: true, signals: ["diff-cover"] }],
    };
    const { observations } = await collectEvidence(new FileProvider({
      ".github/workflows/ci.yml": "jobs:\n  cov:\n    steps:\n      - run: bash scripts/ci/self-hosted/diff-cover.sh\n      - run: python3 ./tools/check.py",
      "scripts/ci/self-hosted/diff-cover.sh": "diff-cover coverage.xml --fail-under=90",
      "tools/check.py": "print('ok')",
    }), spec, candidate([".github/workflows/ci.yml"]));

    expect(observations.map((item) => item.path)).toEqual([".github/workflows/ci.yml", "scripts/ci/self-hosted/diff-cover.sh", "tools/check.py"]);
    expect(observations.every((item) => item.readStatus === "complete")).toBe(true);
  });

  it("keeps partial source slices useful only for facts within the slice", async () => {
    const spec: FeatureSpec = {
      featureKey: "ruff-absence", goal: "Research whether Ruff is configured", feature: "Ruff configuration",
      goalKind: "research", stack: [], libraries: [], providers: [], mustHave: [], shouldHave: [], exclude: [],
      requiredConcepts: ["ruff"], likelyFiles: [],
      proofRequirements: [{ key: "config", description: "Ruff config is absent", required: true, signals: ["ruff"] }],
    };
    const provider = {
      getFile: async ({ repo, path }: FileReadRequest): Promise<FileEvidence> => ({
        provider: "mock", repo, path, content: "unrelated: true", readStatus: "partial", startLine: 40, endLine: 40,
        offsetStart: 39, offsetSemantics: "line",
      }),
    } as unknown as EvidenceProvider;
    const { observations } = await collectEvidence(provider, spec, candidate(["pyproject.toml"]));
    expect(observations[0]).toMatchObject({ readStatus: "partial", startLine: 40, endLine: 40, offsetStart: 39 });
    expect(observations[0]!.excerpt).toBe("unrelated: true");
    expect(observations[0]!.excerpt).not.toContain("ruff");
  });
});

describe("signal boundaries", () => {
  it("matches case-insensitively without matching inside longer identifiers", () => {
    expect(lineHasSignal("uses FLOWDECK today", "Flowdeck")).toBe(true);
    expect(lineHasSignal("convexAuthNextjsMiddleware", "convexAuth")).toBe(false);
  });
});
