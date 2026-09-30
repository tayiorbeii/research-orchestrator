import { z } from "zod";
import { SourceObservationKindSchema } from "./researchContracts.js";

export const ResearchIntentHintSchema = z.enum(["library_usage", "implementation_behavior", "architecture_pattern", "feature_exploration"]);
export const BriefFactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dependency"), packageName: z.string().min(1), constraint: z.string().optional(), file: z.string().optional() }).strict(),
  z.object({ kind: z.literal("config"), keyPath: z.string().min(1), value: z.unknown().optional(), file: z.string().optional() }).strict(),
  z.object({ kind: z.literal("workflow"), command: z.string().min(1), file: z.string().optional() }).strict(),
  z.object({ kind: z.literal("quotation"), path: z.string().optional(), signals: z.array(z.string().min(1)).min(1), claimScope: z.enum(["advertised", "proposed", "implemented"]).optional() }).strict(),
]);
export type BriefFact = z.infer<typeof BriefFactSchema>;

export const BriefObligationSchema = z.object({
  facts: z.array(BriefFactSchema).min(1),
  combine: z.enum(["all", "any"]),
  scope: z.enum(["same_repository", "across_examples"]),
}).strict();
export const BriefQuestionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  intentHints: z.array(ResearchIntentHintSchema).min(1),
  required: z.boolean(),
  answerScope: z.string().min(1),
  obligations: z.array(BriefObligationSchema).min(1),
}).strict();

export const VocabularyTermSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  questionIds: z.array(z.string().min(1)),
  mechanismId: z.string().optional(),
  kind: z.enum(["package", "symbol", "import_path", "config_key", "cli_token", "domain_phrase", "repository_identity"]),
  origin: z.enum(["user_supplied", "local_artifact_derived", "remote_source_derived", "bundled_mapping", "planner_hypothesis"]),
  sourceRefs: z.array(z.string().min(1)).optional(),
  canonicalTerm: z.string().optional(),
  relation: z.enum(["alias", "package-for", "command-for", "config-for", "predecessor-of", "alternative-to"]).optional(),
  versions: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  ambiguityNotes: z.array(z.string()).optional(),
  proposedQualifiers: z.array(z.string()).optional(),
  egress: z.enum(["public", "restricted"]).optional(),
  status: z.enum(["proposed", "observed"]),
}).strict();
export type VocabularyTerm = z.infer<typeof VocabularyTermSchema>;

export const BriefMechanismSchema = z.object({ id: z.string().min(1), description: z.string().min(1), questionIds: z.array(z.string().min(1)) }).strict();
export const BriefSeedSchema = z.object({ repo: z.string().min(1), origin: z.enum(["user_supplied", "local_artifact_derived", "remote_source_derived", "planner_hypothesis"]) }).strict();
export const LookupOutcomeSchema = z.object({
  questionId: z.string().min(1),
  sourceRef: z.string().min(1),
  status: z.enum(["succeeded", "failed"]),
  termIdsGained: z.array(z.string().min(1)),
  detail: z.string().optional(),
}).strict();
export const LookupNeedSchema = z.object({
  questionId: z.string().min(1),
  need: z.enum(["vocabulary", "source"]),
  suggestedSourceKinds: z.array(SourceObservationKindSchema),
  remainingAllowance: z.number().int().nonnegative(),
}).strict();
export const BriefReadinessReasonSchema = z.object({
  code: z.enum(["missing_vocabulary", "ambiguous_target", "absent_evidence_scope", "source_access_unavailable", "too_many_questions"]),
  questionIds: z.array(z.string().min(1)).optional(),
  detail: z.string().min(1),
}).strict();
export const BriefReadinessSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready") }).strict(),
  z.object({ status: z.literal("needs_input"), reasons: z.array(BriefReadinessReasonSchema).min(1) }).strict(),
]);

export const BudgetLimitsSchema = z.object({
  maxQuestions: z.number().int().nonnegative(),
  queryUnits: z.number().int().nonnegative(),
  reconnaissanceReads: z.number().int().nonnegative(),
  fileReads: z.number().int().nonnegative(),
  fileReadsPerRepo: z.number().int().nonnegative(),
  refinementRounds: z.number().int().nonnegative(),
  refinementProbes: z.number().int().nonnegative(),
  deadlineMs: z.number().int().positive(),
}).strict();
export type BudgetLimits = z.infer<typeof BudgetLimitsSchema>;

/** Mirrors the Octocode bridge's current 60-second per-call timeout. */
export const DEFAULT_BRIEF_DEADLINE_MS = 60_000;

export const DEFAULT_BRIEF_BUDGETS: Readonly<BudgetLimits> = Object.freeze({
  maxQuestions: 6,
  queryUnits: 16,
  reconnaissanceReads: 4,
  fileReads: 48,
  fileReadsPerRepo: 12,
  refinementRounds: 1,
  refinementProbes: 4,
  deadlineMs: DEFAULT_BRIEF_DEADLINE_MS,
});

export const ResearchBriefSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  goal: z.string().min(1),
  questions: z.array(BriefQuestionSchema).min(1),
  languages: z.array(z.string().min(1)).optional(),
  ecosystems: z.array(z.string().min(1)).optional(),
  versions: z.array(z.string().min(1)).optional(),
  mechanisms: z.array(BriefMechanismSchema),
  vocabulary: z.array(VocabularyTermSchema),
  seeds: z.array(BriefSeedSchema),
  allowedSourceKinds: z.array(SourceObservationKindSchema).min(1),
  budgets: BudgetLimitsSchema,
  readiness: BriefReadinessSchema,
  lookupOutcomes: z.array(LookupOutcomeSchema),
  lookupNeeds: z.array(LookupNeedSchema).optional(),
  lineage: z.object({ parentId: z.string().min(1), parentRevision: z.number().int().positive(), submissionId: z.string().min(1) }).strict().optional(),
  egressPolicy: z.object({ allowRestrictedLocalTerms: z.boolean() }).strict().optional(),
}).strict();
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>;
