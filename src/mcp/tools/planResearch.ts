import { z } from "zod";
import { draftBriefFromGoal } from "../../core/brief/draftBriefFromGoal.js";
import { validateBrief } from "../../core/brief/validateBrief.js";
import { ResearchBriefSchema } from "../../schemas/researchBrief.js";
import type { ResearchBrief } from "../../schemas/researchBrief.js";
import type { BriefIssue } from "../../core/brief/validateBrief.js";
import { reviseBrief } from "../../core/brief/reviseBrief.js";
import { addLocalArtifactFingerprints } from "../../core/brief/localArtifacts.js";

export const planResearchInputShape = {
  goal: z.string().min(1).optional(),
  brief: ResearchBriefSchema.optional(),
  request: z.record(z.unknown()).optional().describe("Optional question, vocabulary, seed, and source-policy hints."),
  submission: z.object({
    terms: z.array(z.unknown()),
    lookupOutcomes: z.array(z.unknown()),
    questions: z.array(z.object({ id: z.string(), statement: z.string() }).strict()).optional(),
  }).strict().optional().describe("Host lookup results to apply as a new brief revision."),
};
const InputSchema = z.object(planResearchInputShape).refine((input) => Boolean(input.brief) !== Boolean(input.goal), "Provide exactly one of goal or brief.").refine((input) => !input.submission || Boolean(input.brief), "submission requires brief.");
export type PlanResearchInput = z.infer<typeof InputSchema>;

/** research.planResearch — return a draft or validated brief without executing provider research. */
export async function planResearch(input: PlanResearchInput, deps: {
  draftBriefFromGoal?: typeof draftBriefFromGoal;
  validateBrief?: typeof validateBrief;
} = {}) {
  const parsed = InputSchema.parse(input);
  if (parsed.brief && parsed.submission) {
    const result = reviseBrief(parsed.brief, parsed.submission);
    return { brief: result.brief, readiness: result.brief.readiness, needs: result.brief.lookupNeeds ?? [], issues: result.issues, researchPerformed: false };
  }
  let request = parsed.request ?? {};
  if (parsed.goal) request = await addLocalArtifactFingerprints(request);
  const draft: ResearchBrief = parsed.brief ?? (deps.draftBriefFromGoal ?? draftBriefFromGoal)(parsed.goal!, request as Partial<ResearchBrief>);
  const validation: { brief: ResearchBrief; issues: BriefIssue[] } = (deps.validateBrief ?? validateBrief)(draft);
  return {
    brief: validation.brief,
    readiness: validation.brief.readiness,
    needs: validation.brief.readiness.status === "needs_input" ? validation.brief.readiness.reasons : [],
    issues: validation.issues,
    researchPerformed: false,
  };
}
