import type { ResearchRunV2 } from "../schemas/index.js";
import type { EvidenceProvider } from "../adapters/EvidenceProvider.js";
import type { ResearchBrief } from "../schemas/researchBrief.js";
import { draftBriefFromGoal } from "./brief/draftBriefFromGoal.js";
import { validateBrief } from "./brief/validateBrief.js";
import { executeBrief } from "./brief/executeBrief.js";

export interface RunPipelineOptions {
  goal: string;
  provider: EvidenceProvider;
  hints?: Partial<ResearchBrief>;
  maxCandidates?: number;
  maxReposToProve?: number;
  /** Fixed id/createdAt for reproducible mock runs. */
  deterministic?: boolean;
  now?: () => Date;
  resolveBudgets?: (brief: ResearchBrief) => ResearchBrief;
}

/**
 * The goal adapter used by CLI and MCP goal inputs: a goal sentence is drafted
 * into a brief, validated, and executed exactly like a caller-written brief.
 * There is one execution path; a goal is only a weaker way to write a brief.
 */
export async function runPipeline(options: RunPipelineOptions): Promise<ResearchRunV2> {
  const draft = draftBriefFromGoal(options.goal, options.hints);
  const validated = validateBrief(draft);
  const brief = options.resolveBudgets ? options.resolveBudgets(validated.brief) : validated.brief;
  return executeBrief(brief, { provider: options.provider, now: options.now, deterministic: options.deterministic, maxCandidates: options.maxCandidates, maxReposToProve: options.maxReposToProve });
}

/** Evidence anchors a run collected, as the CLI and artifact writer project them. */
export function runAnchors(run: Pick<ResearchRunV2, "candidates">) {
  return run.candidates.flatMap((candidate) => candidate.candidateSignals.flatMap((signal) => signal.evidence ?? []));
}
