import {
  DEFAULT_BRIEF_BUDGETS,
  ResearchBriefSchema,
  type ResearchBrief,
} from "../../schemas/researchBrief.js";

export interface BriefIssue { code: string; path: (string | number)[]; message: string }

const untrustedKeys = new Set([
  "prooflevel", "proofstatus", "proof", "verified", "supportmethod", "supportstatus", "supportlabel", "support",
  "assessmentmethod", "assessmentstatus", "assessmentlabel", "claimstatus", "assessedas",
  "prooflabel", "verificationstatus", "confidence",
]);

/** Validate shape and remove caller-asserted evidence authority. */
export function validateBrief(input: unknown): { brief: ResearchBrief; issues: BriefIssue[] } {
  const issues: BriefIssue[] = [];
  const sanitized = stripCallerEvidenceLabels(input, issues);
  const parsed = ResearchBriefSchema.safeParse(sanitized);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ code: `invalid_${issue.code}`, path: issue.path as (string | number)[], message: issue.message });
    }
    return { brief: invalidBrief(input), issues };
  }

  const brief = parsed.data;
  brief.vocabulary = brief.vocabulary.map((term, index) => {
    if (term.status === "observed" && !term.sourceRefs?.length) {
      issues.push({ code: "observed_term_missing_source", path: ["vocabulary", index, "status"], message: `Term ${term.id} was downgraded because observed terms require sourceRefs.` });
      return { ...term, status: "proposed" };
    }
    return term;
  });

  for (const key of Object.keys(DEFAULT_BRIEF_BUDGETS) as Array<keyof typeof DEFAULT_BRIEF_BUDGETS>) {
    const value = brief.budgets[key];
    const defaultValue = DEFAULT_BRIEF_BUDGETS[key];
    if (value > defaultValue) {
      // A supplied value above the default is an explicit caller request.
      issues.push({ code: "budget_explicitly_raised", path: ["budgets", key], message: `${key} explicitly raises the default budget from ${defaultValue} to ${value}.` });
    }
  }

  const requiredQuestions = brief.questions.filter((question) => question.required);
  if (!brief.lookupNeeds) {
    const missing = brief.readiness.status === "needs_input" ? brief.readiness.reasons.flatMap((reason) => reason.code === "too_many_questions" ? [] : (reason.questionIds ?? brief.questions.map((question) => question.id)).map((questionId) => ({ questionId, code: reason.code }))) : [];
    brief.lookupNeeds = [...new Map(missing.map(({ questionId, code }) => [questionId, {
      questionId,
      need: ["source_access_unavailable", "absent_evidence_scope", "ambiguous_target"].includes(code) ? "source" as const : "vocabulary" as const,
      suggestedSourceKinds: brief.allowedSourceKinds,
      remainingAllowance: Math.max(0, brief.budgets.reconnaissanceReads - brief.lookupOutcomes.length),
    }])).values()];
  }
  if (requiredQuestions.length > 6) {
    brief.readiness = {
      status: "needs_input",
      reasons: [{ code: "too_many_questions", questionIds: requiredQuestions.map((question) => question.id), detail: `${requiredQuestions.length} required questions exceed the supported limit of 6; no questions were dropped.` }],
    };
    issues.push({ code: "too_many_questions", path: ["questions"], message: "More than six required questions need caller prioritization or a smaller decomposition." });
  }

  return { brief, issues };
}

function stripCallerEvidenceLabels(value: unknown, issues: BriefIssue[], path: (string | number)[] = []): unknown {
  if (Array.isArray(value)) return value.map((entry, index) => stripCallerEvidenceLabels(entry, issues, [...path, index]));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (untrustedKeys.has(key.toLowerCase())) {
      issues.push({ code: "caller_evidence_label_removed", path: [...path, key], message: `Caller-supplied ${key} is not authoritative and was removed.` });
      continue;
    }
    result[key] = stripCallerEvidenceLabels(entry, issues, [...path, key]);
  }
  return result;
}

function invalidBrief(input: unknown): ResearchBrief {
  const object = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const goal = typeof object.goal === "string" && object.goal.trim() ? object.goal.trim() : "Unvalidated research request";
  return {
    id: typeof object.id === "string" && object.id ? object.id : "invalid-brief",
    revision: 1,
    goal,
    questions: [{ id: "q1", statement: goal, intentHints: ["implementation_behavior"], required: true, answerScope: "One source-backed example.", obligations: [{ facts: [{ kind: "quotation", signals: ["source evidence"] }], combine: "all", scope: "same_repository" }] }],
    mechanisms: [], vocabulary: [], seeds: [], allowedSourceKinds: ["repository_file"],
    budgets: { ...DEFAULT_BRIEF_BUDGETS },
    readiness: { status: "needs_input", reasons: [{ code: "missing_vocabulary", questionIds: ["q1"], detail: "The brief shape is invalid and needs correction before execution." }] },
    lookupOutcomes: [],
  };
}
