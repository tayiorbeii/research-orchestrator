import type { EvidenceAnchor, ResearchRun } from "../../schemas/index.js";
import type { ResearchBrief } from "../../schemas/researchBrief.js";
import type { ClaimAssessment, SourceObservation } from "../../schemas/researchContracts.js";
import { factLabel } from "../assessment/briefCoverage.js";
import { assessmentMatchesFact, briefFacts } from "../assessment/claimLedger.js";

/**
 * The report model for a brief-driven run: what a reader needs, derived once
 * from the run and rendered by every artifact. Claims, observations and probe
 * outcomes stay in evidence.json; this view answers "what was found, where,
 * what is still open, and what to read next" per question.
 */

export interface SupportedFinding {
  fact: string;
  repo: string;
  path: string;
  line?: number;
  matchText?: string;
  url?: string;
  revision?: string;
  observationId: string;
}

export interface Lead {
  fact: string;
  repo: string;
  path: string;
  why: string;
}

export interface QuestionReport {
  id: string;
  statement: string;
  required: boolean;
  status: "satisfied" | "partial" | "unresolved" | "not_attempted";
  supported: SupportedFinding[];
  leads: Lead[];
  unsatisfied: string[];
  nextReads: string[];
}

export interface CandidateRow {
  repo: string;
  url?: string;
  filesRead: number;
  unavailable: number;
  supported: number;
  state: string;
}

export interface SearchRow {
  questions: string;
  query: string;
  endpoint: string;
  outcome: string;
  results: number;
}

export interface BriefReport {
  runId: string;
  goal: string;
  status: string;
  reasons: string[];
  synthetic: boolean;
  needsInput?: { reasons: string[]; lookups: string[] };
  questions: QuestionReport[];
  candidates: CandidateRow[];
  searched: SearchRow[];
  budget?: { queries: [number, number]; reads: [number, number]; rpc: number; metadataCalls: number; elapsedMs?: number; cancelled: boolean };
  warnings: { total: number; byKind: Array<[string, number]>; sample: string[] };
}

const MAX_LEADS = 8;
const MAX_NEXT_READS = 6;
const MAX_WARNING_SAMPLE = 15;

type BriefRun = ResearchRun & { brief: ResearchBrief };

export function isBriefRun(run: ResearchRun): run is BriefRun {
  return run.schemaVersion === 2 && run.brief !== undefined;
}

export function deriveBriefReport(run: BriefRun, evidence: readonly EvidenceAnchor[], status: { status: string; reasons: string[] }): BriefReport {
  const brief = run.brief;
  const observations = run.observations ?? [];
  const assessments = run.assessments ?? [];
  const coverage = run.coverage ?? [];
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const observed = new Set(observations.map((observation) => `${observation.repo}:${observation.path}`));
  const candidateRepos = new Set(run.candidates.map((candidate) => candidate.repo));
  const probes = run.probesV2 ?? run.compiledProbes ?? [];
  const outcomes = run.probeOutcomes ?? [];
  const facts = briefFacts(brief);

  const questions = brief.questions.map((question): QuestionReport => {
    const questionFacts = facts.filter((entry) => entry.ref.questionId === question.id);
    const questionCoverage = coverage.find((item) => item.questionId === question.id);
    const supported: SupportedFinding[] = [];
    const leads: Lead[] = [];
    for (const { ref, fact } of questionFacts) {
      const label = factLabel(fact);
      for (const assessment of assessments.filter((item) => assessmentMatchesFact(item, ref))) {
        if (assessment.status === "supported" && assessment.assessorOrigin === "engine") {
          const observation = assessment.requiredObservationIds.map((id) => byId.get(id)).find(Boolean);
          if (observation) supported.push(finding(label, observation, evidence, assessment));
          continue;
        }
        if (leads.length >= MAX_LEADS) continue;
        if (assessment.status === "partial") {
          const observation = assessment.requiredObservationIds.map((id) => byId.get(id)).find(Boolean);
          if (observation?.path) leads.push({ fact: label, repo: assessment.subject.repo, path: observation.path, why: assessment.rationale });
          continue;
        }
        if (fact.kind !== "quotation") continue;
        // A file that states every signal but could not count (documentation,
        // changelog, wrong scope) is the lead a reader should open next.
        for (const observation of observations) {
          if (observation.repo !== assessment.subject.repo || !observation.path || !observation.excerpt) continue;
          if (!fact.signals.every((signal) => observation.excerpt!.includes(signal))) continue;
          if (leads.some((lead) => lead.repo === observation.repo && lead.path === observation.path && lead.fact === label)) continue;
          leads.push({ fact: label, repo: observation.repo, path: observation.path, why: `states the signals, but not in a source file this fact can count (${fact.claimScope ?? "unscoped"} scope)` });
          if (leads.length >= MAX_LEADS) break;
        }
      }
    }
    const linkedProbes = new Set(probes.filter((probe) => probe.questionIds.includes(question.id)).map((probe) => probe.id));
    const unread: string[] = [];
    for (const outcome of outcomes) {
      if (!linkedProbes.has(outcome.probeId)) continue;
      for (const id of outcome.resultIds) if (!observed.has(id) && !unread.includes(id)) unread.push(id);
    }
    const nextReads = [...unread.filter((id) => candidateRepos.has(id.split(":")[0]!)), ...unread.filter((id) => !candidateRepos.has(id.split(":")[0]!))].slice(0, MAX_NEXT_READS);
    return {
      id: question.id,
      statement: question.statement,
      required: question.required,
      status: questionCoverage?.status ?? "not_attempted",
      supported: dedupeFindings(supported),
      leads,
      unsatisfied: questionCoverage?.status === "satisfied" ? [] : questionCoverage?.unsatisfiedObligations ?? questionFacts.map((entry) => factLabel(entry.fact)),
      nextReads: questionCoverage?.status === "satisfied" ? [] : nextReads,
    };
  });

  const candidates = run.candidates.map((candidate): CandidateRow => {
    const repoObservations = observations.filter((observation) => observation.repo === candidate.repo);
    return {
      repo: candidate.repo,
      url: candidate.url,
      filesRead: repoObservations.filter((observation) => observation.readStatus === "complete" || observation.readStatus === "partial").length,
      unavailable: repoObservations.filter((observation) => observation.readStatus === "unavailable" || observation.readStatus === "failed").length,
      supported: assessments.filter((assessment) => assessment.subject.repo === candidate.repo && assessment.status === "supported" && assessment.assessorOrigin === "engine").length,
      state: run.candidateStates?.find((state) => state.repo === candidate.repo)?.state ?? "uninspected",
    };
  }).sort((left, right) => right.supported - left.supported || right.filesRead - left.filesRead);

  const searched = probes.map((probe): SearchRow => {
    const outcome = outcomes.find((item) => item.probeId === probe.id);
    return {
      questions: probe.questionIds.map((id) => brief.questions.find((question) => question.id === id)?.statement ?? id).join("; "),
      query: probe.providerQuery,
      endpoint: typeof probe.providerArgs.endpoint === "string" ? probe.providerArgs.endpoint : "unknown",
      outcome: outcome ? `${outcome.status}${outcome.resultClass ? ` (${outcome.resultClass})` : ""}` : "not attempted",
      results: outcome?.resultIds.length ?? 0,
    };
  });

  const ledger = run.budgetLedger;
  const kinds = new Map<string, number>();
  for (const warning of run.warnings) {
    const kind = warning.split(":")[0]!.replace(/\s+\S+\s+failed$/, " failed").slice(0, 40);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }

  return {
    runId: run.id,
    goal: run.goal,
    status: status.status,
    reasons: status.reasons,
    synthetic: run.evidenceOrigin === "synthetic_mock" || run.providerName === "mock",
    ...(brief.readiness.status === "needs_input" ? { needsInput: {
      reasons: brief.readiness.reasons.map((reason) => `${reason.code}${reason.questionIds?.length ? ` (${reason.questionIds.join(", ")})` : ""}: ${reason.detail}`),
      lookups: (brief.lookupNeeds ?? []).map((need) => `${need.questionId}: ${need.need} via ${need.suggestedSourceKinds.join(", ")} (${need.remainingAllowance} lookup(s) left)`),
    } } : {}),
    questions,
    candidates,
    searched,
    ...(ledger ? { budget: {
      queries: [ledger.consumed.queryUnits, ledger.limits.queryUnits],
      reads: [ledger.consumed.fileReads, ledger.limits.fileReads],
      rpc: ledger.consumed.rpcCount,
      metadataCalls: ledger.consumed.unbudgetedMetadataCalls ?? 0,
      ...(ledger.elapsedMs !== undefined ? { elapsedMs: ledger.elapsedMs } : {}),
      cancelled: ledger.cancelled,
    } } : {}),
    warnings: { total: run.warnings.length, byKind: [...kinds.entries()].sort((left, right) => right[1] - left[1]), sample: run.warnings.slice(0, MAX_WARNING_SAMPLE) },
  };
}

function finding(fact: string, observation: SourceObservation, evidence: readonly EvidenceAnchor[], assessment: ClaimAssessment): SupportedFinding {
  const anchor = observation.anchor ?? evidence.find((item) => item.repo === observation.repo && item.path === observation.path);
  return {
    fact,
    repo: observation.repo ?? assessment.subject.repo,
    path: observation.path ?? "",
    ...(anchor?.startLine !== undefined ? { line: anchor.startLine } : {}),
    ...(anchor?.matchText ? { matchText: anchor.matchText } : {}),
    ...(anchor?.url ? { url: anchor.url } : {}),
    ...(observation.resolvedRevision ? { revision: observation.resolvedRevision } : {}),
    observationId: observation.id,
  };
}

function dedupeFindings(findings: SupportedFinding[]): SupportedFinding[] {
  const seen = new Set<string>();
  return findings.filter((item) => {
    const key = `${item.fact}|${item.repo}|${item.path}|${item.line ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (value: string) => `\`${value.replace(/`/g, "'")}\``;

function statusBanner(report: BriefReport): string {
  if (report.status === "complete") return "";
  if (report.status === "needs_input") {
    return "> ⚠ **This run needs input before it can search.** The brief is missing vocabulary or scope; answer the items under *Needs input* and re-plan.\n\n";
  }
  return `> ⚠ **This run is ${report.status.toUpperCase()}.** Only the findings listed as *supported* are source-backed; everything else is a lead or a gap. Do not present this as completed research.\n\n`;
}

function findingLine(item: SupportedFinding): string {
  const where = `${code(item.path)}${item.line ? `:${item.line}` : ""}`;
  const link = item.url ? ` ([link](${item.url}))` : "";
  const text = item.matchText ? ` — ${code(item.matchText)}` : "";
  const revision = item.revision ? ` _(pinned ${item.revision.slice(0, 7)})_` : " _(moving ref)_";
  return `- **${item.repo}** ${where}${text}${link} — ${item.fact}${revision}`;
}

function questionSection(question: QuestionReport): string {
  const lines = [`### ${question.id} — ${question.statement}`, "", `- Status: **${question.status}**${question.required ? " (required)" : " (optional)"}`];
  if (question.supported.length) lines.push("- Supported:", ...question.supported.map((item) => `  ${findingLine(item)}`));
  if (question.leads.length) lines.push("- Leads (not proof):", ...question.leads.map((lead) => `  - ${lead.repo} ${code(lead.path)} — ${lead.fact}: ${lead.why}`));
  if (question.unsatisfied.length) lines.push(`- Unsatisfied facts: ${question.unsatisfied.join("; ")}`);
  if (question.nextReads.length) lines.push("- Next reads (unopened search hits):", ...question.nextReads.map((id) => `  - ${code(id)}`));
  if (!question.supported.length && !question.leads.length && question.status === "not_attempted") lines.push("- Nothing was searched or read for this question.");
  return lines.join("\n");
}

function budgetSection(report: BriefReport): string {
  if (!report.budget) return "";
  const { queries, reads, rpc, metadataCalls, elapsedMs, cancelled } = report.budget;
  const elapsed = elapsedMs !== undefined ? `; elapsed ${Math.round(elapsedMs / 1000)}s` : "";
  return `## Budget receipt\n\n- Searches ${queries[0]}/${queries[1]}; file reads ${reads[0]}/${reads[1]}; RPC calls ${rpc}; unbudgeted metadata calls ${metadataCalls}${elapsed}${cancelled ? "; **deadline reached**" : ""}.\n`;
}

function searchedSection(report: BriefReport): string {
  const rows = report.searched.map((row) => `| ${cell(row.questions)} | ${code(cell(row.query))} | ${row.endpoint} | ${row.outcome} | ${row.results} |`);
  return `## What was searched\n\n| Question | Compiled query | Endpoint | Outcome | Results |\n|---|---|---|---|---:|\n${rows.join("\n") || "| _none_ | - | - | not attempted | 0 |"}\n`;
}

function candidatesSection(report: BriefReport): string {
  const rows = report.candidates.filter((row) => row.filesRead || row.unavailable || row.supported).map((row) => `| ${row.url ? `[${row.repo}](${row.url})` : row.repo} | ${row.filesRead} | ${row.unavailable} | ${row.supported} | ${row.state} |`);
  const unread = report.candidates.length - rows.length;
  return `## Candidates\n\n| Repository | Files read | Unavailable | Supported claims | State |\n|---|---:|---:|---:|---|\n${rows.join("\n") || "| _none read_ | 0 | 0 | 0 | - |"}\n${unread > 0 ? `\n${unread} further candidate(s) were discovered but not read.\n` : ""}`;
}

function diagnosticsSection(report: BriefReport): string {
  if (report.warnings.total === 0) return "## Diagnostics\n\n- none\n";
  const kinds = report.warnings.byKind.map(([kind, count]) => `${kind} (${count})`).join(", ");
  const more = report.warnings.total > report.warnings.sample.length ? `\n- … ${report.warnings.total - report.warnings.sample.length} more in evidence.json` : "";
  return `## Diagnostics\n\n${report.warnings.total} warning(s): ${kinds}.\n\n${report.warnings.sample.map((warning) => `- ${warning}`).join("\n")}${more}\n`;
}

function needsInputSection(report: BriefReport): string {
  if (!report.needsInput) return "";
  return `## Needs input\n\n${report.needsInput.reasons.map((reason) => `- ${reason}`).join("\n")}\n${report.needsInput.lookups.length ? `\nSuggested lookups:\n\n${report.needsInput.lookups.map((lookup) => `- ${lookup}`).join("\n")}\n` : ""}`;
}

export function renderBriefResearchMd(report: BriefReport): string {
  const satisfied = report.questions.filter((question) => question.status === "satisfied").length;
  const supportedCount = report.questions.reduce((sum, question) => sum + question.supported.length, 0);
  const read = report.candidates.filter((row) => row.filesRead > 0).length;
  const reasons = report.reasons.length ? ` (${report.reasons.join(", ")})` : "";
  return `# Research: ${report.goal}

${statusBanner(report)}## Goal

${report.goal}

## Status

- **${report.status}**${reasons}
- Questions satisfied: ${satisfied}/${report.questions.length}; supported findings: ${supportedCount}
- Candidates discovered: ${report.candidates.length}; read: ${read}

## Summary

Run ${code(report.runId)} ${supportedCount ? `found ${supportedCount} source-backed finding(s) across ${satisfied} satisfied question(s)` : "established no supported finding"}. A supported finding means only that the cited file states the quoted text at the cited line; read it in context before relying on it.

${needsInputSection(report)}## Findings by question

${report.questions.map(questionSection).join("\n\n")}

${searchedSection(report)}
${candidatesSection(report)}
${budgetSection(report)}
${diagnosticsSection(report)}
## Skeptic notes

- A supported finding is a quotation, not verified behavior: open the file at the cited revision and read the surrounding control flow.
- Leads state the signals in files this fact cannot count (documentation, changelogs, imports); they point at where to look, not at proof.
- Unsatisfied facts with unopened hits are the cheapest next step: resume the run or read those files directly.
`;
}

export function renderBriefPlanMd(report: BriefReport): string {
  const answered = report.questions.filter((question) => question.supported.length > 0);
  const open = report.questions.filter((question) => question.status !== "satisfied");
  const heading = report.status === "complete" ? "" : ` — ${report.status.toUpperCase()}`;
  const warning = report.status === "complete" ? "" : `> ⚠ **No implementation plan is safe while required questions are unresolved.** The gaps below say what to read or re-run first.\n\n`;
  const evidence = answered.length
    ? answered.map((question) => `### ${question.statement}\n\n${question.supported.map(findingLine).join("\n")}`).join("\n\n")
    : "_No question has a source-backed finding yet._";
  const gaps = open.length
    ? open.map((question) => {
      const lines = [`### ${question.statement} (${question.status})`];
      if (question.unsatisfied.length) lines.push(`- Still unproven: ${question.unsatisfied.join("; ")}`);
      if (question.nextReads.length) lines.push(`- Read next: ${question.nextReads.map(code).join(", ")}`);
      if (question.leads.length) lines.push(`- Leads: ${question.leads.slice(0, 3).map((lead) => `${lead.repo} ${code(lead.path)}`).join(", ")}`);
      if (!question.nextReads.length && !question.leads.length) lines.push("- No unopened hits remain: sharpen the fact's signals (a distinctive code token) or add a seed repository, then re-plan.");
      return lines.join("\n");
    }).join("\n\n")
    : "_None: every required question is satisfied._";
  const references = report.candidates.filter((row) => row.supported > 0).map((row) => `- ${row.url ? `[${row.repo}](${row.url})` : row.repo} — ${row.supported} supported claim(s), ${row.filesRead} file(s) read`).join("\n");
  return `# Plan: ${report.goal}${heading}

${warning}## Objective

${report.goal}

## What the evidence supports

${evidence}

## Gaps

${gaps}

## Verification steps

1. Open each supported finding at its cited revision and confirm the surrounding behavior matches the question.
2. Treat leads as places to look, never as proof; promote one only after reading the implementation it points at.
3. Resolve every gap (read the listed files, or resume the run with ${code("--resume <run-id>")}) before deciding how to implement.

## References

${references || "- No repository has a supported claim yet."}
`;
}

export function renderBriefChecklistMd(report: BriefReport): string {
  const verify = report.questions.flatMap((question) => question.supported.map((item) => `- [ ] ${item.repo} ${code(`${item.path}${item.line ? `:${item.line}` : ""}`)} — ${item.fact}${item.revision ? ` @ ${item.revision.slice(0, 7)}` : ""}`));
  const gaps = report.questions.filter((question) => question.status !== "satisfied").map((question) => `- [ ] ${question.statement}: ${question.unsatisfied.join("; ") || "unresolved"}${question.nextReads.length ? ` — read ${question.nextReads.slice(0, 3).map(code).join(", ")}` : ""}`);
  return `# Implementation Checklist: ${report.goal}

> Run status: **${report.status}**${report.reasons.length ? ` (${report.reasons.join(", ")})` : ""}. Quotations confirm text at a cited path; they do not verify runtime behavior.

## Verify evidence at source

${verify.join("\n") || "- [ ] No supported finding to verify yet."}

## Resolve gaps

${gaps.join("\n") || "- [x] Every required question is satisfied."}

## Before implementing

- [ ] Read each verified file in its surrounding context and note deviations between repositories.
- [ ] Keep supported findings, leads and assumptions separate in the implementation notes.
`;
}
