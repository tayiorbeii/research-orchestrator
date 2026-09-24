import { describe, expect, it } from "vitest";
import { normalizeFeatureSpec } from "../src/core/normalizeFeatureSpec.js";
import { ResearchError } from "../src/core/errors.js";

const MAGIC_LINK_GOAL = "Build a Next.js + Convex app with email magic links via Resend.";

describe("normalizeFeatureSpec", () => {
  it("produces the expected key concepts for the magic-link example", () => {
    const spec = normalizeFeatureSpec(MAGIC_LINK_GOAL);
    expect(spec.featureKey).toBe("next-convex-magic-link-auth");
    expect(spec.feature).toBe("email magic-link authentication");
    expect(spec.stack).toEqual(["Next.js", "Convex"]);
    expect(spec.providers).toContain("Resend");
    expect(spec.libraries).toContain("@convex-dev/auth");
    for (const concept of [
      "convexAuth",
      "Resend",
      "useAuthActions",
      "signIn",
      "ConvexAuthNextjsProvider",
      "convexAuthNextjsMiddleware",
      "auth.addHttpRoutes",
    ]) {
      expect(spec.requiredConcepts).toContain(concept);
    }
    expect(spec.proofRequirements.map((r) => r.key)).toEqual([
      "dependency_proof",
      "server_auth_proof",
      "client_flow_proof",
      "route_protection_proof",
    ]);
    expect(spec.likelyFiles).toContain("convex/auth.ts");
  });

  it("is deterministic: same goal produces the same spec", () => {
    const a = normalizeFeatureSpec(MAGIC_LINK_GOAL);
    const b = normalizeFeatureSpec(MAGIC_LINK_GOAL);
    expect(a).toEqual(b);
  });

  it("preserves stack hints not present in the goal", () => {
    const spec = normalizeFeatureSpec("email magic links for my app", {
      stack: ["Convex", "SomeInternalFramework"],
    });
    expect(spec.stack).toContain("Convex");
    expect(spec.stack).toContain("SomeInternalFramework");
    // Convex hint should activate the convex-specific enrichment.
    expect(spec.requiredConcepts).toContain("convexAuth");
  });

  it("handles a Stripe checkout goal", () => {
    const spec = normalizeFeatureSpec("Convex + Stripe checkout");
    expect(spec.featureKey).toBe("convex-checkout-payments");
    expect(spec.providers).toContain("Stripe");
    expect(spec.libraries).toContain("stripe");
    expect(spec.proofRequirements.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to a generic spec for unknown goals", () => {
    const spec = normalizeFeatureSpec("Implement a widget frobnicator for my dashboard");
    expect(spec.featureKey.length).toBeGreaterThan(0);
    expect(spec.proofRequirements.map((r) => r.key)).toContain("dependency_proof");
    expect(spec.proofRequirements.map((r) => r.key)).toContain("implementation_proof");
    expect(spec.likelyFiles).toContain("package.json");
  });

  it("rejects empty goals with a structured error", () => {
    expect(() => normalizeFeatureSpec("   ")).toThrowError(ResearchError);
    try {
      normalizeFeatureSpec("");
    } catch (error) {
      expect((error as ResearchError).code).toBe("invalid_feature_spec");
    }
  });
});
