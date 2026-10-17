import type { FeatureSpec, ProofRequirement } from "../../schemas/index.js";
import type { ResearchBrief } from "../../schemas/researchBrief.js";
import { factLabel } from "../assessment/briefCoverage.js";
import type { ProofTargets } from "../collectEvidence.js";
import { normalizeFeatureSpec } from "../normalizeFeatureSpec.js";

/** One read requirement per brief fact; the key is the fact's position. */
export function briefProofRequirements(brief: ResearchBrief): ProofRequirement[] {
  return brief.questions.flatMap((question) => question.obligations.flatMap((obligation, obligationIndex) => obligation.facts.map((fact, factIndex) => ({
    key: `${question.id}_${obligationIndex}_${factIndex}`,
    description: factLabel(fact),
    required: question.required,
    signals: fact.kind === "dependency" ? [fact.packageName]
      : fact.kind === "config" ? [fact.keyPath, ...(fact.value === undefined ? [] : [String(fact.value)])]
      : fact.kind === "workflow" ? [fact.command]
      : fact.signals,
  }))));
}

/** Files the brief names outright: manifests, config/workflow files, quotation paths. */
export function briefDeclaredPaths(brief: ResearchBrief): string[] {
  const paths = brief.questions.flatMap((question) => question.obligations.flatMap((obligation) => obligation.facts.flatMap((fact) => {
    if (fact.kind === "dependency") return [fact.file ?? "package.json"];
    if (fact.kind === "quotation") return fact.path ? [fact.path] : [];
    return fact.file ? [fact.file] : [];
  })));
  return [...new Set(paths)];
}

/**
 * What evidence collection looks for in a brief run. Derived from the facts
 * alone: the goal sentence contributes nothing to which files are read.
 */
export function proofTargetsFromBrief(brief: ResearchBrief): ProofTargets {
  return {
    goal: brief.goal,
    goalKind: "research",
    requirements: briefProofRequirements(brief),
    likelyFiles: briefDeclaredPaths(brief),
    ecosystem: [...new Set([...(brief.ecosystems ?? []), ...(brief.languages ?? [])].map((name) => name.toLowerCase()))],
    requiredConcepts: [],
  };
}

/**
 * The run envelope still carries a FeatureSpec for v1 consumers (artifact
 * renderers, cache naming). For a brief it is a projection of the facts; the
 * feature key keeps the legacy goal slug so run ids and cache files stay stable.
 */
export function briefFeatureSpec(brief: ResearchBrief): FeatureSpec {
  const proofRequirements = briefProofRequirements(brief);
  return {
    featureKey: legacyFeatureKey(brief) ?? brief.id.replace(/[^a-zA-Z0-9_-]/g, "-"),
    goal: brief.goal,
    feature: brief.goal,
    goalKind: "research",
    stack: [...(brief.ecosystems ?? [])],
    libraries: [], providers: [], mustHave: [], shouldHave: [], exclude: [],
    requiredConcepts: [...new Set(proofRequirements.flatMap((item) => item.signals))],
    likelyFiles: briefDeclaredPaths(brief),
    proofRequirements,
  };
}

export function legacyFeatureKey(brief: ResearchBrief): string | undefined {
  try {
    return normalizeFeatureSpec(brief.goal).featureKey;
  } catch {
    return undefined;
  }
}
