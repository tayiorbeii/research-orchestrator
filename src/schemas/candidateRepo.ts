import { z } from "zod";
import { EvidenceAnchorSchema } from "./evidenceAnchor.js";

export const SignalSourceSchema = z.enum([
  "metadata",
  "search",
  "file",
  "deepwiki",
  "human",
  "mock",
]);
export type SignalSource = z.infer<typeof SignalSourceSchema>;

export const SignalSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  weight: z.number().optional(),
  source: SignalSourceSchema,
  evidence: z.array(EvidenceAnchorSchema).optional(),
  confidence: z.number().min(0).max(1),
});
export type Signal = z.infer<typeof SignalSchema>;

/** Mirrors schemas/candidate_repo.schema.json. */
export const CandidateRepoSchema = z.object({
  repo: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().optional(),
  url: z.string().optional(),
  archived: z.boolean().optional(),
  stars: z.number().optional(),
  pushedAt: z.string().optional(),
  discoveredBy: z.array(z.string()),
  matchedPaths: z.array(z.string()),
  candidateSignals: z.array(SignalSchema),
  raw: z.unknown().optional(),
});
export type CandidateRepo = z.infer<typeof CandidateRepoSchema>;
