import type { BriefFact, ResearchBrief } from "../../schemas/researchBrief.js";
import type { ClaimAssessment, ClaimFactRef, SourceObservation } from "../../schemas/researchContracts.js";
import { claimAssessorRegistry, renderTargetAssertion, type ClaimSpec, type ClaimTarget } from "./types.js";

/**
 * The claim ledger: every brief fact, crossed with every repository that was
 * actually read, assessed by the assessor for the fact's kind. Claim identity
 * is the `fact` reference (question, obligation, fact index, kind) carried on
 * the assessment, never a parsed id string.
 */

export interface BriefFactEntry {
  ref: ClaimFactRef;
  fact: BriefFact;
  question: ResearchBrief["questions"][number];
}

export function briefFacts(brief: ResearchBrief): BriefFactEntry[] {
  return brief.questions.flatMap((question) => question.obligations.flatMap((obligation, obligationIndex) =>
    obligation.facts.map((fact, factIndex) => ({ ref: { questionId: question.id, obligationIndex, factIndex, kind: fact.kind }, fact, question })),
  ));
}

export function claimMethodFor(kind: BriefFact["kind"]): ClaimAssessment["method"] {
  return kind === "dependency" ? "dependency_declaration" : kind === "config" ? "config_value" : kind === "workflow" ? "workflow_command" : "exact_source_quotation";
}

/** Human-readable claim id; stable for reports, never parsed by the engine. */
export function claimIdFor(ref: ClaimFactRef, repo: string): string {
  return `claim_${ref.questionId}_${ref.obligationIndex}_${ref.factIndex}_${ref.kind}_${repo.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function sameFact(left: ClaimFactRef, right: ClaimFactRef): boolean {
  return left.questionId === right.questionId && left.obligationIndex === right.obligationIndex && left.factIndex === right.factIndex && left.kind === right.kind;
}

/** Runs persisted before assessments carried `fact` are matched by their id convention. */
export function assessmentMatchesFact(assessment: Pick<ClaimAssessment, "claimId" | "questionId" | "fact">, ref: ClaimFactRef): boolean {
  if (assessment.fact) return sameFact(assessment.fact, ref);
  return assessment.questionId === ref.questionId && assessment.claimId.startsWith(`claim_${ref.questionId}_${ref.obligationIndex}_${ref.factIndex}_${ref.kind}_`);
}

/**
 * Assess every fact against every repository with at least one observation.
 * A repository nobody read gets no claims: coverage already lists it under
 * `uninspectedCandidates`, and a wall of "not assessed" verdicts told readers
 * nothing about why.
 */
export function assessBriefClaims(brief: ResearchBrief, repos: readonly string[], observations: readonly SourceObservation[]): ClaimAssessment[] {
  const assessments: ClaimAssessment[] = [];
  const byRepo = new Map<string, SourceObservation[]>();
  for (const observation of observations) {
    if (!observation.repo) continue;
    byRepo.set(observation.repo, [...(byRepo.get(observation.repo) ?? []), observation]);
  }
  const facts = briefFacts(brief);
  for (const repo of repos) {
    const repoObservations = byRepo.get(repo);
    if (!repoObservations?.length) continue;
    const immutableRevisions = [...new Set(repoObservations.flatMap((observation) => observation.revisionStatus === "immutable" && observation.resolvedRevision ? [observation.resolvedRevision] : []))];
    const hasRepositoryFile = repoObservations.some((observation) => observation.kind === "repository_file");
    const movingRef = repoObservations.some((observation) => observation.revisionStatus === "moving_ref");
    for (const { ref, fact } of facts) {
      const target: ClaimTarget = fact;
      const revisionBound = fact.kind !== "quotation" || !fact.path?.startsWith("issues/");
      const revision = revisionBound && immutableRevisions.length === 1 ? immutableRevisions[0] : undefined;
      const claim: ClaimSpec = {
        claimId: claimIdFor(ref, repo), questionId: ref.questionId, fact: ref,
        subject: { repo, ...(revision ? { revision } : {}) }, assertion: renderTargetAssertion(target), target,
      };
      const assessor = claimAssessorRegistry[claimMethodFor(fact.kind)];
      if (!assessor) continue;
      const assessment = assessor(claim, observations);
      if (revisionBound && immutableRevisions.length === 0 && hasRepositoryFile) {
        const limitation = movingRef
          ? "The source was read from a moving branch; its revision may change between runs."
          : "The source revision is unknown, so this assessment cannot be tied to an immutable commit.";
        assessment.limitations = [...new Set([...assessment.limitations, limitation])];
      }
      assessments.push(assessment);
    }
  }
  return assessments;
}
