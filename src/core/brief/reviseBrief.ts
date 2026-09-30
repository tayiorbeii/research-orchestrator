import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ResearchBriefSchema, VocabularyTermSchema, LookupOutcomeSchema, type ResearchBrief, type VocabularyTerm } from "../../schemas/researchBrief.js";
import { validateBrief, type BriefIssue } from "./validateBrief.js";
import { isDistinctiveVocabularyTerm } from "./probeTerms.js";

const SubmissionSchema = z.object({
  terms: z.array(VocabularyTermSchema),
  lookupOutcomes: z.array(LookupOutcomeSchema),
  // Kept explicit so a tampered question is rejected with a stable contract code.
  questions: z.array(z.object({ id: z.string(), statement: z.string() }).strict()).optional(),
}).strict();

/** Apply host-supplied vocabulary and lookup receipts as a new immutable revision. */
export function reviseBrief(input: ResearchBrief, submission: unknown): { brief: ResearchBrief; issues: BriefIssue[] } {
  const base = ResearchBriefSchema.safeParse(input);
  if (!base.success) return validateBrief(input);
  const issues: BriefIssue[] = [];
  const parsed = SubmissionSchema.safeParse(submission);
  if (!parsed.success) {
    const changedQuestions = submission && typeof submission === "object" && "questions" in submission;
    if (changedQuestions) issues.push({ code: "original_question_changed", path: ["questions"], message: "A submission cannot replace the original question statements." });
    for (const error of parsed.error.issues) issues.push({ code: `invalid_${error.code}`, path: error.path as (string | number)[], message: error.message });
    return { brief: base.data, issues };
  }
  if (parsed.data.questions) {
    const changed = parsed.data.questions.length !== base.data.questions.length || parsed.data.questions.some((question, index) => question.id !== base.data.questions[index]?.id || question.statement !== base.data.questions[index]?.statement);
    if (changed) {
      issues.push({ code: "original_question_changed", path: ["questions"], message: "A submission cannot replace the original question statements." });
      return { brief: base.data, issues };
    }
  }
  const questionIds = new Set(base.data.questions.map((question) => question.id));
  const outcomes = parsed.data.lookupOutcomes;
  for (const [index, outcome] of outcomes.entries()) {
    if (!questionIds.has(outcome.questionId)) issues.push({ code: "unknown_question", path: ["lookupOutcomes", index, "questionId"], message: `Unknown question ${outcome.questionId}.` });
  }
  const mergedOutcomes = [...base.data.lookupOutcomes, ...outcomes];
  const existingIds = new Set(base.data.vocabulary.map((term) => term.id));
  const acceptedTerms: VocabularyTerm[] = [];
  for (const [index, term] of parsed.data.terms.entries()) {
    if (existingIds.has(term.id)) {
      issues.push({ code: "duplicate_term_id", path: ["terms", index, "id"], message: `Term id ${term.id} already exists.` });
      continue;
    }
    if (term.questionIds.some((id) => !questionIds.has(id))) {
      issues.push({ code: "unknown_question", path: ["terms", index, "questionIds"], message: "Vocabulary terms may only reference questions in the original brief." });
      continue;
    }
    const cited = (term.sourceRefs ?? []).some((ref) => mergedOutcomes.some((item) => item.status === "succeeded" && term.questionIds.includes(item.questionId) && item.sourceRef === ref));
    const linkedOutcome = mergedOutcomes.find((item) => item.status === "succeeded" && term.questionIds.includes(item.questionId) && (term.sourceRefs ?? []).includes(item.sourceRef));
    acceptedTerms.push({ ...term, origin: cited ? "remote_source_derived" : "planner_hypothesis", status: cited ? "observed" : "proposed", ...(cited ? {} : { sourceRefs: [] }), ...(linkedOutcome ? { questionIds: [...new Set(term.questionIds.filter((id) => id === linkedOutcome.questionId))] } : {}) });
  }
  let questions = [...base.data.questions];
  let mechanisms = [...base.data.mechanisms];
  const splitQuestionIds = new Set<string>();
  const submittedMechanisms = [...new Set(acceptedTerms.map((term) => term.mechanismId).filter((id): id is string => Boolean(id)))];
  const mechanismQuestionIds = new Map<string, string>();
  if (submittedMechanisms.length > 1) {
    const parent = base.data.questions.find((question) => acceptedTerms.some((term) => term.mechanismId && term.questionIds.includes(question.id)));
    if (parent) {
      splitQuestionIds.add(parent.id);
      questions = questions.map((question) => question.id === parent.id ? { ...question, required: false } : question);
      for (const mechanismId of submittedMechanisms) {
        const questionId = `q-mechanism-${slug(mechanismId)}`;
        mechanismQuestionIds.set(mechanismId, questionId);
        const description = mechanismId.replace(/[-_]+/g, " ");
        const existingMechanism = mechanisms.find((mechanism) => mechanism.id === mechanismId);
        if (!existingMechanism) mechanisms.push({ id: mechanismId, description, questionIds: [questionId] });
        else existingMechanism.questionIds = [...new Set([...existingMechanism.questionIds.filter((id) => id !== parent.id), questionId])];
        questions.push({ ...parent, id: questionId, statement: `${parent.statement} (${description})`, required: true });
      }
      acceptedTerms.forEach((term) => {
        const target = term.mechanismId ? mechanismQuestionIds.get(term.mechanismId) : undefined;
        if (target) term.questionIds = [target];
      });
    }
  }
  const vocabulary = [...base.data.vocabulary.filter((term) => !term.questionIds.some((id) => splitQuestionIds.has(id))), ...acceptedTerms];
  // Caller-supplied distinctive terms are first-priority vocabulary (§7.1) and make a
  // question searchable without reconnaissance; planner hypotheses still need a source.
  const groundsQuestion = (term: VocabularyTerm): boolean =>
    term.status === "observed" || (term.origin === "user_supplied" && isDistinctiveVocabularyTerm(term));
  const remainingRequired = questions.filter((question) => question.required && !vocabulary.some((term) => term.questionIds.includes(question.id) && groundsQuestion(term) && term.relation !== "predecessor-of" &&
    (term.egress !== "restricted" || base.data.egressPolicy?.allowRestrictedLocalTerms === true)));
  const lookupNeeds = remainingRequired.map((question) => ({
    questionId: question.id,
    need: mergedOutcomes.some((outcome) => outcome.questionId === question.id && outcome.status === "failed") ? "source" as const : "vocabulary" as const,
    suggestedSourceKinds: base.data.allowedSourceKinds,
    remainingAllowance: Math.max(0, base.data.budgets.reconnaissanceReads - mergedOutcomes.length),
  }));
  const revised = {
    ...base.data,
    revision: base.data.revision + 1,
    questions,
    mechanisms,
    vocabulary,
    lookupOutcomes: mergedOutcomes,
    lookupNeeds,
    lineage: { parentId: base.data.id, parentRevision: base.data.revision, submissionId: randomUUID() },
    readiness: remainingRequired.length === 0
      ? { status: "ready" as const }
      : { status: "needs_input" as const, reasons: remainingRequired.map((question) => ({ code: "missing_vocabulary" as const, questionIds: [question.id], detail: "Useful source-backed vocabulary is still missing for this question." })) },
  };
  for (const outcome of outcomes) {
    if (outcome.status === "succeeded" && outcome.termIdsGained.some((id) => !acceptedTerms.some((term) => term.id === id))) {
      issues.push({ code: "lookup_term_mismatch", path: ["lookupOutcomes"], message: "Successful lookup receipts may only name terms included in this submission." });
    }
  }
  const validated = validateBrief(revised);
  return { brief: validated.brief, issues: [...issues, ...validated.issues] };
}

function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mechanism"; }
