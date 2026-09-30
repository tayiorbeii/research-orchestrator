import { z } from "zod";
import { FeatureSpecSchema } from "./featureSpec.js";
import { SearchProbeSchema } from "./searchProbe.js";
import { CandidateRepoSchema } from "./candidateRepo.js";
import { ScoredCandidateSchema } from "./scoredCandidate.js";
import { EvidenceAnchorSchema, EvidencePolicyVersionSchema, EvidenceProviderNameSchema } from "./evidenceAnchor.js";
import {
  CandidateStateSchema,
  ClaimAssessmentSchema,
  QuestionCoverageSchema,
  RunOutcomeSchema,
  SourceObservationSchema,
} from "./researchContracts.js";
import { BudgetLedgerSchema, ProbeOutcomeSchema, SearchProbeV2Schema } from "./searchProbeV2.js";
import { ResearchBriefSchema } from "./researchBrief.js";

export const ArtifactRefSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["research", "plan", "evidence", "checklist", "report"]),
  createdAt: z.string(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const EvidenceOriginSchema = z.enum([
  "repository_observation",
  "synthetic_mock",
  "legacy_unvalidated",
]);

export const RepoQuestionAnswerSchema = z.object({
  question: z.string(),
  answer: z.string(),
  evidence: z.array(EvidenceAnchorSchema),
  confidence: z.number().min(0).max(1),
  verified: z.boolean(),
});
export type RepoQuestionAnswer = z.infer<typeof RepoQuestionAnswerSchema>;

export const ImplementationMapSchema = z.object({
  dependencies: z.array(z.string()),
  files: z.array(
    z.object({
      path: z.string(),
      role: z.string(),
      keyExports: z.array(z.string()).optional(),
      evidence: z.array(EvidenceAnchorSchema),
    }),
  ),
  serverFlow: z.array(z.string()),
  clientFlow: z.array(z.string()),
  environmentVariables: z.array(z.string()),
  routeProtection: z.array(z.string()).optional(),
  tests: z.array(z.string()).optional(),
  pitfalls: z.array(z.string()),
});
export type ImplementationMap = z.infer<typeof ImplementationMapSchema>;

export const RepoPatternExplanationSchema = z.object({
  repo: z.string(),
  evidencePolicyVersion: EvidencePolicyVersionSchema.optional(),
  evidenceOrigin: EvidenceOriginSchema.optional(),
  source: z.enum(["deepwiki", "octocode_fallback", "hybrid", "mock"]),
  freshness: z
    .object({
      checkedAt: z.string(),
      lastIndexedAt: z.string().optional(),
      indexedCommit: z.string().optional(),
      stale: z.boolean().optional(),
    })
    .optional(),
  answers: z.array(RepoQuestionAnswerSchema),
  implementationMap: ImplementationMapSchema,
  warnings: z.array(z.string()),
});
export type RepoPatternExplanation = z.infer<typeof RepoPatternExplanationSchema>;

export const RepoExplanationResultSchema = z.discriminatedUnion("status", [
  z.object({ repo: z.string().min(1), status: z.literal("succeeded"), explanation: RepoPatternExplanationSchema }),
  z.object({ repo: z.string().min(1), status: z.literal("failed"), error: z.string().min(1), errorClass: z.string().optional() }),
]);
export type RepoExplanationResult = z.infer<typeof RepoExplanationResultSchema>;

/** Mirrors schemas/research_run.schema.json. */
const ResearchRunBaseSchema = z.object({
  id: z.string().min(1),
  evidencePolicyVersion: EvidencePolicyVersionSchema.optional(),
  evidenceOrigin: EvidenceOriginSchema.optional(),
  providerName: EvidenceProviderNameSchema.optional(),
  createdAt: z.string(),
  goal: z.string(),
  featureSpec: FeatureSpecSchema,
  probes: z.array(SearchProbeSchema),
  candidates: z.array(CandidateRepoSchema),
  scoredCandidates: z.array(ScoredCandidateSchema),
  selectedRepos: z.array(z.string()),
  explanations: z.array(RepoPatternExplanationSchema).default([]),
  artifacts: z.array(ArtifactRefSchema),
  warnings: z.array(z.string()),
});

export const ResearchRunV2Schema = ResearchRunBaseSchema.extend({
  schemaVersion: z.literal(2),
  evidencePolicyVersion: z.literal("phase2_claim_evidence_v2"),
  parentRunId: z.string().min(1).optional(),
  providerName: EvidenceProviderNameSchema,
  observations: z.array(SourceObservationSchema),
  assessments: z.array(ClaimAssessmentSchema),
  coverage: z.array(QuestionCoverageSchema),
  outcome: RunOutcomeSchema,
  candidateStates: z.array(CandidateStateSchema),
  explanationResults: z.array(RepoExplanationResultSchema),
  brief: ResearchBriefSchema.optional(),
  probesV2: z.array(SearchProbeV2Schema).optional(),
  compiledProbes: z.array(SearchProbeV2Schema).optional(),
  probeOutcomes: z.array(ProbeOutcomeSchema).optional(),
  budgetLedger: BudgetLedgerSchema.optional(),
}).superRefine((run, ctx) => {
  if (run.brief !== undefined) {
    for (const key of ["probeOutcomes", "budgetLedger"] as const) {
      if (run[key] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Required when brief is present` });
    }
  }
});
export type ResearchRunV2 = z.infer<typeof ResearchRunV2Schema>;

export const ResearchRunSchema = ResearchRunBaseSchema.extend({
  schemaVersion: z.literal(2).optional(),
  observations: z.array(SourceObservationSchema).optional(),
  assessments: z.array(ClaimAssessmentSchema).optional(),
  coverage: z.array(QuestionCoverageSchema).optional(),
  outcome: RunOutcomeSchema.optional(),
  candidateStates: z.array(CandidateStateSchema).optional(),
  explanationResults: z.array(RepoExplanationResultSchema).optional(),
  brief: ResearchBriefSchema.optional(),
  probesV2: z.array(SearchProbeV2Schema).optional(),
  compiledProbes: z.array(SearchProbeV2Schema).optional(),
  probeOutcomes: z.array(ProbeOutcomeSchema).optional(),
  budgetLedger: BudgetLedgerSchema.optional(),
}).superRefine((run, ctx) => {
  if (run.schemaVersion !== 2) return;
  for (const key of ["observations", "assessments", "coverage", "outcome", "candidateStates", "explanationResults"] as const) {
    if (run[key] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Required for schemaVersion 2` });
  }
  if (run.evidencePolicyVersion !== "phase2_claim_evidence_v2") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidencePolicyVersion"], message: "Version 2 runs require the v2 evidence policy" });
  }
  if (run.brief !== undefined) {
    for (const key of ["probeOutcomes", "budgetLedger"] as const) {
      if (run[key] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Required when brief is present` });
    }
  }
});
export type ResearchRun = z.infer<typeof ResearchRunSchema>;

export type DetectedRunVersion = "v1" | "v2" | "unknown";

/** Detects envelope generation without loading, mutating, or trusting run data. */
export function detectRunVersion(raw: unknown): DetectedRunVersion {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "unknown";
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion === 2) return "v2";
  if (record.schemaVersion !== undefined) return "unknown";
  const legacyEnvelopeKeys = ["id", "createdAt", "goal", "featureSpec", "probes", "candidates", "scoredCandidates", "selectedRepos"];
  return legacyEnvelopeKeys.every((key) => key in record) ? "v1" : "unknown";
}
