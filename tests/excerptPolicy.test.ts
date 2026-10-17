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
    expect(collected.anchors.every((anchor) => anchor.startLine! >= observation.startLine! && anchor.startLine! <= observation.endLine!)).toBe(true);
  });

  it("keeps one anchor per signal and the whole file when it is small", async () => {
    const content = ['{ "type": "n8n-nodes-base.gmail", "resource": "draft" }', '{ "type": "n8n-nodes-base.gmail" }'].join("\n");
    const collected = await collectEvidence(provider(content), targets, candidate, () => new Date(0));
    expect(collected.observations[0]?.excerpt).toBe(content);
    expect(collected.anchors.map((anchor) => [anchor.matchedSignal, anchor.startLine])).toEqual([["n8n-nodes-base.gmail", 1], ["draft", 1]]);
  });
});
