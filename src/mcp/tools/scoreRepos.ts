import { z } from "zod";
import {
  CandidateRepoSchema,
  EvidenceAnchorSchema,
  FeatureSpecSchema,
} from "../../schemas/index.js";
import { scoreCandidate } from "../../core/scoreCandidate.js";

export const scoreReposInputShape = {
  featureSpec: FeatureSpecSchema.describe("Feature spec produced by research.findImplementations."),
  candidates: z.array(CandidateRepoSchema),
  evidence: z
    .array(EvidenceAnchorSchema)
    .optional()
    .describe("Exact evidence anchors already collected for these candidates."),
  evidencePolicy: z.enum(["metadata", "file_slices", "deep_proof"]).optional(),
};

const InputSchema = z.object(scoreReposInputShape);
export type ScoreReposInput = z.infer<typeof InputSchema>;

/** research.scoreRepos — score existing candidates against a feature spec. */
export async function scoreRepos(input: ScoreReposInput) {
  const parsed = InputSchema.parse(input);
  const evidence = parsed.evidence ?? [];

  const scoredCandidates = parsed.candidates.map((candidate) =>
    scoreCandidate(
      parsed.featureSpec,
      candidate,
      evidence.filter((a) => !a.repo || a.repo === candidate.repo),
    ),
  );

  const accepted = scoredCandidates.filter((s) => s.nextAction === "extract").length;
  const rejected = scoredCandidates.filter((s) => s.nextAction === "reject").length;

  return {
    scoredCandidates,
    summary: {
      accepted,
      rejected,
      needsMoreEvidence: scoredCandidates.length - accepted - rejected,
    },
  };
}
