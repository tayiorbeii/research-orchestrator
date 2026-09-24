import { z } from "zod";
import { FeatureSpecSchema } from "./featureSpec.js";
import { SearchProbeSchema } from "./searchProbe.js";
import { CandidateRepoSchema } from "./candidateRepo.js";
import { ScoredCandidateSchema } from "./scoredCandidate.js";
import { EvidenceAnchorSchema } from "./evidenceAnchor.js";

export const ArtifactRefSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["research", "plan", "evidence", "checklist", "report"]),
  createdAt: z.string(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

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

/** Mirrors schemas/research_run.schema.json. */
export const ResearchRunSchema = z.object({
  id: z.string().min(1),
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
export type ResearchRun = z.infer<typeof ResearchRunSchema>;
