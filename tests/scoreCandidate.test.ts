import { describe, expect, it } from "vitest";
import { normalizeFeatureSpec } from "../src/core/normalizeFeatureSpec.js";
import { scoreCandidate } from "../src/core/scoreCandidate.js";
import type { CandidateRepo, EvidenceAnchor } from "../src/schemas/index.js";

const spec = normalizeFeatureSpec("Build a Next.js + Convex app with email magic links via Resend.");

function candidate(overrides: Partial<CandidateRepo>): CandidateRepo {
  return {
    repo: "acme/app",
    owner: "acme",
    name: "app",
    defaultBranch: "main",
    url: "https://github.com/acme/app",
    archived: false,
    discoveredBy: ["hp_1"],
    matchedPaths: [],
    candidateSignals: [],
    ...overrides,
  };
}

function anchor(overrides: Partial<EvidenceAnchor> & { path: string; role: string }): EvidenceAnchor {
  return {
    id: `ev_${Math.random().toString(36).slice(2, 8)}`,
    provider: "mock",
    repo: "acme/app",
    proofLevel: "proved",
    ...overrides,
  };
}

const fullEvidence: EvidenceAnchor[] = [
  anchor({ path: "package.json", role: "dependency_proof" }),
  anchor({ path: "convex/auth.ts", role: "server_auth_proof" }),
  anchor({ path: "app/login/page.tsx", role: "client_flow_proof" }),
  anchor({ path: "middleware.ts", role: "route_protection_proof" }),
];

describe("scoreCandidate", () => {
  it("classifies a fully-proved, production-shaped repo as production", () => {
    const c = candidate({
      matchedPaths: ["package.json", "convex/auth.ts", "app/login/page.tsx", "middleware.ts"],
    });
    const scored = scoreCandidate(spec, c, fullEvidence);
    expect(scored.class).toBe("production");
    expect(scored.score).toBeGreaterThanOrEqual(0.85);
    expect(scored.nextAction).toBe("extract");
    expect(scored.missingProof).toEqual([]);
  });

  it("classifies a small proved example as reference", () => {
    const c = candidate({ matchedPaths: ["package.json", "convex/auth.ts"] });
    const evidence = [
      anchor({ path: "package.json", role: "dependency_proof" }),
      anchor({ path: "convex/auth.ts", role: "server_auth_proof" }),
    ];
    const scored = scoreCandidate(spec, c, evidence);
    expect(scored.class).toBe("reference");
    expect(scored.missingProof.length).toBeGreaterThan(0);
    expect(scored.nextAction).not.toBe("extract");
  });

  it("classifies a docs-only repo as docs and never production", () => {
    const c = candidate({ name: "magic-link-guide", matchedPaths: ["README.md"] });
    const evidence = [
      anchor({ path: "README.md", role: "docs_reference", proofLevel: "partial" }),
    ];
    const scored = scoreCandidate(spec, c, evidence);
    expect(scored.class).toBe("docs");
    expect(scored.score).toBeLessThan(0.5);
    expect(scored.rejectionReasons).toContain("docs_only");
  });

  it("classifies template/starter repos as template", () => {
    const c = candidate({
      name: "convex-auth-starter-template",
      matchedPaths: ["package.json", "convex/auth.ts", "app/login/page.tsx", "middleware.ts"],
    });
    const scored = scoreCandidate(spec, c, fullEvidence);
    expect(scored.class).toBe("template");
  });

  it("classifies minimal demos as toy", () => {
    const c = candidate({
      name: "magic-link-demo",
      matchedPaths: ["convex/auth.ts"],
      candidateSignals: [
        { key: "toy", label: "Minimal demo", source: "mock", confidence: 0.9 },
      ],
    });
    const evidence = [anchor({ path: "convex/auth.ts", role: "server_auth_proof" })];
    const scored = scoreCandidate(spec, c, evidence);
    expect(scored.class).toBe("toy");
    expect(scored.rejectionReasons).toContain("toy_demo");
  });

  it("classifies repos with no matching evidence as false_positive", () => {
    const c = candidate({ name: "unrelated-thing", matchedPaths: ["src/utils.ts"] });
    const scored = scoreCandidate(spec, c, []);
    expect(scored.class).toBe("false_positive");
    expect(scored.nextAction).toBe("reject");
    expect(scored.score).toBeLessThanOrEqual(0.2);
  });

  it("caps the score when no exact evidence exists", () => {
    const c = candidate({
      matchedPaths: ["package.json", "convex/auth.ts", "app/login/page.tsx", "middleware.ts"],
      stars: 5000,
      candidateSignals: [
        { key: "dependency_proof", label: "looks right", source: "search", confidence: 0.9 },
      ],
    });
    const scored = scoreCandidate(spec, c, []);
    expect(scored.score).toBeLessThanOrEqual(0.4);
    expect(scored.negativeSignals.map((s) => s.key)).toContain("no_exact_evidence");
  });

  it("penalizes archived repos", () => {
    const c = candidate({
      archived: true,
      matchedPaths: ["package.json", "convex/auth.ts", "app/login/page.tsx", "middleware.ts"],
    });
    const scored = scoreCandidate(spec, c, fullEvidence);
    expect(scored.rejectionReasons).toContain("archived");
    expect(scored.score).toBeLessThan(0.85);
  });
});
