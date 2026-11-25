import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { collectEvidence, type ProofTargets } from "../src/core/collectEvidence.js";
import { claimAssessorRegistry } from "../src/core/assessment/types.js";
import type { EvidenceProvider } from "../src/adapters/EvidenceProvider.js";
import type { CandidateRepo } from "../src/schemas/index.js";

const candidate: CandidateRepo = { repo: "acme/flows", owner: "acme", name: "flows", defaultBranch: "main", discoveredBy: ["p1"], matchedPaths: ["workflows/support.json"], candidateSignals: [] };
const targets: ProofTargets = { goal: "gmail drafts", goalKind: "research", requirements: [{ key: "q4_0_0", description: "gmail and draft", required: true, signals: ["n8n-nodes-base.gmail", "draft"] }], likelyFiles: [], ecosystem: [], requiredConcepts: [] };

/** A >8 KB export: a decoy first mention at line 5, the real co-occurrence near line 300. */
function largeExport(): string {
  const lines = Array.from({ length: 400 }, (_, index) => `    "padding_${index}": "${"x".repeat(40)}",`);
  lines[4] = '    "type": "n8n-nodes-base.gmail",';
  lines[299] = '    "type": "n8n-nodes-base.gmail",';
  lines[305] = '    "resource": "draft",';
  return lines.join("\n");
}

function provider(content: string): EvidenceProvider {
  return {
    name: "github",
    searchCapabilities: () => ({ capabilityVersion: "test", revisionPinning: false, supportedQualifiers: { codeSearch: [], repoSearch: [] }, codeSearch: true, repoSearch: true, issues: false, batch: { codeSearch: true, repoSearch: false } }),
    searchCode: async () => [], searchRepos: async () => [],
    getRepoMetadata: async ({ repo }) => ({ repo, owner: "acme", name: "flows" }),
    getFile: async ({ repo, path }) => ({ provider: "github", repo, path, readStatus: "complete", content }),
  };
}

describe("excerpt policy for large files", () => {
  it("keeps the hit cluster that states the most signals, not the window around the first mention", async () => {
    const content = largeExport();
    expect(content.length).toBeGreaterThan(8_192);
    const collected = await collectEvidence(provider(content), targets, candidate, () => new Date(0));
    const observation = collected.observations[0]!;
    expect(observation.excerpt).toContain("n8n-nodes-base.gmail");
    expect(observation.excerpt).toContain('"resource": "draft"');
    expect(observation.startLine).toBeLessThanOrEqual(300);
    expect(observation.endLine).toBeGreaterThanOrEqual(306);
    expect(observation.startLine).toBeGreaterThan(5);
    const assess = claimAssessorRegistry.exact_source_quotation!;
    const verdict = assess({ claimId: "c", questionId: "q4", subject: { repo: "acme/flows" }, assertion: "gmail draft", target: { kind: "quotation", signals: ["n8n-nodes-base.gmail", "draft"], claimScope: "implemented" } }, collected.observations);
    expect(verdict.status).toBe("supported");
    // The densest cluster leads; every retained anchor lies inside some kept window.
    expect(collected.anchors.every((anchor) => collected.observations.some((item) => anchor.startLine! >= item.startLine! && anchor.startLine! <= item.endLine!))).toBe(true);
  });

  it("keeps one anchor per signal and the whole file when it is small", async () => {
    const content = ['{ "type": "n8n-nodes-base.gmail", "resource": "draft" }', '{ "type": "n8n-nodes-base.gmail" }'].join("\n");
    const collected = await collectEvidence(provider(content), targets, candidate, () => new Date(0));
    expect(collected.observations[0]?.excerpt).toBe(content);
    expect(collected.anchors.map((anchor) => [anchor.matchedSignal, anchor.startLine])).toEqual([["n8n-nodes-base.gmail", 1], ["draft", 1]]);
  });
});

describe("questions that share one large file", () => {
  const sharedTargets: ProofTargets = {
    goal: "worksheet reads", goalKind: "research", likelyFiles: [], ecosystem: [], requiredConcepts: [],
    requirements: [
      { key: "q1_0_0", description: "expected_headers", required: true, signals: ["expected_headers"] },
      { key: "q2_0_0", description: "batch_get", required: true, signals: ["batch_get"] },
    ],
  };

  function sharedFile(): string {
    const lines = Array.from({ length: 1500 }, (_, index) => `    # padding ${index} ${"x".repeat(40)}`);
    lines[100] = "    def get_all_records(self, expected_headers=None):";
    lines[101] = "        return expected_headers";
    lines[1200] = "    def batch_get(self, ranges):";
    lines[1201] = "        return ranges";
    return lines.join("\n");
  }

  function supports(signals: string[], observations: Parameters<typeof claimAssessorRegistry.exact_source_quotation>[1]) {
    return claimAssessorRegistry.exact_source_quotation!({
      claimId: "c", questionId: "q", subject: { repo: "acme/flows" }, assertion: signals.join(" "),
      target: { kind: "quotation", signals, claimScope: "implemented" },
    }, observations).status;
  }

  it("keeps a window for every question's facts, not only the densest cluster", async () => {
    const collected = await collectEvidence(provider(sharedFile()), sharedTargets, candidate, () => new Date(0));
    expect(supports(["expected_headers"], collected.observations)).toBe("supported");
    expect(supports(["batch_get"], collected.observations)).toBe("supported");
    // Windows stay separate: unrelated regions are never joined into invented code.
    expect(supports(["expected_headers", "batch_get"], collected.observations)).not.toBe("supported");
    expect(new Set(collected.observations.map((item) => item.id)).size).toBe(collected.observations.length);
  });

  it("keeps each window an exact slice of the file, with its own hash and a retained anchor", async () => {
    const content = sharedFile();
    const lines = content.split("\n");
    const collected = await collectEvidence(provider(content), sharedTargets, candidate, () => new Date(0));
    expect(collected.observations.length).toBeGreaterThan(1);
    for (const item of collected.observations) {
      expect(item.excerpt).toBe(lines.slice(item.startLine! - 1, item.endLine).join("\n"));
      expect(item.contentHash).toBe(createHash("sha256").update(item.excerpt!).digest("hex"));
    }
    for (const anchor of collected.anchors) {
      expect(collected.observations.some((item) => anchor.startLine! >= item.startLine! && anchor.startLine! <= item.endLine!)).toBe(true);
    }
  });

  it("bounds how many windows one file may keep", async () => {
    const lines = Array.from({ length: 4000 }, (_, index) => `# padding ${index} ${"x".repeat(40)}`);
    for (let index = 0; index < 40; index += 1) lines[index * 100 + 10] = "expected_headers = 1";
    const collected = await collectEvidence(provider(lines.join("\n")), sharedTargets, candidate, () => new Date(0));
    expect(collected.observations.length).toBeLessThanOrEqual(8);
    expect(collected.observations.length).toBeGreaterThan(1);
  });
});
