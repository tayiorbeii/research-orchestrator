import { z } from "zod";
import { EvidenceAnchorSchema, EvidencePolicyVersionSchema, EvidenceProviderNameSchema } from "./evidenceAnchor.js";

export const SourceObservationKindSchema = z.enum([
  "repository_file", "repository_metadata", "documentation_page", "issue_proposal", "local_artifact", "synthetic_fixture",
]);
export type SourceObservationKind = z.infer<typeof SourceObservationKindSchema>;
export const RevisionStatusSchema = z.enum(["immutable", "moving_ref", "unknown"]);
export const ObservationReadStatusSchema = z.enum(["complete", "partial", "unavailable", "failed"]);
export const ObservationOriginSchema = z.enum(["engine", "external", "legacy", "synthetic"]);

export const SourceObservationSchema = z.object({
  id: z.string().min(1),
  kind: SourceObservationKindSchema,
  repo: z.string().optional(),
  url: z.string().optional(),
  issueState: z.enum(["open", "closed"]).optional(),
  path: z.string().optional(),
  requestedRevision: z.string().optional(),
  resolvedRevision: z.string().optional(),
  revisionStatus: RevisionStatusSchema,
  excerpt: z.string().optional(),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  retrievedAt: z.string(),
  contentHash: z.string().optional(),
  provider: EvidenceProviderNameSchema.optional(),
  retrievalMethod: z.string().min(1),
  readStatus: ObservationReadStatusSchema,
  offsetStart: z.number().int().min(0).optional(),
  offsetSemantics: z.string().optional(),
  truncationNotice: z.string().optional(),
  origin: ObservationOriginSchema,
  redacted: z.boolean().optional(),
  redactionNotes: z.array(z.string()).optional(),
  anchor: EvidenceAnchorSchema.optional(),
});
export type SourceObservation = z.infer<typeof SourceObservationSchema>;

export const ClaimStatusSchema = z.enum(["supported", "partial", "unsupported", "contradicted", "not_assessed"]);
export const ClaimAssessmentMethodSchema = z.enum([
  "exact_source_quotation", "dependency_declaration", "config_value", "workflow_command",
]);
export const AssessorOriginSchema = z.enum(["engine", "external", "legacy"]);
export const ClaimEvidenceOriginSchema = z.enum(["live", "synthetic"]);

export const ClaimAssessmentSchema = z.object({
  claimId: z.string().min(1),
  questionId: z.string().min(1),
  subject: z.object({ repo: z.string().min(1), revision: z.string().optional() }),
  assertion: z.string().min(1),
  requiredObservationIds: z.array(z.string()),
  status: ClaimStatusSchema,
  method: ClaimAssessmentMethodSchema,
  assessorOrigin: AssessorOriginSchema,
  evidenceOrigin: ClaimEvidenceOriginSchema.optional(),
  evidencePolicyVersion: EvidencePolicyVersionSchema,
  rationale: z.string(),
  remainingObligations: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type ClaimAssessment = z.infer<typeof ClaimAssessmentSchema>;

export const QuestionCoverageStatusSchema = z.enum(["satisfied", "partial", "unresolved", "not_attempted"]);
export const QuestionCoverageSchema = z.object({
  questionId: z.string().min(1),
  status: QuestionCoverageStatusSchema,
  supportedClaimIds: z.array(z.string()),
  partialClaimIds: z.array(z.string()),
  contradictedClaimIds: z.array(z.string()),
  unsatisfiedObligations: z.array(z.string()),
  uninspectedCandidates: z.array(z.string()),
  unavailableSources: z.array(z.string()),
  suggestedNextActions: z.array(z.string()),
});
export type QuestionCoverage = z.infer<typeof QuestionCoverageSchema>;

export const RunOutcomeStatusSchema = z.enum(["complete", "partial", "inconclusive", "needs_input", "failed"]);
export const RunOutcomeSchema = z.object({ status: RunOutcomeStatusSchema, reasons: z.array(z.string()) });
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const CandidateStateSchema = z.object({
  repo: z.string().min(1),
  state: z.enum(["uninspected", "inspected", "eligible", "ineligible", "unavailable"]),
  reason: z.string().optional(),
});
export type CandidateState = z.infer<typeof CandidateStateSchema>;
