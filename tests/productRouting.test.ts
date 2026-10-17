import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnchors, runPipeline } from "../src/core/pipeline.js";
import { writeArtifacts, deriveRunStatus } from "../src/core/writeArtifacts.js";
import { normalizeFeatureSpec } from "../src/core/normalizeFeatureSpec.js";
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
  ProviderSearchCapabilities,
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

abstract class StubProvider implements EvidenceProvider {
  abstract readonly name: EvidenceProvider["name"];
  abstract searchCode(probes: SearchProbe[]): Promise<NormalizedSearchResult[]>;
  abstract searchRepos(query: RepoSearchQuery): Promise<RepoSearchResult[]>;
  searchCapabilities(): ProviderSearchCapabilities {
    return { capabilityVersion: "stub", revisionPinning: false, supportedQualifiers: { codeSearch: [], repoSearch: [] }, codeSearch: true, repoSearch: true, issues: false, batch: { codeSearch: true, repoSearch: false } };
  }
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
    const run = await runPipeline({ goal: FLOWDECK_GOAL, provider: new EmptyProvider(), deterministic: true });
    const status = deriveRunStatus(run, runAnchors(run));
    expect(status.status).toBe("inconclusive");
    expect(status.reasons).toContain("Required questions remain unsatisfied.");
    // A valid empty result is NOT a provider failure.
    expect(status.reasons).not.toContain("provider_transport_failed");
    expect(run.probeOutcomes?.every((outcome) => outcome.status === "succeeded" && outcome.resultClass === "empty")).toBe(true);
    expect(run.candidates).toHaveLength(0);
  });

  it("renders recovery artifacts that agree on status and emit no auth/server-flow boilerplate", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "ro-flowdeck-empty-"));
    try {
      const run = await runPipeline({ goal: FLOWDECK_GOAL, provider: new EmptyProvider(), deterministic: true });
      await writeArtifacts(run, outDir, { evidence: runAnchors(run) });

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
      // The gaps are named, never papered over.
      expect(research).toContain("Unsatisfied facts");
      expect(plan).toContain("## Gaps");
      expect(plan).toContain("Still unproven");

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
  it("records provider_transport_failed and stays inconclusive", async () => {
    const run = await runPipeline({ goal: FLOWDECK_GOAL, provider: new FailingProvider(), deterministic: true });
    expect(run.warnings.some((w) => /connection refused/i.test(w))).toBe(true);
    const status = deriveRunStatus(run, runAnchors(run));
    expect(status.status).toBe("inconclusive");
    expect(status.reasons).toContain("provider_transport_failed");
    expect(run.probeOutcomes?.every((outcome) => outcome.status === "failed" && outcome.failureKind === "transport_failure")).toBe(true);
  });
});
