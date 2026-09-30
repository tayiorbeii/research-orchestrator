import { claimEvidenceOrigin, isAssessableObservation, isExactQuotationSupport, RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION, SYNTHETIC_EVIDENCE_LIMITATION } from "../evidencePolicy.js";
import type { ClaimAssessment, SourceObservation } from "../../schemas/researchContracts.js";
import { configValueAssessor } from "./configValue.js";
import { dependencyDeclarationAssessor } from "./dependencyDeclaration.js";
import { workflowCommandAssessor } from "./workflowCommand.js";
import { classifySourcePath } from "../sourceSelection.js";

export type ClaimTarget =
  | { kind: "dependency"; packageName: string; constraint?: string; file?: string }
  | { kind: "config"; keyPath: string; value?: unknown; file?: string }
  | { kind: "workflow"; command: string; file?: string }
  | { kind: "quotation"; path?: string; signals: string[]; claimScope?: "advertised" | "proposed" | "implemented" };

export function renderTargetAssertion(target: ClaimTarget): string {
  switch (target.kind) {
    case "dependency":
      return `package ${target.packageName} is declared${target.constraint === undefined ? "" : ` at constraint ${target.constraint}`} ${target.file ? `in file ${target.file}` : "in a dependency manifest"}`;
    case "config":
      return Object.hasOwn(target, "value")
        ? `key path ${target.keyPath} has literal value ${JSON.stringify(target.value)} ${target.file ? `in file ${target.file}` : "in a JSON file"}`
        : `key path ${target.keyPath} is present ${target.file ? `in file ${target.file}` : "in a JSON file"}`;
    case "workflow":
      return `workflow command ${target.command} is present ${target.file ? `in file ${target.file}` : "in a workflow file"}`;
    case "quotation":
      return `${target.claimScope ? `${target.claimScope}: ` : ""}source ${target.path ?? "<path>"} states: ${target.signals.map((signal) => `"${signal}"`).join(", ")}`;
  }
}

export interface ClaimSpec {
  claimId: string;
  questionId: string;
  subject: { repo: string; revision?: string };
  assertion: string;
  target?: ClaimTarget;
}

/** Pure assessor contract: no retrieval, mutation, or hidden policy state. */
export type ClaimAssessor = (
  claim: ClaimSpec,
  observations: readonly SourceObservation[],
) => ClaimAssessment;

/** Composite facts must be assessed against one repository and revision context. */
export const SAME_SUBJECT_RULE =
  "A composite claim binds to one repository and revision context; observations from different subjects cannot be combined.";

const exactSourceQuotationAssessor: ClaimAssessor = (claim, observations) => {
  const matching = observations.filter((observation) =>
    observation.repo === claim.subject.repo &&
    (claim.subject.revision === undefined || observation.resolvedRevision === claim.subject.revision) &&
    (claim.target?.kind !== "quotation" || !claim.target.claimScope || quotationScopeAllows(claim.target, observation)),
  );
  const supporting = matching.find((observation) =>
    isAssessableObservation(observation) &&
    (claim.target?.kind !== "quotation" || quotationScopeAllows(claim.target, observation)) &&
    observation.anchor !== undefined &&
    isExactQuotationSupport(observation.anchor) &&
    anchorBoundToObservation(observation) &&
    (claim.target?.kind === "quotation"
      ? (claim.target.path === undefined || observation.path === claim.target.path) &&
        claim.target.signals.length > 0 &&
        claim.target.signals.every((signal) => signal.length > 0 && observation.excerpt?.includes(signal))
      : observation.excerpt?.includes(claim.assertion)),
  );
  const nonEngineOnly = matching.length > 0 && !matching.some(isAssessableObservation);
  const assessedObservation = supporting ?? matching.find(isAssessableObservation);
  const evidenceOrigin = assessedObservation ? claimEvidenceOrigin(assessedObservation) : undefined;
  const limitations = supporting ? ["Supports only that the source states the quoted text."] : [];
  if (supporting?.kind === "issue_proposal" && supporting.issueState === "closed") {
    limitations.push("The issue is closed; closure does not establish that the proposal shipped or was rejected.");
  }
  if (evidenceOrigin === "synthetic") limitations.push(SYNTHETIC_EVIDENCE_LIMITATION);
  const status = supporting ? "supported" : matching.length === 0 || nonEngineOnly ? "not_assessed" : "unsupported";
  const base = {
    claimId: claim.claimId,
    questionId: claim.questionId,
    subject: claim.subject,
    assertion: claim.assertion,
    requiredObservationIds: supporting ? [supporting.id] : matching.map((observation) => observation.id),
    method: "exact_source_quotation" as const,
    assessorOrigin: "engine" as const,
    ...(evidenceOrigin ? { evidenceOrigin } : {}),
    evidencePolicyVersion: RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION,
    rationale: supporting
      ? claim.target?.kind === "quotation"
        ? "One same-subject source observation from the requested path contains every required quotation signal."
        : "The same-subject source observation contains the exact asserted quotation."
      : nonEngineOnly
        ? "Non-engine observations cannot produce engine-supported assessments."
        : matching.length === 0
        ? "No observation was available for the claim's repository and revision context."
        : "The same-subject observations did not pass the Phase 1 exact quotation policy for this assertion.",
    remainingObligations: supporting ? [] : ["Retrieve and validate a same-subject exact source quotation."],
    limitations,
  };
  return { ...base, status };
};

function isIgnoreFile(path: string): boolean {
  return /^\.(git|docker|npm|eslint|prettier|hg)ignore$/i.test(path.split("/").at(-1) ?? path);
}

function quotationScopeAllows(target: Extract<ClaimTarget, { kind: "quotation" }>, observation: SourceObservation): boolean {
  if (observation.kind === "issue_proposal") return target.claimScope === "proposed";
  if (target.claimScope === "proposed") return false;
  if (target.claimScope === "advertised") {
    return observation.kind === "documentation_page" ||
      observation.kind === "repository_file" && classifySourcePath(observation.path ?? "") === undefined;
  }
  if (target.claimScope === "implemented") {
    if (observation.kind !== "repository_file") return false;
    // An ignore file implements an ignore rule only when the claim names that file;
    // otherwise an incidental mention (e.g. `.ruff_cache/`) would prove unrelated tools.
    if (isIgnoreFile(observation.path ?? "")) return target.path !== undefined && target.path === observation.path;
    return classifySourcePath(observation.path ?? "") !== undefined;
  }
  // Repository documentation and historical files need an explicit advertised
  // label; implementation/config files remain usable for unscoped quotations.
  return observation.kind !== "repository_file" || classifySourcePath(observation.path ?? "") !== undefined;
}

function anchorBoundToObservation(observation: SourceObservation): boolean {
  const anchor = observation.anchor;
  if (!anchor || anchor.repo !== observation.repo || anchor.path !== observation.path ||
      anchor.startLine === undefined || anchor.endLine === undefined ||
      observation.startLine === undefined || observation.endLine === undefined ||
      anchor.startLine < observation.startLine || anchor.endLine > observation.endLine ||
      (observation.resolvedRevision !== undefined && anchor.ref !== observation.resolvedRevision)) return false;
  const excerptLines = observation.excerpt?.split(/\r?\n/);
  if (!excerptLines || !anchor.matchText) return false;
  const start = anchor.startLine - observation.startLine;
  const end = anchor.endLine - observation.startLine;
  return excerptLines.slice(start, end + 1).join("\n").includes(anchor.matchText);
}

export const claimAssessorRegistry: Readonly<Record<string, ClaimAssessor>> = {
  exact_source_quotation: exactSourceQuotationAssessor,
  dependency_declaration: dependencyDeclarationAssessor,
  config_value: configValueAssessor,
  workflow_command: workflowCommandAssessor,
};
