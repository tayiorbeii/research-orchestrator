import { describe, expect, it } from "vitest";
import { normalizeFeatureSpec } from "../src/core/normalizeFeatureSpec.js";
import { generateSearchProbes } from "../src/core/generateSearchProbes.js";

const MAGIC_LINK_GOAL = "Build a Next.js + Convex app with email magic links via Resend.";

describe("generateSearchProbes", () => {
  const spec = normalizeFeatureSpec(MAGIC_LINK_GOAL);
  const probes = generateSearchProbes(spec);

  it("generates high-precision, recall, and path-targeted probes", () => {
    const kinds = new Set(probes.map((p) => p.kind));
    expect(kinds).toContain("high_precision");
    expect(kinds).toContain("recall");
    expect(kinds).toContain("path_targeted");
  });

  it("is deterministic", () => {
    const again = generateSearchProbes(normalizeFeatureSpec(MAGIC_LINK_GOAL));
    expect(again).toEqual(probes);
  });

  it("includes Convex/Resend/auth probes for the magic-link example", () => {
    const allQueries = probes.map((p) => p.query).join("\n");
    expect(allQueries).toContain("convexAuth");
    expect(allQueries).toContain("Resend");
    expect(allQueries).toContain("convexAuthNextjsMiddleware");
    expect(allQueries).toContain("useAuthActions");
  });

  it("targets conventional paths", () => {
    const pathProbes = probes.filter((p) => p.kind === "path_targeted");
    expect(pathProbes.length).toBeGreaterThan(0);
    expect(pathProbes.some((p) => p.query.includes("path:convex/auth.ts"))).toBe(true);
  });

  it("has unique ids and queries", () => {
    expect(new Set(probes.map((p) => p.id)).size).toBe(probes.length);
    expect(new Set(probes.map((p) => p.query)).size).toBe(probes.length);
  });

  it("generates probes for generic goals too", () => {
    const generic = generateSearchProbes(
      normalizeFeatureSpec("Implement a widget frobnicator for my dashboard"),
    );
    expect(generic.length).toBeGreaterThan(0);
  });
});
