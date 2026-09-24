import type {
  CandidateClass,
  CandidateRepo,
  EvidenceAnchor,
  FeatureSpec,
  NextAction,
  RejectionReason,
  ScoredCandidate,
  Signal,
} from "../schemas/index.js";

/**
 * Score a candidate repo against a feature spec using the rubric in
 * docs/06_repo_scoring_rubric.md. High scores require exact ("proved")
 * evidence anchors — search snippets and metadata alone cannot exceed 0.4.
 */

const DOCS_PATH_PATTERN = /(^|\/)readme(\.|$)|\.mdx?$|(^|\/)docs\//i;
const CONVENTION_PATH_PATTERN =
  /middleware|proxy|(^|\/)convex\/auth|auth\.config|(login|signin|sign-in)\/page|\/api\/auth/i;
const TEMPLATE_NAME_PATTERN = /template|starter|boilerplate/i;
const TOY_NAME_PATTERN = /(^|[-_])(demo|toy|playground|hello-world|scratch)([-_]|$)/i;

export interface ScoreOptions {
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

/** Return required proof requirements that are not satisfied by proved anchors. */
export function getMissingRequiredProof(
  spec: FeatureSpec,
  evidence: EvidenceAnchor[],
): string[] {
  const proved = evidence.filter((anchor) => anchor.proofLevel === "proved");
  const missing: string[] = [];
  for (const req of spec.proofRequirements) {
    if (!req.required) continue;
    const roleAnchors = proved.filter((anchor) => anchor.role === req.key);
    if (roleAnchors.length === 0) {
      missing.push(`${req.key}: ${req.description}`);
      continue;
    }
    // Existence proof promises that every named system is represented, not
    // merely that one of the names appeared somewhere.
    if (req.key === "existence_proof") {
      for (const signal of req.signals) {
        if (!roleAnchors.some((anchor) => anchorMatchesSignal(anchor, signal))) {
          missing.push(`${req.key}:${signal}: ${req.description}`);
        }
      }
    }
  }
  return missing;
}

function anchorMatchesSignal(anchor: EvidenceAnchor, signal: string): boolean {
  const expected = signal.trim().toLowerCase();
  if (!expected) return false;
  if (anchor.matchedSignal !== undefined) {
    return anchor.matchedSignal.trim().toLowerCase() === expected;
  }
  // Backward compatibility for persisted anchors created before matchedSignal
  // was recorded explicitly.
  return anchor.matchText?.toLowerCase().includes(expected) ?? false;
}

export function scoreCandidate(
  spec: FeatureSpec,
  candidate: CandidateRepo,
  evidence: EvidenceAnchor[],
  options: ScoreOptions = {},
): ScoredCandidate {
  const anchors = evidence.filter((a) => !a.repo || a.repo === candidate.repo);
  const proved = anchors.filter((a) => a.proofLevel === "proved");
  const partial = anchors.filter((a) => a.proofLevel === "partial");
  const provedRoles = new Set(proved.map((a) => a.role));
  const isResearchSpec = spec.goalKind === "research";
  const implAnchors = isResearchSpec
    ? []
    : proved.filter((a) => a.role !== "dependency_proof");
  const implPaths = new Set(implAnchors.map((a) => a.path));

  const positiveSignals: Signal[] = [];
  const negativeSignals: Signal[] = [];
  const missingProof: string[] = [];
  const rejectionReasons: RejectionReason[] = [];
  let total = 0;

  const positive = (key: string, label: string, weight: number, anchorList?: EvidenceAnchor[]) => {
    positiveSignals.push({
      key,
      label,
      weight,
      source: anchorList && anchorList.length > 0 ? "file" : "metadata",
      confidence: anchorList && anchorList.length > 0 ? 0.95 : 0.7,
      ...(anchorList && anchorList.length > 0 ? { evidence: anchorList } : {}),
    });
    total += weight;
  };
  const negative = (key: string, label: string, weight: number) => {
    negativeSignals.push({ key, label, weight, source: "metadata", confidence: 0.8 });
    total += weight; // weight is negative
  };
  const hasCandidateSignal = (key: string, minConfidence = 0.7): boolean =>
    candidate.candidateSignals.some((s) => s.key === key && s.confidence >= minConfidence);

  // --- Dependency proof (+20)
  const depAnchors = proved.filter((a) => a.role === "dependency_proof");
  const hasDependencyProof = depAnchors.length > 0;
  if (hasDependencyProof) {
    positive("dependency_proof", "Dependency manifest proves required packages.", 20, depAnchors);
  }

  // --- Research proof (+30 per required research role)
  if (isResearchSpec) {
    for (const role of ["existence_proof", "behavior_proof"]) {
      const roleAnchors = proved.filter((anchor) => anchor.role === role);
      if (roleAnchors.length > 0) {
        positive(role, `${role.replace(/_/g, " ")} captured from authoritative source material.`, 30, roleAnchors);
      }
    }
  }

  // --- Implementation proof (+25 multi-file / +10 single file)
  if (implPaths.size >= 2) {
    positive(
      "multi_file_implementation",
      `Implementation proved across ${implPaths.size} files.`,
      25,
      implAnchors,
    );
  } else if (implPaths.size === 1) {
    positive("single_file_implementation", "Implementation proved in one file only.", 10, implAnchors);
  }

  // --- Framework convention proof (+15)
  const conventionAnchors = implAnchors.filter((a) => CONVENTION_PATH_PATTERN.test(a.path));
  if (conventionAnchors.length > 0) {
    positive(
      "framework_convention_proof",
      "Evidence sits in conventional framework files.",
      15,
      conventionAnchors,
    );
  }

  // --- Runtime flow proof (+15): server + client sides both proved.
  const serverProved = [...provedRoles].some((r) => /server|http|route_protection/.test(r));
  const clientProved = [...provedRoles].some((r) => /client/.test(r));
  const distinctImplRoles = new Set(implAnchors.map((a) => a.role));
  if ((serverProved && clientProved) || distinctImplRoles.size >= 3) {
    positive("runtime_flow_proof", "Server and client sides of the flow are both proved.", 15);
  }

  // --- Env/deployment docs (+10)
  const docsAnchors = partial.filter((a) => a.role === "docs_reference");
  const envAnchors = proved.filter((a) => /env/.test(a.role));
  if (docsAnchors.length > 0 || envAnchors.length > 0) {
    positive("env_deployment_docs", "Environment/deployment documentation present.", 10, [
      ...docsAnchors,
      ...envAnchors,
    ]);
  }

  // --- Tests (+5)
  const testPaths = candidate.matchedPaths.filter((p) => /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\./i.test(p));
  if (testPaths.length > 0 || hasCandidateSignal("tests")) {
    positive("tests_present", "Tests or test hooks discovered.", 5);
  }

  // --- Production-shaped (+10)
  const isTemplateName = TEMPLATE_NAME_PATTERN.test(candidate.name);
  const productionShaped =
    !isTemplateName &&
    (candidate.matchedPaths.length >= 4 ||
      (candidate.stars ?? 0) >= 50 ||
      hasCandidateSignal("production_shaped"));
  if (productionShaped) {
    positive("production_shaped", "Repo is shaped like a real application.", 10);
  }

  // --- Recent maintenance (+5)
  const pushedAt = candidate.pushedAt ? Date.parse(candidate.pushedAt) : NaN;
  if (!Number.isNaN(pushedAt)) {
    const now = (options.now ?? new Date()).getTime();
    if (now - pushedAt < 365 * 24 * 60 * 60 * 1000) {
      positive("recent_maintenance", "Repo pushed within the last year.", 5);
    }
  }

  // --- Negative signals
  // For research/migration goals documentation IS the evidence, so a docs-only
  // match is expected rather than a red flag.
  const docsOnly =
    !isResearchSpec &&
    candidate.matchedPaths.length > 0 &&
    candidate.matchedPaths.every((p) => DOCS_PATH_PATTERN.test(p));
  if (!isResearchSpec && (docsOnly || hasCandidateSignal("docs_only"))) {
    negative("docs_only", "Only documentation files matched — no implementation surface.", -25);
    rejectionReasons.push("docs_only");
  }

  const toyish =
    hasCandidateSignal("toy") ||
    TOY_NAME_PATTERN.test(candidate.name) ||
    (implPaths.size >= 1 && candidate.matchedPaths.length <= 1 && !hasDependencyProof);
  if (toyish) {
    negative("toy_demo", "Repo looks like a minimal demo.", -20);
    rejectionReasons.push("toy_demo");
  }

  if (candidate.archived) {
    negative("archived", "Repository is archived.", -20);
    rejectionReasons.push("archived");
  }

  if (proved.length === 0) {
    negative("no_exact_evidence", "No exact file evidence was read for this repo.", -30);
  }

  if (hasCandidateSignal("stale_dependency")) {
    negative("stale_dependency", "Depends on a stale/deprecated package or pattern.", -15);
    rejectionReasons.push("stale_dependency");
  }
  if (hasCandidateSignal("generated_slop")) {
    negative("generated_slop", "Repo shows generated/AI-slop indicators.", -10);
  }

  // --- Missing proof from required requirements.
  missingProof.push(...getMissingRequiredProof(spec, anchors));
  // Only flag a missing dependency proof when the spec actually requires one
  // (research/migration goals have no dependency manifest to prove).
  const requiresDependencyProof = spec.proofRequirements.some(
    (r) => r.key === "dependency_proof" && r.required,
  );
  if (requiresDependencyProof && !hasDependencyProof) rejectionReasons.push("no_dependency_proof");
  if (!isResearchSpec && implPaths.size === 0) rejectionReasons.push("no_implementation_files");

  // --- Score: clamp to [0, 1]; cap without exact evidence.
  let score = Math.max(0, Math.min(100, total)) / 100;
  if (proved.length === 0) score = Math.min(score, 0.4);

  const cls = classify({
    candidate,
    hasDependencyProof,
    implPathCount: implPaths.size,
    productionShaped,
    docsOnly,
    docsReference: docsAnchors.length > 0,
    toyish,
    isTemplateName,
    provedCount: proved.length,
    partialCount: partial.length,
    hasCandidateSignal,
  });

  if (cls === "false_positive") {
    rejectionReasons.push("ambiguous_feature");
    score = Math.min(score, 0.2);
  }

  return {
    repo: candidate.repo,
    score: round2(score),
    class: cls,
    positiveSignals,
    negativeSignals,
    missingProof,
    rejectionReasons: [...new Set(rejectionReasons)],
    nextAction: nextAction(score, cls),
  };
}

interface ClassifyInput {
  candidate: CandidateRepo;
  hasDependencyProof: boolean;
  implPathCount: number;
  productionShaped: boolean;
  docsOnly: boolean;
  docsReference: boolean;
  toyish: boolean;
  isTemplateName: boolean;
  provedCount: number;
  partialCount: number;
  hasCandidateSignal: (key: string, minConfidence?: number) => boolean;
}

function classify(input: ClassifyInput): CandidateClass {
  const {
    hasDependencyProof,
    implPathCount,
    productionShaped,
    docsOnly,
    docsReference,
    toyish,
    isTemplateName,
    provedCount,
    partialCount,
    hasCandidateSignal,
  } = input;

  if (hasCandidateSignal("false_positive")) return "false_positive";
  if (provedCount === 0 && partialCount === 0) {
    // Nothing matched in exact content. Docs-shaped repos without even a
    // docs reference are false positives; otherwise we cannot tell yet.
    if (docsOnly) return "false_positive";
    if (!input.candidate.candidateSignals.some((s) => s.confidence >= 0.5)) {
      return "false_positive";
    }
    return "unknown";
  }
  if (docsOnly && docsReference) return "docs";
  if (toyish) return "toy";
  if (isTemplateName && (implPathCount > 0 || hasDependencyProof)) return "template";
  if (hasDependencyProof && implPathCount >= 2 && productionShaped) return "production";
  if (implPathCount >= 1 || hasDependencyProof) return "reference";
  if (docsReference) return "docs";
  return "unknown";
}

function nextAction(score: number, cls: CandidateClass): NextAction {
  if (cls === "false_positive" || score < 0.25) return "reject";
  if (score >= 0.85) return "extract";
  if (score >= 0.5) return "read_more";
  if (cls === "docs" || cls === "reference" || cls === "template" || cls === "toy") {
    return "read_more";
  }
  return "reject";
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
