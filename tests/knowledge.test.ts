import { describe, expect, it } from "vitest";
import {
  detectGoalKind,
  extractKeyTerms,
  looksLikeProperNoun,
  partitionKeyTerms,
} from "../src/core/knowledge.js";

describe("extractKeyTerms", () => {
  it("preserves named products with internal capitals, digits, and Capitalized names", () => {
    const terms = extractKeyTerms(
      "Develop a migration guide for an existing macOS WezTerm configuration to Flowdeck or iTerm2",
    );
    for (const product of ["macOS", "WezTerm", "Flowdeck", "iTerm2"]) {
      expect(terms).toContain(product);
    }
  });

  it("preserves hyphenated compounds and behavior nouns", () => {
    const terms = extractKeyTerms(
      "preserve keyboard-only navigation across panes with workspace layout session plugin integration",
    );
    for (const concept of [
      "keyboard-only",
      "navigation",
      "panes",
      "workspace",
      "layout",
      "session",
      "plugin",
      "integration",
    ]) {
      expect(terms).toContain(concept);
    }
  });

  it("drops filler verbs and stopwords (Develop, existing, evaluate, whether...)", () => {
    const terms = extractKeyTerms(
      "Develop a migration guide for an existing configuration; evaluate whether to run",
    );
    expect(terms).not.toContain("Develop");
    expect(terms).not.toContain("existing");
    expect(terms).not.toContain("evaluate");
    expect(terms).not.toContain("whether");
  });

  it("is deterministic (same goal -> same terms in the same order)", () => {
    const goal = "Migrate WezTerm config to Flowdeck with keyboard navigation";
    expect(extractKeyTerms(goal)).toEqual(extractKeyTerms(goal));
  });

  it("returns an empty array for a stopword-only goal", () => {
    expect(extractKeyTerms("develop a guide for an existing app")).toEqual([]);
  });
});

describe("detectGoalKind", () => {
  it("classifies migration/research/evaluation goals as research", () => {
    expect(detectGoalKind("Develop a migration guide for WezTerm to Flowdeck")).toBe("research");
    expect(detectGoalKind("Evaluate whether to use Flowdeck in iTerm2 vs WezTerm")).toBe("research");
    expect(detectGoalKind("Research safe plugin patterns")).toBe("research");
  });

  it("classifies build/implement goals as application", () => {
    expect(detectGoalKind("Build a Next.js + Convex app with magic links")).toBe("application");
    expect(detectGoalKind("Implement a widget frobnicator for my dashboard")).toBe("application");
  });
});

describe("looksLikeProperNoun / partitionKeyTerms", () => {
  it("separates named products from behavior concepts", () => {
    const { products, behaviors } = partitionKeyTerms([
      "macOS",
      "WezTerm",
      "Flowdeck",
      "iTerm2",
      "navigation",
      "workspace",
      "keyboard-only",
    ]);
    expect(products).toEqual(["macOS", "WezTerm", "Flowdeck", "iTerm2"]);
    expect(behaviors).toEqual(["navigation", "workspace", "keyboard-only"]);
  });

  it("does not treat capitalized domain nouns as products", () => {
    expect(looksLikeProperNoun("Configuration")).toBe(false);
    expect(looksLikeProperNoun("Navigation")).toBe(false);
    expect(looksLikeProperNoun("Flowdeck")).toBe(true);
  });
});
