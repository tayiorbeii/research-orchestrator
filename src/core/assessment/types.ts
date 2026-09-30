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
        claim.target.signals.every((signal) => signal.length > 0 && observation.excerpt?.includes(signal)) &&
        signalsNearby(observation.excerpt ?? "", claim.target.signals)
      : observation.excerpt?.includes(claim.assertion)),
  );
  // A signal that appears only on import/use/require/re-export lines shows the
  // name is referenced, not that the behavior is implemented there: keep it as
  // a partial lead instead of support for implemented/unscoped source claims.
  const importOnly = supporting && claim.target?.kind === "quotation" && claim.target.claimScope !== "advertised" &&
    supporting.kind === "repository_file" && classifySourcePath(supporting.path ?? "") !== undefined &&
    claim.target.signals.some((signal) => !signalOnSubstantiveLine(supporting.excerpt ?? "", signal));
  if (importOnly) {
    return {
      claimId: claim.claimId, questionId: claim.questionId, subject: claim.subject, assertion: claim.assertion,
      requiredObservationIds: [supporting!.id], method: "exact_source_quotation" as const, assessorOrigin: "engine" as const,
      evidenceOrigin: claimEvidenceOrigin(supporting!), evidencePolicyVersion: RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION,
      rationale: "The source mentions a required signal only on import, use, require, or re-export lines; that is a lead, not evidence of implementation.",
      remainingObligations: ["Read the file where the imported name is defined or used."],
      limitations: ["Import lines establish a reference, not behavior.", ...(claimEvidenceOrigin(supporting!) === "synthetic" ? [SYNTHETIC_EVIDENCE_LIMITATION] : [])],
      status: "partial",
    };
  }
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

const IMPORT_LINE = /^\s*(?:import\b|export\s+(?:\*|\{[^}]*\})\s+from\b|from\s+[\w.]+\s+import\b|(?:pub(?:\([^)]*\))?\s+)?use\s+[\w:{}, *]+;|#include\b|(?:const|let|var)\s+[^=]+=\s*require\()/;

/** Lines that belong to import statements, including multi-line
 * `import { … } from` (JS/TS) and `use a::{ … };` (Rust) blocks. */
function importLineMask(lines: readonly string[]): boolean[] {
  const mask = lines.map((line) => IMPORT_LINE.test(line));
  let open: "js" | "rs" | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!open) {
      if (/^\s*(?:import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?|export\s+(?:type\s+)?)\{[^}]*$/.test(line)) { open = "js"; mask[i] = true; }
      else if (/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+[\w:]*\{[^}]*$/.test(line)) { open = "rs"; mask[i] = true; }
      continue;
    }
    mask[i] = true;
    if ((open === "js" && /\}\s*from\b/.test(line)) || (open === "rs" && /\}\s*;/.test(line))) open = undefined;
  }
  return mask;
}

/** True when the signal occurs on at least one line that is not an import. */
function signalOnSubstantiveLine(excerpt: string, signal: string): boolean {
  const lines = excerpt.split(/\r?\n/);
  const mask = importLineMask(lines);
  return lines.some((line, index) => line.includes(signal) && !mask[index]);
}

/** Window within which a multi-signal quotation's signals must co-occur. */
export const QUOTATION_SIGNAL_WINDOW_LINES = 12;

/**
 * Several required signals must appear close together: two strings in
 * unrelated parts of one file (a "10,000" limit on one line, an API name 20
 * lines later) do not state a combined fact.
 */
function signalsNearby(excerpt: string, signals: readonly string[]): boolean {
  if (signals.length < 2) return true;
  const lines = excerpt.split(/\r?\n/);
  const positions = signals.map((signal) => lines.flatMap((line, index) => line.includes(signal) ? [index] : []));
  if (positions.some((list) => list.length === 0)) return false;
  // Some line of the first signal must have every other signal within the window.
  return positions[0]!.some((anchor) => positions.slice(1).every((list) => list.some((index) => Math.abs(index - anchor) <= QUOTATION_SIGNAL_WINDOW_LINES)));
}

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
