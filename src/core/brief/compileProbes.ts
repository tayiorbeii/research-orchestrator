import type { ProviderSearchCapabilities, SearchQualifier } from "../../adapters/EvidenceProvider.js";
import type { ResearchBrief, VocabularyTerm } from "../../schemas/researchBrief.js";
import type { BudgetLedger, CompileFailure, SearchProbeV2 } from "../../schemas/searchProbeV2.js";
import { dedupeProbeTokens, isDistinctiveVocabularyTerm } from "./probeTerms.js";

type Candidate = { question: ResearchBrief["questions"][number]; term: VocabularyTerm; queryText?: string; queryTermIds?: string[]; qualifier?: string; qualifierName?: SearchQualifier; issueSearch?: boolean };

/** Compile brief intent to supported provider syntax while preserving scope. */
export function compileProbes(
  brief: ResearchBrief,
  capabilities: ProviderSearchCapabilities,
  ledger: BudgetLedger,
  options: { allowDegraded?: boolean } = {},
): { probes: SearchProbeV2[]; failures: CompileFailure[]; ledger: BudgetLedger } {
  const updatedLedger: BudgetLedger = structuredClone(ledger);
  const probes: SearchProbeV2[] = [];
  const failures: CompileFailure[] = [];
  const remaining = Math.max(0, updatedLedger.limits.queryUnits - updatedLedger.consumed.queryUnits - (updatedLedger.reserved?.queryUnits ?? 0));
  const candidates = brief.questions.flatMap((question) => {
    const eligible = brief.vocabulary.filter((term) => term.questionIds.includes(question.id) &&
      isDistinctiveVocabularyTerm(term) && term.relation !== "predecessor-of" &&
      !(term.egress === "restricted" && !brief.egressPolicy?.allowRestrictedLocalTerms));
    const hasAnchorOtherThanFactPath = eligible.some((term) => !isFactPathTerm(term, question));
    const terms = eligible.filter((term) => !hasAnchorOtherThanFactPath || !isFactPathTerm(term, question))
      .sort((left, right) => Number(isFactPathTerm(left, question)) - Number(isFactPathTerm(right, question)));
    const questionCandidates = terms.map((term) => candidateFor(question, term, brief));
    if (isProposedQuestion(question)) return questionCandidates.slice(0, 1).map((candidate) => ({ ...candidate, issueSearch: true }));
    if (brief.allowedSourceKinds.includes("issue_proposal") && questionCandidates.length > 0) {
      return [...questionCandidates, { ...questionCandidates[0]!, issueSearch: true }];
    }
    return questionCandidates;
  });
  const required = brief.questions.flatMap((question) => {
    if (!question.required) return [];
    const first = candidates.find((candidate) => candidate.question.id === question.id);
    return first ? [first] : [];
  });
  const scheduled = new Set<string>();
  let available = remaining;

  for (const question of brief.questions.filter((item) => item.required && !candidates.some((candidate) => candidate.question.id === item.id))) {
    failures.push({ questionId: question.id, qualifier: "vocabulary", reason: "not_attempted: this required question has no associated search vocabulary", degraded: false });
  }

  for (const candidate of required) {
    const key = `${candidate.question.id}|${candidate.term.id}|${candidate.issueSearch ? "issue" : "source"}`;
    scheduled.add(key);
    if (available <= 0) {
      failures.push({ questionId: candidate.question.id, qualifier: "query_budget", reason: "not_attempted: initial probe reserved for this required question but no query units remain", degraded: false });
      continue;
    }
    const initial = initialCandidate(candidate, brief);
    const outcome = compileOne(initial, brief, capabilities, options.allowDegraded === true, probes.length);
    if (outcome.failure) failures.push(outcome.failure);
    if (outcome.probe) {
      probes.push(outcome.probe);
      available -= 1;
      updatedLedger.reserved = { queryUnits: (updatedLedger.reserved?.queryUnits ?? 0) + 1 };
    }
  }

  for (const candidate of candidates) {
    const key = `${candidate.question.id}|${candidate.term.id}|${candidate.issueSearch ? "issue" : "source"}`;
    if (scheduled.has(key)) continue;
    scheduled.add(key);
    if (available <= 0) {
      failures.push({ questionId: candidate.question.id, qualifier: "query_budget", reason: "not_attempted: query budget exhausted before this additional anchor", degraded: false });
      continue;
    }
    const outcome = compileOne(candidate, brief, capabilities, options.allowDegraded === true, probes.length);
    if (outcome.failure) failures.push(outcome.failure);
    if (outcome.probe) {
      probes.push(outcome.probe);
      available -= 1;
      updatedLedger.reserved = { queryUnits: (updatedLedger.reserved?.queryUnits ?? 0) + 1 };
    }
  }

  // Retain one explicitly broader alternative when the bounded query budget
  // leaves room after the path-scoped probes.
  const broadCandidate = required.find((candidate) => candidate.qualifier && candidate.qualifierName && candidate.qualifierName !== "language" &&
    capabilities.supportedQualifiers.codeSearch.includes(candidate.qualifierName) &&
    probes.some((probe) => probe.questionIds.includes(candidate.question.id) && probe.providerQuery.includes(candidate.qualifier!)));
  if (broadCandidate && available > 0) {
    const broad = compileOne({ ...broadCandidate, qualifier: undefined, qualifierName: undefined }, brief, capabilities, options.allowDegraded === true, probes.length);
    if (broad.failure) failures.push(broad.failure);
    if (broad.probe) {
      broad.probe.rationale = `One broader unqualified alternative for question ${broadCandidate.question.id}; the scoped probe remains primary.`;
      probes.push(broad.probe);
      available -= 1;
      updatedLedger.reserved = { queryUnits: (updatedLedger.reserved?.queryUnits ?? 0) + 1 };
    }
  }

  return { probes, failures, ledger: updatedLedger };
}

function candidateFor(question: ResearchBrief["questions"][number], term: VocabularyTerm, brief: ResearchBrief): Candidate {
  const qualifier = obligationPathQualifier(question) ?? term.proposedQualifiers?.[0];
  const language = !qualifier && brief.languages?.[0] ? `language:${brief.languages[0]}` : undefined;
  const value = qualifier ?? language;
  const parsed = value?.match(/^([a-z]+):(.*)$/i);
  return { question, term, qualifier: value, qualifierName: parsed?.[1]?.toLowerCase() as SearchQualifier | undefined };
}

function obligationPathQualifier(question: ResearchBrief["questions"][number]): string | undefined {
  const facts = question.obligations.flatMap((obligation) => obligation.facts);
  if (facts.some((fact) => fact.kind === "workflow")) return "path:.github/workflows";
  const paths = facts.flatMap((fact) => {
    if (fact.kind === "quotation") return fact.path ? [fact.path] : [];
    if ("file" in fact && fact.file) return [fact.file];
    return [];
  });
  const path = paths.find(Boolean);
  if (!path) return undefined;
  return path.includes("/") ? `path:${path}` : `filename:${path}`;
}

function isFactPathTerm(term: VocabularyTerm, question: ResearchBrief["questions"][number]): boolean {
  const factPaths = question.obligations.flatMap((obligation) => obligation.facts.flatMap((fact) => {
    if (fact.kind === "quotation") return fact.path ? [fact.path] : [];
    return "file" in fact && fact.file ? [fact.file] : [];
  }));
  return factPaths.includes(term.text);
}

function initialCandidate(candidate: Candidate, brief: ResearchBrief): Candidate {
  const anchors = brief.vocabulary.filter((term) => term.questionIds.includes(candidate.question.id) && term.relation !== "predecessor-of" &&
    !(term.egress === "restricted" && !brief.egressPolicy?.allowRestrictedLocalTerms)).slice(0, 3);
  const qualifierTerm = anchors.find((term) => term.proposedQualifiers?.length) ?? anchors[0];
  const qualifier = obligationPathQualifier(candidate.question) ?? qualifierTerm?.proposedQualifiers?.[0] ?? (brief.languages?.[0] ? `language:${brief.languages[0]}` : undefined);
  const qualifierName = qualifier?.match(/^([a-z]+):/i)?.[1]?.toLowerCase() as SearchQualifier | undefined;
  return {
    ...candidate,
    queryText: dedupeProbeTokens(candidate.term.text),
    queryTermIds: [candidate.term.id],
    qualifier,
    qualifierName,
  };
}

function compileOne(candidate: Candidate, brief: ResearchBrief, capabilities: ProviderSearchCapabilities, allowDegraded: boolean, index: number): { probe?: SearchProbeV2; failure?: CompileFailure } {
  const { question, term } = candidate;
  const endpoint = candidate.issueSearch || isProposedQuestion(question) ? "issueSearch" : term.kind === "repository_identity" ? "repoSearch" : "codeSearch";
  if (endpoint === "issueSearch" && !capabilities.issues) {
    return { failure: { questionId: question.id, qualifier: "source_access_unavailable", reason: `Provider ${capabilities.capabilityVersion} cannot search issues; no absence claim was made.`, degraded: false } };
  }
  if (endpoint !== "issueSearch" && !capabilities[endpoint]) return { failure: { questionId: question.id, qualifier: endpoint, reason: `Provider capability ${capabilities.capabilityVersion} does not support ${endpoint}.`, degraded: false } };

  const supported = endpoint === "issueSearch" ? [] : capabilities.supportedQualifiers[endpoint];
  let actualQualifier = endpoint === "issueSearch" ? undefined : candidate.qualifier;
  let dropped: string | undefined;
  if (actualQualifier && (!candidate.qualifierName || !supported.includes(candidate.qualifierName))) {
    if (!allowDegraded) return { failure: { questionId: question.id, qualifier: actualQualifier, reason: `Provider ${capabilities.capabilityVersion} does not support qualifier ${actualQualifier}; intended scope was preserved without issuing a broader query.`, degraded: false } };
    dropped = actualQualifier;
    actualQualifier = undefined;
  }

  const proposedSignals = endpoint === "issueSearch"
    ? question.obligations.flatMap((obligation) => obligation.facts.flatMap((fact) => fact.kind === "quotation" ? fact.signals : []))
    : [];
  const queryText = dedupeProbeTokens(proposedSignals.join(" ") || candidate.queryText || term.text);
  const query = [queryText, actualQualifier].filter(Boolean).join(" ");
  const providerArgs: Record<string, unknown> = { endpoint, query };
  if (actualQualifier && candidate.qualifierName) providerArgs[candidate.qualifierName] = actualQualifier.slice(actualQualifier.indexOf(":") + 1);
  const factPaths = question.obligations.flatMap((obligation) => obligation.facts.flatMap((fact) => "path" in fact && fact.path ? [fact.path] : []));
  const questionMechanisms = term.mechanismId
    ? [term.mechanismId]
    : brief.mechanisms.filter((mechanism) => mechanism.questionIds.includes(question.id)).map((mechanism) => mechanism.id);
  const probe: SearchProbeV2 = {
    id: `p-${slug(question.id)}-${slug(term.id)}-${index + 1}`,
    questionIds: [question.id],
    mechanismIds: questionMechanisms,
    termIds: candidate.queryTermIds ?? [term.id],
    purpose: "discovery",
    intent: question.statement,
    providerQuery: query,
    providerArgs,
    expectedSourceKinds: brief.allowedSourceKinds,
    expectedPaths: [...new Set(factPaths)],
    capabilityVersion: capabilities.capabilityVersion,
    rationale: dropped
      ? `Degraded from intended qualifier ${dropped}; actual query omits that scope. Intended scope: ${candidate.qualifier}. Actual scope: ${term.text}.`
      : `Search for question-scoped anchor ${queryText}${term.relation === "alternative-to" ? " as an alternative mechanism" : ""} for question ${question.id}.`,
    alternativesLeftOpen: dropped ? [`The intended qualifier ${dropped} remains unresolved.`] : [],
    predecessorProbeIds: [],
  };
  return { probe, ...(dropped ? { failure: { questionId: question.id, qualifier: dropped, reason: `Degraded query explicitly omits unsupported scope; intended scope ${dropped}, actual scope ${term.text}.`, degraded: true } } : {}) };
}

function isProposedQuestion(question: ResearchBrief["questions"][number]): boolean {
  return question.obligations.some((obligation) => obligation.facts.some((fact) => fact.kind === "quotation" && fact.claimScope === "proposed"));
}

function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "term"; }
