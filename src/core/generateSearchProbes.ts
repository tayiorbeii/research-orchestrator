import type { FeatureSpec, SearchProbe } from "../schemas/index.js";
import { partitionKeyTerms, slugify } from "./knowledge.js";

/**
 * Generate deterministic search probes across three-plus categories:
 * high_precision, recall, path_targeted, and repo_search.
 */
export function generateSearchProbes(spec: FeatureSpec): SearchProbe[] {
  const probes: SearchProbe[] = [];
  const seenQueries = new Set<string>();

  const push = (probe: SearchProbe): void => {
    if (seenQueries.has(probe.query)) return;
    seenQueries.add(probe.query);
    probes.push(probe);
  };

  // Research routing is an explicit intent decision, not a side effect of
  // whether a stack/provider was recognized. A migration involving Stripe or
  // Convex still needs independent product and repository probes.
  const isResearch = spec.goalKind === "research";

  // --- High precision: exact implementation anchors from proof requirements.
  for (const req of spec.proofRequirements) {
    if (req.key === "dependency_proof") continue;
    if (req.signals.length >= 2) {
      const [a, b] = req.signals;
      push({
        id: `hp_${slugify(req.key)}`,
        kind: "high_precision",
        query: `${quote(a!)} ${quote(b!)}`,
        rationale: `Find exact anchors for: ${req.description}`,
        expectedSignals: req.signals.slice(0, 3),
      });
    }
  }
  // Pair leading concepts for one extra precision probe.
  if (spec.requiredConcepts.length >= 2) {
    const [a, b] = spec.requiredConcepts;
    push({
      id: `hp_${slugify(a!)}_${slugify(b!)}`,
      kind: "high_precision",
      query: `${quote(a!)} ${quote(b!)}`,
      rationale: "Find files combining the two most distinctive feature concepts.",
      expectedSignals: [a!, b!],
    });
  }

  // Research goals: pair each leading named product with each leading behavior
  // concept, and add a feature×product recall probe.
  if (isResearch) {
    const { products, behaviors } = partitionKeyTerms(spec.requiredConcepts);
    for (const product of products.slice(0, 3)) {
      for (const behavior of behaviors.slice(0, 2)) {
        push({
          id: `hp_${slugify(product)}_${slugify(behavior)}`,
          kind: "high_precision",
          query: `${quote(product)} ${quote(behavior)}`,
          rationale: `Find ${product} material that mentions ${behavior}.`,
          expectedSignals: [product, behavior],
        });
      }
    }
    if (products.length > 0) {
      const primary = products[0]!;
      push({
        id: `recall_${slugify(spec.feature)}_${slugify(primary)}`,
        kind: "recall",
        query: `${quote(spec.feature)} ${quote(primary)}`,
        rationale: `Broad recall probe combining the feature phrase with ${primary}.`,
        expectedSignals: ["feature mention", primary],
      });
    }
  }

  // --- Recall: library x provider combinations.
  const recallRight = spec.providers.length > 0 ? spec.providers : spec.stack;
  for (const lib of spec.libraries.slice(0, 3)) {
    for (const partner of recallRight.slice(0, 2)) {
      push({
        id: `recall_${slugify(lib)}_${slugify(partner)}`,
        kind: "recall",
        query: `${quote(lib)} ${quote(partner)}`,
        rationale: `Find repos combining ${lib} with ${partner}, even with unusual formatting.`,
        expectedSignals: ["dependency proof", "provider proof"],
      });
    }
  }
  if (spec.libraries.length === 0 && spec.stack.length > 0) {
    push({
      id: `recall_${slugify(spec.feature)}_${slugify(spec.stack[0]!)}`,
      kind: "recall",
      query: `${quote(spec.feature)} ${quote(spec.stack[0]!)}`,
      rationale: "Broad recall probe from feature phrase plus primary stack.",
      expectedSignals: ["feature mention"],
    });
  }

  // --- Path targeted: conventional file locations.
  const concreteFiles = spec.likelyFiles.filter(
    (f) => !f.includes("*") && f !== "package.json" && !/readme/i.test(f),
  );
  for (const file of concreteFiles.slice(0, 4)) {
    const anchor = pickAnchorForPath(spec, file);
    if (!anchor) continue;
    push({
      id: `path_${slugify(file)}`,
      kind: "path_targeted",
      query: `${quote(anchor)} path:${file}`,
      rationale: `Find conventional implementations inside ${file}.`,
      expectedSignals: [file, anchor],
    });
  }

  // --- Repo search: name/topic/readme discovery (ghSearchRepos territory).
  if (isResearch) {
    // One repo-discovery probe per named product so each official project can
    // be found independently, instead of one over-constrained AND-phrase.
    const { products } = partitionKeyTerms(spec.requiredConcepts);
    const targets = products.slice(0, 3);
    for (const product of targets) {
      push({
        id: `repo_${slugify(product)}`,
        kind: "repo_search",
        query: product,
        rationale: `Discover the official ${product} repository/project by name/topic/readme.`,
        expectedSignals: [product, "repo metadata"],
      });
    }
    if (targets.length === 0) {
      const fallback = spec.feature.trim();
      if (fallback) {
        push({
          id: `repo_${slugify(spec.featureKey)}`,
          kind: "repo_search",
          query: fallback,
          rationale: "Discover repos by name/topic/readme when code search misses.",
          expectedSignals: ["repo metadata"],
        });
      }
    }
  } else {
    const repoQuery = [...spec.stack, spec.feature].join(" ").trim();
    if (repoQuery) {
      push({
        id: `repo_${slugify(spec.featureKey)}`,
        kind: "repo_search",
        query: repoQuery,
        rationale: "Discover repos by name/topic/readme when code search misses.",
        expectedSignals: ["repo metadata"],
      });
    }
  }

  return probes;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Choose the most path-relevant concept for a path-targeted probe. */
function pickAnchorForPath(spec: FeatureSpec, file: string): string | undefined {
  const concepts = spec.requiredConcepts;
  if (/middleware|proxy/i.test(file)) {
    const middleware = concepts.find((c) => /middleware/i.test(c));
    if (middleware) return middleware;
  }
  if (/auth/i.test(file)) {
    const provider = spec.providers[0];
    if (provider) {
      // Prefer a constructor-call shaped anchor, e.g. "Resend(".
      const providerConcept = concepts.find((c) => c.toLowerCase() === provider.toLowerCase());
      if (providerConcept) return `${providerConcept}(`;
    }
    const auth = concepts.find((c) => /auth/i.test(c));
    if (auth) return auth;
  }
  if (/login|signin|sign-in/i.test(file)) {
    const signin = concepts.find((c) => /sign\s?in/i.test(c));
    if (signin) return signin;
  }
  return concepts[0];
}
