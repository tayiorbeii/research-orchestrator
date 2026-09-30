import type { ClaimAssessment, SourceObservation } from "../../schemas/researchContracts.js";
import { claimEvidenceOrigin, isAssessableObservation, RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION, SYNTHETIC_EVIDENCE_LIMITATION } from "../evidencePolicy.js";
import { renderTargetAssertion, type ClaimAssessor, type ClaimSpec } from "./types.js";

const valuePattern = /^key path\s+(.+?)\s+has literal value\s+(.+?)\s+in file\s+(.+)$/i;
const absentPattern = /^key path\s+(.+?)\s+is absent in file\s+(.+)$/i;

function sameSubject(claim: ClaimSpec, observation: SourceObservation): boolean {
  return observation.repo === claim.subject.repo &&
    (claim.subject.revision === undefined || observation.resolvedRevision === claim.subject.revision);
}

function result(claim: ClaimSpec, status: ClaimAssessment["status"], ids: string[], rationale: string, limitations: string[], remaining: string[], observationOrigin?: SourceObservation["origin"]): ClaimAssessment {
  const evidenceOrigin = observationOrigin ? claimEvidenceOrigin({ origin: observationOrigin }) : undefined;
  return {
    claimId: claim.claimId,
    questionId: claim.questionId,
    subject: claim.subject,
    assertion: claim.assertion,
    requiredObservationIds: ids,
    status,
    method: "config_value",
    assessorOrigin: "engine",
    ...(evidenceOrigin ? { evidenceOrigin } : {}),
    evidencePolicyVersion: RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION,
    rationale,
    remainingObligations: remaining,
    limitations: evidenceOrigin === "synthetic" ? [...limitations, SYNTHETIC_EVIDENCE_LIMITATION] : limitations,
  };
}

function keyPath(root: unknown, path: string): { found: boolean; value?: unknown } {
  let current = root;
  for (const part of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      const index = Number(part);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, part)) {
      current = (current as Record<string, unknown>)[part];
    } else return { found: false };
  }
  return { found: true, value: current };
}

function parseExpected(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

export const configValueAssessor: ClaimAssessor = (claim, observations) => {
  if (claim.target && claim.assertion !== renderTargetAssertion(claim.target)) return result(claim, "unsupported", [], "assertion does not match structured target", ["The assertion must render the structured target exactly."], ["Use the canonical assertion rendered from the structured target."]);
  if (claim.target && claim.target.kind !== "config") return result(claim, "unsupported", [], "structured target does not match config assessor", [], ["Use a config target for configuration value assessment."]);
  const structured = claim.target?.kind === "config" ? claim.target : undefined;
  const valueMatch = structured ? null : claim.assertion.match(valuePattern);
  const absentMatch = structured ? null : claim.assertion.match(absentPattern);
  if (!structured && !valueMatch && !absentMatch) return result(claim, "unsupported", [], "The assertion does not use a supported literal configuration value form.", ["Claims are limited to a JSON key path with a literal value or an explicit absence assertion."], ["Restate the claim as a literal key-path fact."]);

  const key = structured?.keyPath ?? valueMatch?.[1] ?? absentMatch?.[1] ?? "";
  const expected = structured ? structured.value : valueMatch ? parseExpected(valueMatch[2]!) : undefined;
  const absent = structured ? false : Boolean(absentMatch);
  const path = structured?.file ?? valueMatch?.[3] ?? absentMatch?.[2];
  const matching = observations.filter((item) => sameSubject(claim, item) && (path === undefined || item.path === path) && item.excerpt !== undefined);
  if (matching.length === 0) return result(claim, "not_assessed", [], "No same-repository, matching-revision observation was available for the asserted file.", ["A claim naming a revision requires an observation resolved to that revision."], ["Read the asserted configuration file at the claim's repository revision."]);
  if (!matching.some(isAssessableObservation)) return result(claim, "not_assessed", matching.map((item) => item.id), "Non-engine observations cannot produce engine-supported assessments.", ["Only engine or synthetic configuration observations are assessed."], ["Read the configuration from an engine-origin source observation."]);

  for (const observation of matching.filter(isAssessableObservation)) {
    const format = (observation.path ?? "").toLowerCase().split("?")[0]!;
    if (!format.endsWith(".json") || format.endsWith(".jsonc")) {
      return result(claim, "partial", [observation.id], "The source format is not safely parsed by this assessor; its text can be quoted only.", ["no safe parser installed; quotation only", "Other occurrences or overrides in this observation or elsewhere are not reconciled; only this observed text is in scope."], ["Use a strict JSON observation or obtain a format-specific assessment."], observation.origin);
    }

    let parsed: unknown;
    try { parsed = JSON.parse(observation.excerpt!); } catch {
      return result(claim, "partial", [observation.id], "The excerpt is not complete valid strict JSON, so the literal value cannot be established safely.", ["The JSON excerpt may be partial or malformed.", "Other occurrences or overrides in this observation or elsewhere are not reconciled; only this observed text is in scope."], ["Provide a complete valid strict JSON excerpt."], observation.origin);
    }

    const selected = keyPath(parsed, key);
    const matches = absent ? !selected.found : selected.found && (expected === undefined || JSON.stringify(selected.value) === JSON.stringify(expected));
    const limitations = ["This establishes a literal value in this observation only; runtime use and enforcement are not assessed.", "Other occurrences or overrides in this observation or elsewhere are not reconciled; only this parsed key path is reported."];
    if (observation.readStatus === "partial") limitations.push("The partial read may omit other configuration values; it cannot establish absence.");
    if (observation.revisionStatus !== "immutable") limitations.push("The observation revision is not established as immutable.");
    if (absent && observation.readStatus === "partial") {
      return result(claim, "unsupported", [observation.id], "A partial JSON read cannot establish that the key path is absent outside the returned excerpt.", limitations, ["Inspect the complete same-revision JSON file before making an absence claim."], observation.origin);
    }
    if (matches) return result(claim, "supported", [observation.id], absent ? "The key path is absent in the parsed same-subject JSON observation." : "The parsed same-subject JSON observation contains the asserted key path and value at the requested location.", limitations, [], observation.origin);
    const status = observation.readStatus === "partial" ? "partial" : "unsupported";
    return result(claim, status, [observation.id], "The parsed observation does not establish the asserted value; unsupported does not mean false.", limitations, ["Inspect a complete same-revision JSON observation or narrow the claim."], observation.origin);
  }
  return result(claim, "unsupported", matching.map((item) => item.id), "No supplied observation established the asserted configuration value.", ["Unsupported means the supplied evidence does not establish the claim."], ["Inspect the relevant strict JSON source."]);
};
