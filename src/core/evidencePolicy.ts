import type { EvidenceAnchor } from "../schemas/evidenceAnchor.js";
import type { ScoredCandidate } from "../schemas/scoredCandidate.js";
import type { SourceObservation } from "../schemas/researchContracts.js";

export type ClaimEvidenceOrigin = "live" | "synthetic";
export const SYNTHETIC_EVIDENCE_LIMITATION = "Synthetic fixture observation; not a live repository finding.";

export function isAssessableObservation(observation: Pick<SourceObservation, "origin">): boolean {
  return observation.origin === "engine" || observation.origin === "synthetic";
}

export function claimEvidenceOrigin(observation: Pick<SourceObservation, "origin">): ClaimEvidenceOrigin | undefined {
  if (observation.origin === "engine") return "live";
  if (observation.origin === "synthetic") return "synthetic";
  return undefined;
}

export const EVIDENCE_POLICY_VERSION = "phase1_exact_quotation_v1" as const;
export const RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION = "phase2_claim_evidence_v2" as const;
export const LEGACY_EVIDENCE_POLICY_VERSION = "legacy_unvalidated" as const;

/** A read excerpt supports only that the cited source states the quoted text. */
export function isExactQuotationSupport(anchor: EvidenceAnchor): boolean {
  return (
    anchor.evidencePolicyVersion === EVIDENCE_POLICY_VERSION &&
    anchor.supportMethod === "exact_source_quotation" &&
    Boolean(anchor.matchText?.trim()) &&
    anchor.startLine !== undefined &&
    anchor.endLine !== undefined
  );
}

/** Imported JSON is useful as a lead, but its assertions are not engine support. */
export function downgradeImportedAnchor(anchor: EvidenceAnchor): EvidenceAnchor {
  return {
    ...anchor,
    proofLevel: "partial",
    evidencePolicyVersion: LEGACY_EVIDENCE_POLICY_VERSION,
    supportMethod: undefined,
  };
}

export function downgradeImportedScore(score: ScoredCandidate): ScoredCandidate {
  return {
    ...score,
    score: Math.min(score.score, 0.4),
    class: "unknown",
    positiveSignals: score.positiveSignals.map((signal) => ({
      ...signal,
      confidence: Math.min(signal.confidence, 0.49),
      evidence: signal.evidence?.map(downgradeImportedAnchor),
    })),
    negativeSignals: score.negativeSignals.map((signal) => ({
      ...signal,
      confidence: Math.min(signal.confidence, 0.49),
      evidence: signal.evidence?.map(downgradeImportedAnchor),
    })),
    missingProof: [...new Set([...score.missingProof, "legacy_unvalidated: re-read sources to assess support"])],
    rejectionReasons: [],
    nextAction: "read_more",
  };
}
