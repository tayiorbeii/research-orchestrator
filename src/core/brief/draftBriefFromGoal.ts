import { DEFAULT_BRIEF_BUDGETS, ResearchBriefSchema, type ResearchBrief, type VocabularyTerm } from "../../schemas/researchBrief.js";
import { extractKeyTerms } from "../knowledge.js";
import { anchoredProbeTerms, hasStructuralSignal, isDistinctiveAnchor, isDistinctiveVocabularyTerm } from "./probeTerms.js";

const TASK_WORDS = new Set([
  "find", "proven", "prove", "repository", "repositories", "implementations", "implementation", "examples", "example",
  "real-world", "real", "world", "research", "look", "search", "discover", "build", "create", "develop", "implement",
  "compare", "evaluate", "investigate", "analyze", "analysis", "guide", "task", "goal", "request", "for", "with", "and",
  "the", "a", "an", "of", "to", "in", "on", "by", "from", "via", "using", "use", "that", "which", "across",
  "prevent", "debt", "increase", "increasing", "decrease", "decreasing", "avoid", "avoidance",
  "feature", "features",
]);

/** Conservative adapter for the legacy `find --goal` input. */
export function draftBriefFromGoal(goal: string, hints?: Partial<ResearchBrief>): ResearchBrief {
  const cleanGoal = goal.trim();
  const clauses = splitSubtopics(cleanGoal);
  const extracted = extractKeyTerms(cleanGoal, 128).filter((term) => !TASK_WORDS.has(term.toLowerCase()));
  const uniqueTerms = dedupe(extracted);
  const groups = clauses.length > 1
    ? clauses.map((clause) => anchoredProbeTerms(extractKeyTerms(clause, 64).filter((term) => !TASK_WORDS.has(term.toLowerCase())))).map(dedupe).filter((group) => group.length)
    : [anchoredProbeTerms(uniqueTerms)];
  // Goal words are alternative leads for one subtopic, so each becomes its own
  // fact under an "any" obligation: one source file stating any of them answers
  // the question. Folding them into one multi-signal fact required every goal
  // word within 12 lines of one file, which no repository ever satisfied.
  const sourceQuestions = hints?.questions?.length ? hints.questions : groups.map((terms, index) => ({
    id: `q${index + 1}`,
    statement: terms.length ? `${terms.join(" ")} in the context of: ${cleanGoal}` : cleanGoal,
    intentHints: ["implementation_behavior" as const],
    required: true,
    answerScope: "One source-backed example for this subtopic.",
    obligations: [{ facts: (terms.length ? terms : [cleanGoal]).map((signal) => ({ kind: "quotation" as const, signals: [signal] })), combine: "any" as const, scope: "same_repository" as const }],
  }));

  const vocabulary: VocabularyTerm[] = hints?.vocabulary?.map((term) => ({ ...term })) ?? [];
  let factsNameAnchor = false;
  const existing = new Set(vocabulary.map((term) => `${term.text.toLowerCase()}|${term.questionIds.join(",")}`));
  for (let index = 0; index < sourceQuestions.length; index += 1) {
    const question = sourceQuestions[index]!;
    // Explicit questions are searched by what they must prove: the packages,
    // symbols, config keys, and commands named in their obligation facts.
    // Goal words are only a fallback for a question that names none; mapping
    // goal-derived groups onto explicit questions by position searched for
    // generic words ("sign-in") instead of the facts the caller supplied.
    const factTerms = hints?.questions?.length ? termsFromFacts(question) : [];
    if (factTerms.some(([text, kind]) => kind === "package" || (!TASK_WORDS.has(text.trim().toLowerCase()) && isDistinctiveAnchor(text)))) factsNameAnchor = true;
    const group: Array<[string, VocabularyTerm["kind"]]> = factTerms.length
      ? factTerms
      : (groups[index] ?? uniqueTerms).map((text) => [text, inferKind(text)]);
    for (const [text, kind] of group) {
      const key = `${text.toLowerCase()}|${question.id}`;
      if (existing.has(key)) continue;
      existing.add(key);
      vocabulary.push({ id: `v-${slug(text)}-${slug(question.id)}`, text, questionIds: [question.id], kind, origin: "user_supplied", status: "proposed" });
    }
  }

  const noVocabulary = !groups.some((group) => group.length > 0) && !factsNameAnchor && !(hints?.vocabulary?.some((term) => isDistinctiveVocabularyTerm(term) &&
    (term.egress !== "restricted" || hints?.egressPolicy?.allowRestrictedLocalTerms === true)));
  const tooMany = sourceQuestions.filter((question) => question.required).length > 6;
  const readiness: ResearchBrief["readiness"] = noVocabulary || tooMany
    ? { status: "needs_input", reasons: [
      ...(noVocabulary ? [{ code: "missing_vocabulary" as const, questionIds: sourceQuestions.map((q) => q.id), detail: "Name a package, API, symbol, configuration key, command, or distinctive project term." }] : []),
      ...(tooMany ? [{ code: "too_many_questions" as const, questionIds: sourceQuestions.filter((q) => q.required).map((q) => q.id), detail: "More than six required subtopics were found; prioritize or group them before execution." }] : []),
    ] }
    : { status: "ready" };

  const lookupNeeds = readiness.status === "needs_input"
    ? [...new Set(readiness.reasons.flatMap((reason) => reason.code === "too_many_questions" ? [] : reason.questionIds ?? sourceQuestions.map((question) => question.id)))].map((questionId) => ({
      questionId,
      need: noVocabulary ? "vocabulary" as const : "source" as const,
      suggestedSourceKinds: hints?.allowedSourceKinds?.length ? hints.allowedSourceKinds : ["documentation_page" as const],
      remainingAllowance: Math.max(0, (hints?.budgets?.reconnaissanceReads ?? DEFAULT_BRIEF_BUDGETS.reconnaissanceReads) - (hints?.lookupOutcomes?.length ?? 0)),
    }))
    : [];
  return ResearchBriefSchema.parse({
    id: hints?.id ?? `goal-${slug(cleanGoal).slice(0, 48) || "request"}`,
    revision: hints?.revision ?? 1,
    goal: cleanGoal,
    questions: sourceQuestions,
    languages: hints?.languages,
    ecosystems: hints?.ecosystems,
    versions: hints?.versions,
    mechanisms: hints?.mechanisms ?? [],
    vocabulary,
    seeds: hints?.seeds ?? [],
    allowedSourceKinds: hints?.allowedSourceKinds?.length ? hints.allowedSourceKinds : ["repository_file", "repository_metadata"],
    budgets: { ...DEFAULT_BRIEF_BUDGETS, ...(hints?.budgets ?? {}) },
    readiness,
    lookupOutcomes: hints?.lookupOutcomes ?? [],
    lookupNeeds,
    egressPolicy: hints?.egressPolicy ?? { allowRestrictedLocalTerms: false },
  });
}

function splitSubtopics(goal: string): string[] {
  const colon = goal.indexOf(":");
  if (colon < 0) return [goal];
  const tail = goal.slice(colon + 1);
  const chunks = tail.split(/,|;|\band\b/i).map((part) => part.replace(/\b(and|or)\s*$/i, "").trim()).filter(Boolean);
  // Split only an obvious list, not every ordinary compound sentence.
  return chunks.length > 1 ? chunks : [goal];
}

/** Search terms named by a question's obligation facts, with their kind. */
function termsFromFacts(question: ResearchBrief["questions"][number]): Array<[string, VocabularyTerm["kind"]]> {
  const terms: Array<[string, VocabularyTerm["kind"]]> = [];
  for (const obligation of question.obligations ?? []) {
    for (const fact of obligation.facts) {
      if (fact.kind === "dependency") terms.push([fact.packageName, "package"]);
      else if (fact.kind === "config") terms.push([fact.keyPath, "config_key"]);
      else if (fact.kind === "workflow") terms.push([fact.command, "cli_token"]);
      else if (fact.kind === "quotation") for (const signal of fact.signals) terms.push([signal, inferKind(signal)]);
    }
  }
  const seen = new Set<string>();
  const unique = terms.filter(([text]) => { const key = text.trim().toLowerCase(); if (!key || seen.has(key)) return false; seen.add(key); return true; });
  // The first term of a question is its guaranteed probe, so a structural token
  // (`HttpError`, `num_retries`) must not queue behind a plain word (`retry`).
  return [...unique.filter(([text]) => hasStructuralSignal(text)), ...unique.filter(([text]) => !hasStructuralSignal(text))];
}

function inferKind(term: string): VocabularyTerm["kind"] {
  if (term.startsWith("@") || /^[\w.-]+\/[\w./-]+$/.test(term)) return "package";
  if (term.startsWith("--")) return "cli_token";
  if (/[/.]/.test(term)) return "config_key";
  return "symbol";
}
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => { const key = value.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
