import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CandidateRepoSchema,
  EvidenceAnchorSchema,
  FeatureSpecSchema,
  SearchProbeSchema,
} from "../src/schemas/index.js";

describe("schemas match the kit's JSON schema contracts", () => {
  it("accepts the example feature spec fixture", async () => {
    const raw = JSON.parse(
      await readFile(new URL("../examples/next_convex_magic_link.feature.json", import.meta.url), "utf8"),
    );
    expect(() => FeatureSpecSchema.parse(raw)).not.toThrow();
  });

  it("accepts the example probes fixture", async () => {
    const raw = JSON.parse(
      await readFile(new URL("../examples/next_convex_magic_link.probes.json", import.meta.url), "utf8"),
    ) as unknown[];
    for (const probe of raw) expect(() => SearchProbeSchema.parse(probe)).not.toThrow();
  });

  it("accepts the sample research run candidates", async () => {
    const raw = JSON.parse(
      await readFile(new URL("../examples/sample_research_run.json", import.meta.url), "utf8"),
    ) as { candidates: unknown[] };
    for (const candidate of raw.candidates) {
      expect(() => CandidateRepoSchema.parse(candidate)).not.toThrow();
    }
  });

  it("rejects invalid feature specs", () => {
    expect(() => FeatureSpecSchema.parse({ goal: "x" })).toThrow();
    expect(() =>
      FeatureSpecSchema.parse({
        featureKey: "",
        goal: "x",
        feature: "y",
        stack: [],
        requiredConcepts: [],
        proofRequirements: [],
      }),
    ).toThrow();
  });

  it("rejects invalid evidence anchors", () => {
    expect(() =>
      EvidenceAnchorSchema.parse({
        id: "e1",
        provider: "not-a-provider",
        path: "a.ts",
        role: "x",
        proofLevel: "proved",
      }),
    ).toThrow();
    expect(() =>
      EvidenceAnchorSchema.parse({
        id: "e1",
        provider: "mock",
        path: "a.ts",
        role: "x",
        proofLevel: "proved",
        startLine: 0,
      }),
    ).toThrow();
  });
});
