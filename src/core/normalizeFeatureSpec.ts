import type { FeatureSpec, ProofRequirement } from "../schemas/index.js";
import { FeatureSpecSchema } from "../schemas/index.js";
import {
  detectFeatureProfile,
  detectGoalKind,
  detectProviders,
  detectStacks,
  extractKeyTerms,
  GENERIC_SIGNAL_NOISE,
  partitionKeyTerms,
  slugify,
  type FeatureSpecDraft,
} from "./knowledge.js";
import { ResearchError } from "./errors.js";

/**
 * Turn a free-form goal string plus optional hints into a structured,
 * validated FeatureSpec. Deterministic: the same goal + hints always
 * produce the same spec (including featureKey).
 */
export function normalizeFeatureSpec(goal: string, hints?: Partial<FeatureSpec>): FeatureSpec {
  const trimmed = goal.trim();
  if (!trimmed) {
    throw new ResearchError("invalid_feature_spec", "Goal must be a non-empty string.", {
      recoverable: true,
      suggestedAction: "Pass a goal like 'Next.js + Convex app with email magic links via Resend'.",
    });
  }

  const stacks = detectStacks(trimmed, hints?.stack);
  const providers = detectProviders(trimmed, hints?.providers);
  const goalKind = hints?.goalKind ?? detectGoalKind(trimmed);
  // Feature profiles encode application implementation contracts. Research
  // goals may mention the same technologies, but must keep research-shaped
  // proof requirements and artifacts.
  const profile = goalKind === "application" ? detectFeatureProfile(trimmed) : undefined;

  // Mine every goal so lowercase and previously unknown named systems survive
  // normalization. Known application profiles still enrich the resulting spec.
  const keyTerms = extractKeyTerms(trimmed);
  const { products, behaviors } = partitionKeyTerms(keyTerms);

  const draft: FeatureSpecDraft = {
    goal: trimmed,
    feature: profile?.feature ?? deriveFeaturePhrase(trimmed, products, behaviors),
    stack: stacks.map((s) => s.name),
    libraries: [...(hints?.libraries ?? [])],
    providers: providers.map((p) => p.name),
    mustHave: [...(hints?.mustHave ?? [])],
    shouldHave: [...(hints?.shouldHave ?? [])],
    exclude: [...(hints?.exclude ?? [])],
    requiredConcepts: [...(hints?.requiredConcepts ?? [])],
    likelyFiles: [...(hints?.likelyFiles ?? [])],
    proofRequirements: [...(hints?.proofRequirements ?? [])],
  };

  // Preserve hint stacks/providers that our registry does not know about.
  for (const hinted of hints?.stack ?? []) {
    if (!draft.stack.some((s) => s.toLowerCase() === hinted.toLowerCase())) {
      draft.stack.push(hinted);
    }
  }
  for (const hinted of hints?.providers ?? []) {
    if (!draft.providers.some((p) => p.toLowerCase() === hinted.toLowerCase())) {
      draft.providers.push(hinted);
    }
  }

  if (goalKind === "application") profile?.enrich(draft);

  // Generic fallback proof requirements so scoring always has a contract.
  // Research/migration goals prove things about external systems (repo/docs
  // existence + documented behavior); application goals prove a dependency
  // manifest + implementation source.
  if (draft.proofRequirements.length === 0) {
    draft.proofRequirements =
      goalKind === "research"
        ? researchProofRequirements(products, behaviors)
        : applicationProofRequirements(stacks, providers, draft);
    if (draft.proofRequirements.length === 0) {
      throw new ResearchError(
        "invalid_feature_spec",
        "Research goal is too broad to derive trustworthy proof signals.",
        {
          recoverable: true,
          suggestedAction: "Name at least one system/project or concrete behavior to research.",
        },
      );
    }
  }

  if (draft.requiredConcepts.length === 0) {
    // Prefer mined key terms (named products + behaviors) over the bare feature
    // phrase so distinctive entities reach probe generation.
    const conceptPool = [...products, ...behaviors];
    draft.requiredConcepts = (conceptPool.length > 0
      ? conceptPool
      : [draft.feature, ...draft.libraries, ...draft.providers]
    ).filter(Boolean);
  }

  // `package.json` is the right likely-file for application goals. Research /
  // migration goals study external systems; forcing package.json invents a
  // dependency that does not exist for the goal.
  if (goalKind === "application" && !draft.likelyFiles.includes("package.json")) {
    draft.likelyFiles.unshift("package.json");
  }

  const featureKey =
    hints?.featureKey ??
    buildFeatureKey(stacks.map((s) => s.token), profile?.key, keyTerms, trimmed);

  const spec: FeatureSpec = FeatureSpecSchema.parse({
    featureKey,
    goal: trimmed,
    feature: hints?.feature ?? draft.feature,
    goalKind,
    stack: draft.stack,
    libraries: draft.libraries,
    providers: draft.providers,
    mustHave: draft.mustHave,
    shouldHave: draft.shouldHave,
    exclude: draft.exclude,
    requiredConcepts: draft.requiredConcepts,
    likelyFiles: draft.likelyFiles,
    proofRequirements: draft.proofRequirements,
  });
  return spec;
}

function buildFeatureKey(
  stackTokens: string[],
  profileKey: string | undefined,
  keyTerms: string[],
  goal: string,
): string {
  const featureToken = profileKey ?? fallbackFeatureToken(goal, keyTerms);
  const parts = [...stackTokens, featureToken].filter(Boolean);
  return parts.join("-");
}

function fallbackFeatureToken(goal: string, keyTerms: string[]): string {
  if (keyTerms.length > 0) {
    const { products, behaviors } = partitionKeyTerms(keyTerms);
    const parts = [...products.slice(0, 3), ...behaviors.slice(0, 1)];
    if (parts.length > 0) return slugify(parts.join(" "));
  }
  const words = slugify(goal).split("-").filter((w) => w.length > 2);
  return words.slice(0, 4).join("-") || "feature";
}

function deriveGenericFeature(goal: string): string {
  const words = goal
    .replace(/[^a-zA-Z0-9\s.+-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, 8).join(" ") || "unspecified feature";
}

/**
 * Representative feature title for a generic goal: the named products plus the
 * leading behavior concepts. Falls back to the leading-words heuristic only
 * when no distinctive terms were mined (preserving prior behavior).
 */
function deriveFeaturePhrase(
  goal: string,
  products: string[],
  behaviors: string[],
): string {
  const parts = [...products.slice(0, 4), ...behaviors.slice(0, 2)].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return deriveGenericFeature(goal);
}

function applicationProofRequirements(
  stacks: Array<{ packages: string[] }>,
  providers: Array<{ packages: string[] }>,
  draft: FeatureSpecDraft,
): ProofRequirement[] {
  const dependencySignals = [
    ...stacks.flatMap((s) => s.packages),
    ...draft.libraries,
    ...providers.flatMap((p) => p.packages),
  ];
  return [
    {
      key: "dependency_proof",
      description: "Dependency manifest proves the stack and libraries are actually used.",
      required: true,
      signals: dependencySignals.length > 0 ? dependencySignals : [draft.feature],
    },
    {
      key: "implementation_proof",
      description: "Source files prove the feature is implemented, not just documented.",
      required: true,
      signals:
        draft.requiredConcepts.length > 0 ? [...draft.requiredConcepts] : [draft.feature],
    },
  ];
}

/**
 * Research/migration goals prove things about external systems: that each named
 * product has a real source (existence) and that the central behaviors are
 * documented or implemented (behavior). Documentation is legitimate evidence
 * for these requirements (see collectEvidence).
 */
function researchProofRequirements(products: string[], behaviors: string[]): ProofRequirement[] {
  // Drop generic terms (OS names, the task verb "migration", "configuration"...)
  // so a repo must mention a distinctive product/concept to count as evidence;
  // otherwise searching code/docs for "macOS" + "migration" matches everything.
  const productSignals = products.filter((p) => !GENERIC_SIGNAL_NOISE.has(p.toLowerCase()));
  const behaviorSignals = behaviors.filter((b) => !GENERIC_SIGNAL_NOISE.has(b.toLowerCase()));
  const requirements: ProofRequirement[] = [];
  if (productSignals.length > 0) {
    requirements.push({
      key: "existence_proof",
      description: "Each named system/project has a real repository or official documentation.",
      required: true,
      signals: productSignals,
    });
  }
  if (behaviorSignals.length > 0) {
    requirements.push({
      key: "behavior_proof",
      description: "The central behavior/concept is documented or implemented in source material.",
      required: true,
      signals: behaviorSignals,
    });
  }
  return requirements;
}
