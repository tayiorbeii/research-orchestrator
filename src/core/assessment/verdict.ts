import type { ClaimAssessment, SourceObservation } from "../../schemas/researchContracts.js";
import { claimEvidenceOrigin, RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION, SYNTHETIC_EVIDENCE_LIMITATION } from "../evidencePolicy.js";
import type { ClaimSpec } from "./types.js";

/** An observation belongs to a claim's subject when repository and (if pinned) revision match. */
export function sameSubject(claim: Pick<ClaimSpec, "subject">, observation: SourceObservation): boolean {
  return observation.repo === claim.subject.repo &&
    (claim.subject.revision === undefined || observation.resolvedRevision === claim.subject.revision);
}

/**
 * The one way an assessor states its result. Every assessor fills the same
 * envelope (identity, method, policy version, evidence origin, synthetic
 * limitation), so a change to the envelope happens here once.
 */
export function verdict(
  claim: ClaimSpec,
  method: ClaimAssessment["method"],
  status: ClaimAssessment["status"],
  requiredObservationIds: string[],
  rationale: string,
  limitations: string[],
  remainingObligations: string[],
  observationOrigin?: SourceObservation["origin"],
): ClaimAssessment {
  const evidenceOrigin = observationOrigin ? claimEvidenceOrigin({ origin: observationOrigin }) : undefined;
  return {
    claimId: claim.claimId,
    questionId: claim.questionId,
    ...(claim.fact ? { fact: claim.fact } : {}),
    subject: claim.subject,
    assertion: claim.assertion,
    requiredObservationIds,
    status,
    method,
    assessorOrigin: "engine",
    ...(evidenceOrigin ? { evidenceOrigin } : {}),
    evidencePolicyVersion: RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION,
    rationale,
    remainingObligations,
    limitations: evidenceOrigin === "synthetic" && !limitations.includes(SYNTHETIC_EVIDENCE_LIMITATION)
      ? [...limitations, SYNTHETIC_EVIDENCE_LIMITATION]
      : limitations,
  };
}
