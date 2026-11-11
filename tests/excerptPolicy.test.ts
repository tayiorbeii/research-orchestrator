import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MockEvidenceProvider } from "../src/adapters/MockEvidenceProvider.js";
import { collectEvidence } from "../src/core/collectEvidence.js";
import { claimAssessorRegistry } from "../src/core/assessment/types.js";
import type { FeatureSpec } from "../src/schemas/featureSpec.js";

const path = "src/lifecycle.ts";
const candidate = {
  repo: "org/lifecycle", owner: "org", name: "lifecycle", defaultBranch: "main",
  discoveredBy: [], matchedPaths: [path], candidateSignals: [],
};

async function collect(lines: string[], signals: string[]) {
  const provider = new MockEvidenceProvider();
  provider.getFile = async (input) => ({ provider: "mock", repo: input.repo, path: input.path, content: lines.join("\n") });
  const spec: FeatureSpec = {
    featureKey: "lifecycle", goal: "Research lifecycle behavior", feature: "lifecycle", goalKind: "research",
    stack: [], libraries: [], providers: [], mustHave: [], shouldHave: [], exclude: [],
    requiredConcepts: [], likelyFiles: [path],
    proofRequirements: signals.map((signal, index) => ({ key: `fact-${index}`, description: signal, required: true, signals: [signal] })),
  };
  return collectEvidence(provider, spec, candidate);
}

function supports(signals: string[], observations: Awaited<ReturnType<typeof collect>>["observations"]) {
  return claimAssessorRegistry.exact_source_quotation!({
    claimId: "lifecycle", questionId: "lifecycle", subject: { repo: candidate.repo }, assertion: signals.join(" and "),
    target: { kind: "quotation", path, signals, claimScope: "implemented" },
  }, observations).status;
}

describe("large-source evidence windows", () => {
  it("preserves independent facts far apart in one file with exact ranges and hashes", async () => {
    const lines = Array.from({ length: 1800 }, (_, index) => `// filler ${index} ${"x".repeat(30)}`);
    lines[40] = "scheduleAfter();";
    lines[1200] = "spawnInvokedChild();";
    lines[1500] = "stopInvokedChild();";
    const result = await collect(lines, ["scheduleAfter", "spawnInvokedChild", "stopInvokedChild"]);
    for (const signal of ["scheduleAfter", "spawnInvokedChild", "stopInvokedChild"]) {
      expect(supports([signal], result.observations)).toBe("supported");
    }
    expect(new Set(result.observations.map((item) => item.id)).size).toBe(result.observations.length);
    for (const item of result.observations) {
      expect(item.excerpt).toBe(lines.slice(item.startLine! - 1, item.endLine).join("\n"));
      expect(item.contentHash).toBe(createHash("sha256").update(item.excerpt!).digest("hex"));
      expect(item.resolvedRevision).toMatch(/^[a-f0-9]{40}$/);
    }
    // Distinct windows must never be concatenated into invented nearby code.
    expect(supports(["scheduleAfter", "stopInvokedChild"], result.observations)).not.toBe("supported");
  });

  it("keeps a later usage cluster when the first occurrence is an isolated declaration", async () => {
    const lines = Array.from({ length: 1200 }, () => `// ${"x".repeat(35)}`);
    lines[5] = "declare function fromPromise(): void;";
    lines[900] = "fromPromise(({ signal }) => fetch(url, { signal }));";
    const result = await collect(lines, ["fromPromise", "signal"]);
    expect(supports(["fromPromise", "signal"], result.observations)).toBe("supported");
  });
});
