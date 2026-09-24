import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResearch } from "../src/core/pipeline.js";
import { writeArtifacts, deriveRunStatus } from "../src/core/writeArtifacts.js";
import { normalizeFeatureSpec } from "../src/core/normalizeFeatureSpec.js";
import { generateSearchProbes } from "../src/core/generateSearchProbes.js";
import type {
  EvidenceProvider,
  NormalizedSearchResult,
  RepoSearchResult,
  RepoMetadata,
  RepoRef,
  FileReadRequest,
  FileEvidence,
  RepoTree,
  RepoSearchQuery,
} from "../src/adapters/EvidenceProvider.js";
import type { SearchProbe } from "../src/schemas/index.js";

const FLOWDECK_GOAL =
  "Develop a migration guide for an existing macOS WezTerm configuration to Flowdeck: preserve keyboard-only navigation across all panes, map WezTerm workspace/layout/session behavior to Flowdeck, evaluate whether Flowdeck should run in WezTerm or iTerm2, and identify safe plugin/integration patterns for coding-agent workspaces.";

/** Auth/database/login phrases the hard-coded renderer used to emit unconditionally. */
const AUTH_BOILERPLATE = [
  "Server auth/provider config",
  "HTTP/auth routes",
  "Database/schema changes",
  "Login/sign-in form",
  "Sign-out flow",
  "Protected routes defined",
  "Middleware/proxy redirects unauthenticated",
];

describe("Flowdeck/WezTerm migration goal: normalization", () => {
  const spec = normalizeFeatureSpec(FLOWDECK_GOAL);

  it("preserves every named product in requiredConcepts", () => {
    for (const entity of ["Flowdeck", "WezTerm", "iTerm2", "macOS"]) {
      expect(spec.requiredConcepts).toContain(entity);
    }
  });

  it("preserves central behaviors in requiredConcepts", () => {
    for (const concept of ["navigation", "workspace", "layout", "session", "plugin"]) {
      expect(spec.requiredConcepts).toContain(concept);
    }
  });

  it("does not truncate the feature to the leading filler words", () => {
    // The old defect normalized this goal to "Develop a migration guide for an existing macOS".
    expect(spec.feature).not.toBe("Develop a migration guide for an existing macOS");
    expect(spec.feature).toContain("Flowdeck");
    expect(spec.feature).toContain("WezTerm");
  });

  it("is a research goal: no forced package.json likely-file", () => {
    expect(spec.likelyFiles).not.toContain("package.json");
  });

  it("uses research-shaped proof requirements (existence + behavior, not dependency)", () => {
    const keys = spec.proofRequirements.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["existence_proof", "behavior_proof"]));
    expect(keys).not.toContain("dependency_proof");
  });

  it("builds a representative featureKey that includes flowdeck (not the old truncated token)", () => {
    expect(spec.featureKey).toContain("flowdeck");
    expect(spec.featureKey).not.toBe("develop-migration-guide-for");
  });
});

describe("Flowdeck/WezTerm migration goal: probe generation", () => {
  const spec = normalizeFeatureSpec(FLOWDECK_GOAL);
  const probes = generateSearchProbes(spec);

  it("generates per-product repo_search probes (not one over-constrained phrase)", () => {
    const repoProbes = probes.filter((p) => p.kind === "repo_search");
    expect(repoProbes.length).toBeGreaterThan(1);
    const queries = repoProbes.map((p) => p.query);
    expect(queries).toContain("Flowdeck");
    expect(queries).toContain("WezTerm");
    // Each repo_search targets a single product, not a multi-word AND phrase.
    expect(queries.every((q) => q.split(/\s+/).length <= 2)).toBe(true);
  });

  it("pairs named products with behavior concepts in high-precision probes", () => {
    const hp = probes.filter((p) => p.kind === "high_precision");
    const joined = hp.map((p) => p.query).join("\n");
    expect(joined).toContain("Flowdeck");
    // High-precision probes combine a product with a behavior concept
    // (migration/configuration/navigation/...), not only product x product.
    expect(joined).toMatch(
      /migration|configuration|navigation|workspace|layout|session|plugin/,
    );
    expect(joined).toContain('"Flowdeck" "migration"');
  });

  it("has unique ids and queries", () => {
    expect(new Set(probes.map((p) => p.id)).size).toBe(probes.length);
    expect(new Set(probes.map((p) => p.query)).size).toBe(probes.length);
  });
});

/** Code search misses, but repo discovery finds the Flowdeck repo with real docs. */
class FlowdeckFixtureProvider implements EvidenceProvider {
  readonly name = "flowdeck-fixture" as const;
  private readonly readme = [
    "# Flowdeck",
    "",
    "Flowdeck is a keyboard-driven terminal workspace manager.",
    "Pane navigation, workspaces, layouts, sessions, and plugin integrations",
    "are configured via a TOML file. Keyboard-only navigation across all panes",
    "is a first-class feature. Resurrect restores sessions.",
  ].join("\n");

  async searchCode(_probes: SearchProbe[]): Promise<NormalizedSearchResult[]> {
    return [];
  }
  async searchRepos(query: RepoSearchQuery): Promise<RepoSearchResult[]> {
    if (/flowdeck/i.test(query.query)) {
      return [
        {
          repo: "ogulcancelik/flowdeck",
          url: "https://github.com/ogulcancelik/flowdeck",
          description: "Keyboard-driven terminal workspace manager.",
          stars: 200,
        },
      ];
    }
    return [];
  }
  async getRepoMetadata(repo: RepoRef): Promise<RepoMetadata> {
    return {
      repo: repo.repo,
      owner: "ogulcancelik",
      name: "flowdeck",
      defaultBranch: "main",
      url: `https://github.com/${repo.repo}`,
      stars: 200,
    };
  }
  async getFile(input: FileReadRequest): Promise<FileEvidence> {
    return { provider: this.name, repo: input.repo, path: input.path, content: this.readme };
  }
  async getRepoTree(repo: RepoRef): Promise<RepoTree> {
    return { repo: repo.repo, paths: ["README.md", "docs/configuration.md"] };
  }
}

describe("searchRepos fallback discovery (code search misses)", () => {
  it("discovers the official repo and captures proved evidence", async () => {
    const { run, evidence } = await runResearch({
      goal: FLOWDECK_GOAL,
      provider: new FlowdeckFixtureProvider(),
      deterministic: true,
    });
    expect(run.candidates.length).toBe(1);
    expect(run.candidates[0]!.repo).toBe("ogulcancelik/flowdeck");
    // Diagnostics distinguish an empty code-search result from a failure.
    expect(run.warnings.some((w) => /Code search returned no results/.test(w))).toBe(true);
    expect(run.warnings.some((w) => /Repo discovery returned 1 repo\(s\)/.test(w))).toBe(true);
    // Research proofs are satisfied by documentation -> proved evidence.
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((a) => a.proofLevel === "proved")).toBe(true);
    expect(run.selectedRepos).toContain("ogulcancelik/flowdeck");
    // Flowdeck's README proves Flowdeck behavior, but it does not prove every named
    // migration endpoint (WezTerm/iTerm2), so the overall run stays honest.
    expect(deriveRunStatus(run, evidence)).toMatchObject({
      status: "inconclusive",
      reasons: expect.arrayContaining(["missing_required_proof"]),
    });
  });
});

abstract class StubProvider implements EvidenceProvider {
  abstract readonly name: EvidenceProvider["name"];
  abstract searchCode(probes: SearchProbe[]): Promise<NormalizedSearchResult[]>;
  abstract searchRepos(query: RepoSearchQuery): Promise<RepoSearchResult[]>;
  async getRepoMetadata(repo: RepoRef): Promise<RepoMetadata> {
    const [owner = "unknown", name = repo.repo] = repo.repo.split("/");
    return { repo: repo.repo, owner, name };
  }
  async getFile(input: FileReadRequest): Promise<FileEvidence> {
    return { provider: this.name, repo: input.repo, path: input.path, unavailableReason: "none" };
  }
  async getRepoTree(repo: RepoRef): Promise<RepoTree> {
    return { repo: repo.repo, paths: [] };
  }
}

class EmptyProvider extends StubProvider {
  readonly name = "empty" as const;
  async searchCode(): Promise<NormalizedSearchResult[]> {
    return [];
  }
  async searchRepos(): Promise<RepoSearchResult[]> {
    return [];
  }
}

class FailingProvider extends StubProvider {
  readonly name = "failing" as const;
  async searchCode(): Promise<NormalizedSearchResult[]> {
    throw new Error("connection refused");
  }
  async searchRepos(): Promise<RepoSearchResult[]> {
    throw new Error("connection refused");
  }
}

describe("zero-evidence runs are inconclusive, not successful", () => {
  it("marks the run inconclusive with explicit reasons (empty result, not failure)", async () => {
    const { run, evidence } = await runResearch({
      goal: FLOWDECK_GOAL,
      provider: new EmptyProvider(),
      deterministic: true,
    });
    const status = deriveRunStatus(run, evidence);
    expect(status.status).toBe("inconclusive");
    expect(status.reasons).toEqual(
      expect.arrayContaining(["no_candidates", "no_selected_repositories", "no_evidence_anchors"]),
    );
    // A valid empty result is NOT a provider failure.
    expect(status.reasons).not.toContain("provider_search_failed");
    expect(run.warnings.some((w) => /Code search returned no results/.test(w))).toBe(true);
  });

  it("renders recovery artifacts that agree on status and emit no auth/server-flow boilerplate", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "ro-flowdeck-empty-"));
    try {
      const { run, evidence, pattern } = await runResearch({
        goal: FLOWDECK_GOAL,
        provider: new EmptyProvider(),
        deterministic: true,
      });
      await writeArtifacts(run, outDir, { evidence, pattern });

      const checklist = await readFile(join(outDir, "implementation-checklist.md"), "utf8");
      const research = await readFile(join(outDir, "research.md"), "utf8");
      const plan = await readFile(join(outDir, "plan.md"), "utf8");
      const evidenceJson = JSON.parse(await readFile(join(outDir, "evidence.json"), "utf8")) as {
        status: string;
        statusReasons: string[];
      };

      // All four artifacts agree the run is inconclusive.
      expect(evidenceJson.status).toBe("inconclusive");
      expect(evidenceJson.statusReasons.length).toBeGreaterThan(0);
      expect(research).toContain("INCONCLUSIVE");
      expect(plan).toContain("INCONCLUSIVE");
      expect(checklist).toContain("inconclusive");

      // No fabricated server/client flow for a terminal-migration goal.
      expect(research).not.toContain("Server flow");
      expect(research).not.toContain("Client flow");
      // Never claim "no open questions" when no evidence was collected.
      expect(research).not.toContain("None outstanding");
      expect(research.toLowerCase()).toContain("open questions");

      // Regression: a migration goal must never emit auth/db/login boilerplate.
      for (const phrase of AUTH_BOILERPLATE) {
        expect(checklist).not.toContain(phrase);
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

describe("provider transport failure is distinguished from an empty result", () => {
  it("records provider_search_failed and stays inconclusive", async () => {
    const { run, evidence } = await runResearch({
      goal: FLOWDECK_GOAL,
      provider: new FailingProvider(),
      deterministic: true,
    });
    expect(run.warnings.some((w) => /Provider code search failed/i.test(w))).toBe(true);
    const status = deriveRunStatus(run, evidence);
    expect(status.status).toBe("inconclusive");
    expect(status.reasons).toContain("provider_search_failed");
  });
});
