import { z } from "zod";
import { SignalSchema } from "./candidateRepo.js";

export const CandidateClassSchema = z.enum([
  "production",
  "reference",
  "docs",
  "template",
  "toy",
  "false_positive",
  "unknown",
]);
export type CandidateClass = z.infer<typeof CandidateClassSchema>;

export const NextActionSchema = z.enum([
  "reject",
  "read_more",
  "deepwiki",
  "clone",
  "extract",
]);
export type NextAction = z.infer<typeof NextActionSchema>;

export const RejectionReasonSchema = z.enum([
  "no_dependency_proof",
  "no_implementation_files",
  "docs_only",
  "toy_demo",
  "archived",
  "stale_dependency",
  "ambiguous_feature",
  "conflicting_evidence",
  "private_or_unreadable",
  "rate_limited_or_incomplete",
]);
export type RejectionReason = z.infer<typeof RejectionReasonSchema>;

export const ScoredCandidateSchema = z.object({
  repo: z.string().min(1),
  score: z.number().min(0).max(1),
  class: CandidateClassSchema,
  positiveSignals: z.array(SignalSchema),
  negativeSignals: z.array(SignalSchema),
  missingProof: z.array(z.string()),
  rejectionReasons: z.array(RejectionReasonSchema),
  nextAction: NextActionSchema,
});
export type ScoredCandidate = z.infer<typeof ScoredCandidateSchema>;
