import type {
  EvidenceAnchor,
  FeatureSpec,
  ImplementationMap,
  ScoredCandidate,
} from "../schemas/index.js";

export interface ExtractedPattern {
  implementationMap: ImplementationMap;
  implementationSteps: string[];
  risks: string[];
  openQuestions: string[];
}

/**
 * Synthesize a cross-repo implementation pattern from the feature spec,
 * accepted candidates, and their exact evidence anchors.
 */
export function extractPattern(
  spec: FeatureSpec,
  scored: ScoredCandidate[],
  evidence: EvidenceAnchor[],
): ExtractedPattern {
  void spec;
  void evidence;

  // Phase 1 quotations cannot establish an implementation file or pattern.
  const files: ImplementationMap["files"] = [];

  const dependencies: string[] = [];

  const implementationMap: ImplementationMap = {
    dependencies,
    files,
    serverFlow: [],
    clientFlow: [],
    environmentVariables: [],
    routeProtection: undefined,
    tests: undefined,
    pitfalls: [],
  };

  const implementationSteps: string[] = [];

  const risks = ["Exact source quotations do not establish application behavior or implementation guidance."];

  const openQuestions = [
    ...new Set(
      scored.flatMap((s) => s.missingProof.map((m) => `${s.repo}: ${m}`)),
    ),
  ];

  return { implementationMap, implementationSteps, risks, openQuestions };
}
