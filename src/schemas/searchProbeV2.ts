import { z } from "zod";
import { SourceObservationKindSchema } from "./researchContracts.js";

export const SearchProbePurposeSchema = z.enum(["discovery", "source_location", "candidate_check"]);
export const SearchProbeV2Schema = z.object({
  id: z.string().min(1),
  questionIds: z.array(z.string().min(1)),
  mechanismIds: z.array(z.string().min(1)),
  termIds: z.array(z.string().min(1)),
  purpose: SearchProbePurposeSchema,
  intent: z.string().min(1),
  providerQuery: z.string().min(1),
  providerArgs: z.record(z.unknown()),
  expectedSourceKinds: z.array(SourceObservationKindSchema),
  expectedPaths: z.array(z.string()),
  capabilityVersion: z.string().optional(),
  rationale: z.string().min(1),
  alternativesLeftOpen: z.array(z.string()),
  predecessorProbeIds: z.array(z.string()),
  refinementReason: z.enum(["ambiguous_terms", "incidental_matches", "empty_scoped_result", "unsupported_qualifier", "new_term_observed"]).optional(),
});
export type SearchProbeV2 = z.infer<typeof SearchProbeV2Schema>;

export const ProbeOutcomeSchema = z.object({
  probeId: z.string().min(1),
  status: z.enum(["not_attempted", "succeeded", "failed"]),
  resultClass: z.enum(["empty", "relevant_leads", "noisy", "pagination_limit"]).optional(),
  basis: z.string().optional(),
  errorClass: z.string().optional(),
  failureKind: z.enum(["transport_failure", "access_denied", "pagination_limit"]).optional(),
  truncated: z.boolean().optional(),
  resultIds: z.array(z.string()),
  queryUnits: z.number().int().nonnegative(),
  requestCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative().optional(),
  reason: z.string().optional(),
  predecessorProbeIds: z.array(z.string()),
}).superRefine((outcome, ctx) => {
  if (outcome.status === "succeeded" && (!outcome.resultClass || !outcome.basis)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["basis"], message: "Successful outcomes require a result class and its basis." });
  }
  if (outcome.status !== "succeeded" && outcome.resultClass !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resultClass"], message: "Only successful outcomes have a result class." });
  }
});
export type ProbeOutcome = z.infer<typeof ProbeOutcomeSchema>;

export const BudgetLedgerSchema = z.object({
  limits: z.object({
    maxQuestions: z.number().int().nonnegative(),
    queryUnits: z.number().int().nonnegative(),
    reconnaissanceReads: z.number().int().nonnegative(),
    fileReads: z.number().int().nonnegative(),
    fileReadsPerRepo: z.number().int().nonnegative(),
    refinementRounds: z.number().int().nonnegative(),
    refinementProbes: z.number().int().nonnegative(),
    deadlineMs: z.number().int().positive(),
  }),
  consumed: z.object({
    queryUnits: z.number().int().nonnegative(),
    rpcCount: z.number().int().nonnegative(),
    /** Metadata RPCs counted in rpcCount but not governed by another read budget. */
    unbudgetedMetadataCalls: z.number().int().nonnegative().optional(),
    metadataCallBreakdown: z.record(z.number().int().nonnegative()).optional(),
    reconnaissanceReads: z.number().int().nonnegative(),
    fileReads: z.number().int().nonnegative(),
    fileReadsByRepo: z.record(z.number().int().nonnegative()),
    refinementRounds: z.number().int().nonnegative(),
    refinementProbes: z.number().int().nonnegative(),
  }),
  reserved: z.object({ queryUnits: z.number().int().nonnegative() }).optional(),
  startedAt: z.string().optional(),
  deadlineAt: z.string().optional(),
  elapsedMs: z.number().nonnegative().optional(),
  cancelled: z.boolean(),
  exhaustion: z.object({
    questions: z.array(z.object({ questionId: z.string(), reason: z.string() })),
    repositories: z.array(z.object({ repo: z.string(), reason: z.string() })),
    referencedFiles: z.array(z.object({ repo: z.string(), path: z.string(), reason: z.string() })),
  }).optional(),
});
export type BudgetLedger = z.infer<typeof BudgetLedgerSchema>;

export const DEFAULT_BUDGET_LEDGER_LIMITS = Object.freeze({
  maxQuestions: 6,
  queryUnits: 16,
  reconnaissanceReads: 4,
  fileReads: 48,
  fileReadsPerRepo: 12,
  refinementRounds: 1,
  refinementProbes: 4,
  deadlineMs: 60_000,
});

export const CompileFailureSchema = z.object({
  questionId: z.string().min(1),
  qualifier: z.string().min(1),
  reason: z.string().min(1),
  degraded: z.boolean(),
});
export type CompileFailure = z.infer<typeof CompileFailureSchema>;
