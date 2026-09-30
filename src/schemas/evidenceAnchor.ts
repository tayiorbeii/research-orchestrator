import { z } from "zod";

export const EvidenceProviderNameSchema = z.enum([
  "octocode",
  "github",
  "deepwiki",
  "local",
  "mock",
]);
export type EvidenceProviderName = z.infer<typeof EvidenceProviderNameSchema>;

export const ProofLevelSchema = z.enum(["candidate", "partial", "proved"]);
export type ProofLevel = z.infer<typeof ProofLevelSchema>;

export const EvidencePolicyVersionSchema = z.enum([
  "phase1_exact_quotation_v1",
  "phase2_claim_evidence_v2",
  "legacy_unvalidated",
]);
export const EvidenceSupportMethodSchema = z.enum(["exact_source_quotation"]);

/** Mirrors schemas/evidence_anchor.schema.json. */
export const EvidenceAnchorSchema = z.object({
  id: z.string().min(1),
  provider: EvidenceProviderNameSchema,
  repo: z.string().optional(),
  ref: z.string().optional(),
  path: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  matchText: z.string().optional(),
  matchedSignal: z.string().optional(),
  url: z.string().optional(),
  role: z.string().min(1),
  proofLevel: ProofLevelSchema,
  evidencePolicyVersion: EvidencePolicyVersionSchema.optional(),
  supportMethod: EvidenceSupportMethodSchema.optional(),
});
export type EvidenceAnchor = z.infer<typeof EvidenceAnchorSchema>;
