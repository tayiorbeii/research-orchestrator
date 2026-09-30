import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArtifactRef,
  EvidenceAnchor,
  ResearchRun,
  ScoredCandidate,
} from "../schemas/index.js";
import { ResearchError } from "./errors.js";
import { extractPattern, type ExtractedPattern } from "./extractPattern.js";
import { getMissingRequiredProof } from "./scoreCandidate.js";
import { downgradeAnchorsForRedactedObservations, redactArtifactContent, redactResearchRun } from "./redact.js";
import { EVIDENCE_POLICY_VERSION, isExactQuotationSupport } from "./evidencePolicy.js";
import { deriveCoverage } from "./assessment/coverage.js";
import { deriveBriefCoverage } from "./assessment/briefCoverage.js";

export interface WriteArtifactsOptions {
  /** Exact evidence anchors gathered during the run. */
  evidence?: EvidenceAnchor[];
  /** @deprecated Phase 1 ignores imported patterns and recomputes a conservative view. */
  pattern?: ExtractedPattern;
  formats?: Array<"research_md" | "plan_md" | "evidence_json" | "checklist_md">;
}

const ALL_FORMATS = ["research_md", "plan_md", "evidence_json", "checklist_md"] as const;

/**
 * Write research.md, plan.md, evidence.json, and implementation-checklist.md.
 * Every write passes through secret redaction (docs/09_security_privacy.md):
 * env var names are kept, values are redacted, token shapes are stripped.
 */
export async function writeArtifacts(
  run: ResearchRun,
  outDir: string,
  options: WriteArtifactsOptions = {},
): Promise<ArtifactRef[]> {
  run = redactResearchRun(run);
  // Brief runs re-derive coverage from the brief's own questions, exactly as the engine
  // did; the FeatureSpec projection has different question ids and would disagree.
  const derived = run.schemaVersion !== 2 ? undefined : run.brief ? deriveBriefCoverage({
    brief: run.brief, candidateRepos: run.candidates.map((candidate) => candidate.repo),
    observations: run.observations ?? [], assessments: run.assessments ?? [],
    probes: run.probesV2 ?? run.compiledProbes ?? [], probeOutcomes: run.probeOutcomes ?? [], providerName: run.providerName,
  }) : deriveCoverage({
    spec: run.featureSpec, candidates: run.candidates.map((candidate) => candidate.repo),
    states: run.candidateStates ?? [], observations: run.observations ?? [], assessments: run.assessments ?? [],
  });
  const outcome = derived && run.schemaVersion === 2
    ? { ...derived.outcome, reasons: [...new Set([...derived.outcome.reasons, ...(run.outcome?.reasons ?? [])])] }
    : undefined;
  const receiptRun: ResearchRun = derived && run.schemaVersion === 2
    ? { ...run, coverage: derived.coverage, outcome: outcome! } : run;
  const formats = options.formats ?? [...ALL_FORMATS];
  const evidence = downgradeAnchorsForRedactedObservations(options.evidence ?? collectRunAnchors(run), run.observations ?? []);
  const pattern = extractPattern(receiptRun.featureSpec, receiptRun.scoredCandidates, evidence);

  try {
    await mkdir(outDir, { recursive: true });
  } catch (error) {
    throw new ResearchError(
      "artifact_write_failed",
      `Could not create output directory ${outDir}: ${(error as Error).message}`,
      { recoverable: true, suggestedAction: "Check the --out path and permissions." },
    );
  }

  const refs: ArtifactRef[] = [];
  const createdAt = run.createdAt;
  const writeOne = async (
    file: string,
    kind: ArtifactRef["kind"],
    content: string,
  ): Promise<void> => {
    const path = join(outDir, file);
    await writeFile(path, redactArtifactContent(file, content), "utf8");
    refs.push({ path, kind, createdAt });
  };

  const status = deriveRunStatus(receiptRun, evidence);
  if (formats.includes("research_md")) {
    await writeOne("research.md", "research", withMockOrigin(receiptRun, evidence, renderResearchMd(receiptRun, evidence, pattern, status)));
  }
  if (formats.includes("plan_md")) {
    await writeOne("plan.md", "plan", withMockOrigin(receiptRun, evidence, renderPlanMd(receiptRun, evidence, pattern, status)));
  }
  if (formats.includes("evidence_json")) {
    await writeOne("evidence.json", "evidence", renderEvidenceJson(receiptRun, evidence, status));
  }
  if (formats.includes("checklist_md")) {
    await writeOne(
      "implementation-checklist.md",
      "checklist",
      withMockOrigin(receiptRun, evidence, renderChecklistMd(receiptRun, evidence, pattern, status)),
    );
  }
  return refs;
}

function withMockOrigin(run: ResearchRun, evidence: EvidenceAnchor[], content: string): string {
  return hasMockOrigin(run, evidence)
    ? `> **Synthetic/mock evidence:** fixture observations are not live repository findings.\n\n${content}`
    : content;
}

function hasMockOrigin(run: ResearchRun, evidence: EvidenceAnchor[]): boolean {
  return (
    run.evidenceOrigin === "synthetic_mock" ||
    run.assessments?.some((assessment) => assessment.evidenceOrigin === "synthetic") === true ||
    evidence.some((anchor) => anchor.provider === "mock") ||
    run.candidates.some((candidate) => candidate.candidateSignals.some((signal) => signal.source === "mock")) ||
    run.explanations.some((explanation) => explanation.source === "mock")
  );
}

function collectRunAnchors(run: ResearchRun): EvidenceAnchor[] {
  const anchors: EvidenceAnchor[] = [];
  for (const candidate of run.candidates) {
    for (const signal of candidate.candidateSignals) {
      for (const anchor of signal.evidence ?? []) anchors.push(anchor);
    }
  }
  for (const explanation of run.explanations) {
    for (const answer of explanation.answers) anchors.push(...answer.evidence);
    for (const file of explanation.implementationMap.files) anchors.push(...file.evidence);
  }
  const seen = new Set<string>();
  return anchors.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
}

// ---------------------------------------------------------------------------
// Renderers (shaped after templates/*.template)
// ---------------------------------------------------------------------------

function scoredByRepo(run: ResearchRun): Map<string, ScoredCandidate> {
  return new Map(run.scoredCandidates.map((s) => [s.repo, s]));
}

function anchorsForRepo(evidence: EvidenceAnchor[], repo: string): EvidenceAnchor[] {
  return evidence.filter((a) => a.repo === repo);
}

function anchorLine(a: EvidenceAnchor): string {
  const lines = a.startLine ? `:${a.startLine}${a.endLine && a.endLine !== a.startLine ? `-${a.endLine}` : ""}` : "";
  const link = a.url ? ` ([link](${a.url}))` : "";
  const match = a.matchText ? ` — \`${a.matchText.replace(/`/g, "'")}\`` : "";
  return `- \`${a.path}${lines}\` [${a.role}, ${a.proofLevel}]${match}${link}`;
}

function renderResearchMd(
  run: ResearchRun,
  evidence: EvidenceAnchor[],
  pattern: ExtractedPattern,
  status: RunStatus,
): string {
  if (status.status !== "complete") return renderInconclusiveResearchMd(run, evidence, status);
  const spec = run.featureSpec;
  const scored = run.scoredCandidates;
  const selected = run.selectedRepos;
  const byRepo = scoredByRepo(run);

  const selectedTable = selected
    .map((repo) => {
      const s = byRepo.get(repo);
      const candidate = run.candidates.find((c) => c.repo === repo);
      const why =
        s && s.positiveSignals.length > 0
          ? s.positiveSignals.map((p) => p.key).slice(0, 4).join(", ")
          : "candidate signals only";
      const url = candidate?.url ? `[${repo}](${candidate.url})` : repo;
      return `| ${url} | ${s?.class ?? "unknown"} | ${s?.score.toFixed(2) ?? "-"} | ${why} |`;
    })
    .join("\n");

  const candidateAnalysis = scored
    .map((s) => {
      const anchors = anchorsForRepo(evidence, s.repo);
      return [
        `### ${s.repo}`,
        "",
        `- Class: \`${s.class}\` — Score: **${s.score.toFixed(2)}** — Next action: \`${s.nextAction}\``,
        `- Positive signals: ${s.positiveSignals.map((p) => p.key).join(", ") || "none"}`,
        `- Negative signals: ${s.negativeSignals.map((n) => n.key).join(", ") || "none"}`,
        `- Evidence anchors: ${anchors.length}`,
        s.missingProof.length > 0
          ? `- Missing proof:\n${s.missingProof.map((m) => `  - ${m}`).join("\n")}`
          : "- Missing proof: none",
        s.rejectionReasons.length > 0
          ? `- Rejection reasons: ${s.rejectionReasons.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const evidenceMap = selected
    .map((repo) => {
      const anchors = anchorsForRepo(evidence, repo);
      if (anchors.length === 0) return `### ${repo}\n\n- No exact anchors (needs a proof pass).`;
      return `### ${repo}\n\n${anchors.map(anchorLine).join("\n")}`;
    })
    .join("\n\n");

  const map = pattern.implementationMap;
  const targetFiles = map.files
    .map((f) => `- \`${f.path}\` — ${f.role}${f.evidence.length > 0 ? ` (proved in ${f.evidence.length} anchor${f.evidence.length === 1 ? "" : "s"})` : ""}`)
    .join("\n");

  return `# Research: ${spec.feature}

## Goal

${run.goal}

## Summary

Run \`${run.id}\` evaluated ${run.candidates.length} candidate repo(s) against ${spec.proofRequirements.length} source-observation requirement(s), selected ${selected.length} repo(s), and captured ${evidence.length} evidence anchor(s) (${evidence.filter(isExactQuotationSupport).length} exact-quotation supports).

## Selected repositories

| Repo | Class | Score | Why selected |
|---|---:|---:|---|
${selectedTable || "| _none_ | - | - | no candidates met the selection threshold |"}

${run.schemaVersion === 2 && run.brief ? renderWhatWasSearched(run) : ""}

## Candidate analysis

${candidateAnalysis || "_No candidates analyzed._"}

## Phase 1 interpretation

Exact source quotations support only that the cited source states the quoted text. They do not establish that an implementation works or provide a pattern to copy.

## Evidence map

${evidenceMap || "_No evidence collected._"}

## Libraries and dependencies

${map.dependencies.map((d) => `- \`${d}\``).join("\n") || "_No dependency declarations were established by the source quotations._"}

## Files likely needed in target project

${targetFiles || "_None identified._"}

## Pitfalls and edge cases

${map.pitfalls.map((p) => `- ${p}`).join("\n")}

## Open questions

${pattern.openQuestions.map((q) => `- ${q}`).join("\n") || "- Runtime behavior, surrounding control flow, and implementation suitability remain unassessed in Phase 1."}

## Skeptic notes

- Verify every accepted repo actually implements the feature end to end.
- Confirm no docs-only repo was misclassified as implementation proof.
- Re-check anchors against live repository contents before relying on them.
${run.warnings.map((w) => `- Warning: ${w}`).join("\n")}
`;
}

function renderPlanMd(
  run: ResearchRun,
  evidence: EvidenceAnchor[],
  pattern: ExtractedPattern,
  status: RunStatus,
): string {
  if (status.status !== "complete") return renderInconclusivePlanMd(run, evidence, status);
  const spec = run.featureSpec;
  const map = pattern.implementationMap;
  const byRepo = scoredByRepo(run);

  const references = run.selectedRepos
    .map((repo) => {
      const candidate = run.candidates.find((c) => c.repo === repo);
      const s = byRepo.get(repo);
      const anchors = anchorsForRepo(evidence, repo).slice(0, 6);
      const head = candidate?.url ? `[${repo}](${candidate.url})` : repo;
      return `- ${head} (${s?.class ?? "unknown"}, score ${s?.score.toFixed(2) ?? "-"})\n${anchors
        .map((a) => `  ${anchorLine(a)}`)
        .join("\n")}`;
    })
    .join("\n");

  const filesTable = map.files
    .map((f) => `| \`${f.path}\` | ${f.role} | ${f.evidence.length > 0 ? "create/modify (proved pattern)" : "create"} |`)
    .join("\n");

  return `# Plan: ${spec.feature}

## Objective

${run.goal}

## Recommended approach

Phase 1 established source quotations only. It did not establish an implementation pattern, dependencies to install, or steps to copy.

## Files to create or modify

| Path | Role | Action |
|---|---|---|
${filesTable || "| _none identified_ | - | - |"}

## Step-by-step implementation

${pattern.implementationSteps.map((s, i) => `${i + 1}. ${s}`).join("\n") || "No implementation steps are established by source quotations."}

## Environment variables

${
  map.environmentVariables.length > 0
    ? map.environmentVariables.map((v) => `- \`${v}\` (name only — set the value in your secret store)`).join("\n")
    : "- No environment requirements are established by source quotations."
}

## Testing plan

${(map.tests ?? []).map((t) => `- ${t}`).join("\n") || "No implementation test plan is established by source quotations."}

## Rollback plan

No rollback guidance is established by the source quotations.

## Dependencies

${map.dependencies.map((d) => `- \`${d}\``).join("\n") || "- None identified."}

## References

${references || "- No repositories selected; treat this plan as unproved."}

## Risks

${pattern.risks.map((r) => `- ${r}`).join("\n") || "- None recorded."}
`;
}

function renderEvidenceJson(
  run: ResearchRun,
  evidence: EvidenceAnchor[],
  status: RunStatus,
): string {
  const payload = {
    runId: run.id,
    evidencePolicyVersion: run.evidencePolicyVersion ?? "legacy_unvalidated",
    evidenceOrigin: hasMockOrigin(run, evidence)
      ? "synthetic_mock"
      : (run.evidenceOrigin ?? "legacy_unvalidated"),
    createdAt: run.createdAt,
    goal: run.goal,
    featureKey: run.featureSpec.featureKey,
    status: status.status,
    statusReasons: status.reasons,
    selectedRepos: run.selectedRepos,
    scoredCandidates: run.scoredCandidates,
    schemaVersion: run.schemaVersion,
    ...(run.schemaVersion === 2 && run.brief ? { brief: { id: run.brief.id, revision: run.brief.revision } } : {}),
    ...(run.schemaVersion === 2 && run.brief ? { probes: run.probesV2 ?? run.compiledProbes ?? [] } : {}),
    ...(run.schemaVersion === 2 && run.brief ? { probeOutcomes: run.probeOutcomes ?? [] } : {}),
    ...(run.schemaVersion === 2 && run.brief ? { budgetLedger: run.budgetLedger } : {}),
    observations: run.observations,
    assessments: run.assessments,
    coverage: run.coverage,
    outcome: run.outcome,
    candidateStates: run.candidateStates,
    explanationResults: run.explanationResults,
    evidence,
    warnings: run.warnings,
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

function renderWhatWasSearched(run: ResearchRun): string {
  if (run.schemaVersion !== 2) return "";
  const probes = run.probesV2 ?? run.compiledProbes ?? [];
  const rows = probes.map((probe) => {
    const questions = probe.questionIds.map((id) => run.brief?.questions.find((question) => question.id === id)?.statement ?? id).join("; ");
    const outcome = run.probeOutcomes?.find((item) => item.probeId === probe.id);
    const result = outcome ? `${outcome.status}${outcome.resultClass ? ` (${outcome.resultClass})` : ""}` : "not attempted";
    const count = outcome?.resultIds.length ?? 0;
    const endpoint = typeof probe.providerArgs.endpoint === "string" ? probe.providerArgs.endpoint : "unknown";
    const safe = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
    return `| ${safe(questions)} | \`${safe(probe.providerQuery)}\` | ${endpoint} | ${result} | ${count} |`;
  });
  return `## What was searched\n\n| Question | Compiled query | Endpoint | Outcome | Results |\n|---|---|---|---|---:|\n${rows.join("\n") || "| _none_ | - | - | not attempted | 0 |"}\n`;
}

function renderV2Receipt(run: ResearchRun): string {
  if (run.schemaVersion !== 2 || !run.coverage || !run.assessments || !run.outcome) return "";
  const coverage = run.coverage.length
    ? run.coverage.map((question) => {
        const supported = question.supportedClaimIds.length ? question.supportedClaimIds.join(", ") : "none";
        const gaps = question.unsatisfiedObligations.length ? question.unsatisfiedObligations.join("; ") : "none";
        return `- \`${question.questionId}\`: **${question.status}**; supported claims: ${supported}; open obligations: ${gaps}`;
      }).join("\n")
    : "- No required proof questions.";
  const assessments = run.assessments.length
    ? run.assessments.map((assessment) => `- \`${assessment.claimId}\` (${assessment.subject.repo}, ${assessment.method}): **${assessment.status}** — ${assessment.rationale}`).join("\n")
    : "- No candidate claims were assessed.";
  const rpcReceipt = run.budgetLedger
    ? `\n\n## Budget receipt\n\n- Physical RPC calls: ${run.budgetLedger.consumed.rpcCount}; unbudgeted metadata calls: ${run.budgetLedger.consumed.unbudgetedMetadataCalls ?? 0} (${Object.entries(run.budgetLedger.consumed.metadataCallBreakdown ?? {}).map(([kind, count]) => `${kind}: ${count}`).join(", ") || "no breakdown recorded"}).`
    : "";
  return `## Question coverage\n\n${coverage}\n\n## Claim assessments\n\n${assessments}\n\n## Run outcome\n\n- **${run.outcome.status}**${run.outcome.reasons.length ? ` — ${run.outcome.reasons.join("; ")}` : ""}${rpcReceipt}`;
}

export interface RunStatus {
  status: "complete" | "partial" | "inconclusive" | "needs_input" | "failed" | "legacy_unvalidated";
  reasons: string[];
}

/**
 * Derive a run's outcome from concrete artifacts, not aspiration. A run is only
 * "complete" when it selected at least one repo AND captured narrow source support;
 * otherwise it is "inconclusive" with machine-readable reasons. This is what
 * prevents a zero-evidence run from looking like successful research.
 */
export function deriveRunStatus(run: ResearchRun, evidence: EvidenceAnchor[]): RunStatus {
  if (run.schemaVersion === 2 && run.outcome) return { status: run.outcome.status, reasons: run.outcome.reasons };
  if (run.evidencePolicyVersion !== EVIDENCE_POLICY_VERSION) return { status: "legacy_unvalidated", reasons: ["legacy_unvalidated"] };
  const reasons: string[] = [];
  if (run.warnings.some((w) => /\[provider_search_failed\]|Provider code search failed/i.test(w))) {
    reasons.push("provider_search_failed");
  }
  if (run.candidates.length === 0) reasons.push("no_candidates");
  if (run.selectedRepos.length === 0) reasons.push("no_selected_repositories");

  const selected = new Set(run.selectedRepos);
  const selectedEvidence = evidence.filter((anchor) => !anchor.repo || selected.has(anchor.repo));
  if (selectedEvidence.length === 0) {
    reasons.push("no_evidence_anchors");
  } else if (!selectedEvidence.some(isExactQuotationSupport)) {
    reasons.push("no_proved_evidence");
  } else if (getMissingRequiredProof(run.featureSpec, selectedEvidence).length > 0) {
    reasons.push("missing_required_proof");
  }
  return { status: reasons.length === 0 ? "complete" : "inconclusive", reasons };
}

function renderChecklistMd(
  run: ResearchRun,
  _evidence: EvidenceAnchor[],
  pattern: ExtractedPattern,
  status: RunStatus,
): string {
  return status.status !== "complete"
    ? renderRecoveryChecklistMd(run, status)
    : renderDerivedChecklistMd(run, pattern);
}

/** Evidence-derived checklist for a complete (evidence-backed) run. */
function renderDerivedChecklistMd(run: ResearchRun, _pattern: ExtractedPattern): string {
  return `# Implementation Checklist: ${run.featureSpec.feature}

> No implementation checklist is established. Phase 1 source quotations confirm only the text present at a cited path; they do not verify runtime behavior or a pattern to copy.

## Before implementation
- [ ] Assess the quoted source in its surrounding context.
- [ ] Verify the relevant behavior independently before planning implementation work.
`;
}

/** Recovery checklist for an inconclusive run: never emits implementation/auth boilerplate. */
function renderRecoveryChecklistMd(run: ResearchRun, status: RunStatus): string {
  const spec = run.featureSpec;
  return `# Research Recovery Checklist: ${spec.feature}

> ⚠ Run status: **${status.status}** (${status.reasons.join(", ") || "unknown"}).
> No implementation work should proceed from the previous run. Resolve the
> items below, then re-run research before building anything.

## Confirm the research specification
- [ ] Verify the normalized feature/key terms captured the real subject (see research.md "What was searched").
- [ ] If key entities were dropped, add structured \`hints\` (requiredConcepts, likelyFiles, proofRequirements).
- [ ] Confirm the goal was classified correctly (research/migration vs. application build).

## Verify the evidence provider
- [ ] Confirm the Octocode bridge is configured (RESEARCH_OCTOCODE_BRIDGE, transport, auth).
- [ ] Distinguish a transport/auth failure from a genuine empty result (see Diagnostics).
- [ ] Check rate limits / quotas if searches returned nothing.
- [ ] Re-run with RESEARCH_OCTOCODE_DEBUG=1 and inspect generated probes + provider responses.

## Broaden discovery
- [ ] Run each repo_search probe individually against ghSearchRepos and inspect results.
- [ ] For migration goals, add the source and target project repos/docs as explicit candidates.
- [ ] Add official documentation URLs as explicit hints if discovery keeps missing the project.

## Before re-running
- [ ] Back up or version the previous (inconclusive) artifacts for auditability.
- [ ] Re-run into a new output directory; do not overwrite until evidence is real.
- [ ] Only proceed to an implementation checklist once evidence anchors exist.
`;
}

function recoveryQuestions(status: RunStatus): string[] {
  const q: string[] = [];
  if (status.reasons.includes("provider_search_failed")) {
    q.push("Is the evidence provider (Octocode bridge) configured and authenticated?");
  }
  if (status.reasons.includes("no_candidates")) {
    q.push("Did the generated probes match real repositories? Are the product names correct?");
  }
  if (status.reasons.includes("no_evidence_anchors") || status.reasons.includes("no_proved_evidence")) {
    q.push("Were any files actually read for the candidates? Are likelyFiles/proof signals correct?");
  }
  if (status.reasons.includes("missing_required_proof")) {
    q.push("Which required proof role or named system is still unsupported by proved anchors?");
  }
  if (q.length === 0) {
    q.push("Why did this run fail to produce evidence? Inspect the diagnostics and probes.");
  }
  return q;
}

function recoverySteps(status: RunStatus): string[] {
  return [
    "Inspect research.md \"What was searched\" to confirm probes targeted the right entities.",
    status.reasons.includes("provider_search_failed")
      ? "Fix the provider/transport: set RESEARCH_OCTOCODE_BRIDGE, verify auth, and re-run."
      : "If discovery missed the project, add the official repo/docs URL as an explicit hint or candidate.",
    "Provide structured hints (requiredConcepts, likelyFiles, proofRequirements) for novel domains.",
    "Re-run into a new output directory and compare; do not overwrite inconclusive artifacts.",
  ];
}

function renderInconclusiveResearchMd(
  run: ResearchRun,
  evidence: EvidenceAnchor[],
  status: RunStatus,
): string {
  const spec = run.featureSpec;
  const probeList = run.schemaVersion === 2 && run.brief ? renderWhatWasSearched(run) :
    run.probes.length > 0
      ? run.probes.map((p) => `- [${p.kind}] ${p.query} — ${p.rationale}`).join("\n")
      : "- No probes were generated.";
  return `# Research: ${spec.feature} (${status.status.toUpperCase()})

> ⚠ **This run is ${status.status.toUpperCase()}.** No fully evidence-backed conclusion was reached.
> The sections below describe what was searched and why proof remained incomplete — they are
> diagnostics, not verified findings. Do not present this as completed research.

## Goal

${run.goal}

## Status

- **Status:** \`${status.status}\`
- **Reasons:** ${status.reasons.join(", ") || "unknown"}
- Candidates evaluated: ${run.candidates.length}
- Repositories selected: ${run.selectedRepos.length}
- Evidence anchors: ${evidence.length}

## Summary

Run \`${run.id}\` evaluated ${run.candidates.length} candidate(s), selected
${run.selectedRepos.length} repository/repositories, and captured ${evidence.length}
evidence anchor(s), but did not satisfy the complete proof contract. This is
**not** proof that the answer is negative. Treat these artifacts as diagnostics,
not completed findings.

${renderV2Receipt(run)}

${run.schemaVersion === 2 && run.brief ? probeList : `## What was searched\n\n${probeList}`}

## Open questions (unresolved)

${recoveryQuestions(status).map((q) => `- ${q}`).join("\n")}

## Recovery steps

${recoverySteps(status).map((s) => `- ${s}`).join("\n")}

## Diagnostics (warnings)

${run.warnings.map((w) => `- ${w}`).join("\n") || "- none"}

## Skeptic notes

- A non-complete run must never be presented as completed research.
- Re-run after fixing the highest-priority reason above before drawing any conclusion.
`;
}

function renderInconclusivePlanMd(
  run: ResearchRun,
  evidence: EvidenceAnchor[],
  status: RunStatus,
): string {
  const spec = run.featureSpec;
  const provedCount = evidence.filter(isExactQuotationSupport).length;
  return `# Plan: ${spec.feature} — ${status.status.toUpperCase()} (no evidence-backed plan)

> ⚠ No implementation plan is safe until the proof contract is complete. This
> file lists recovery actions, not steps to implement. Do not build from it.

## Objective

${run.goal}

## Status: inconclusive

Reasons: ${status.reasons.join(", ") || "unknown"}

## Why there is no plan

The run selected ${run.selectedRepos.length} repository/repositories and captured
${evidence.length} evidence anchor(s) (${provedCount} exact-quotation supports), but the proof contract
is still incomplete. Source quotations establish only what a source states; they do not establish runtime behavior.
No implementation steps are established. Resolve the reasons above and re-run before implementing.

## Recovery actions

${recoverySteps(status).map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Probes attempted

${run.probes.map((p) => `- [${p.kind}] ${p.query}`).join("\n") || "- none"}

## References

${
  run.selectedRepos.length > 0
    ? run.selectedRepos.map((repo) => {
        const url = run.candidates.find((candidate) => candidate.repo === repo)?.url;
        return `- ${url ? `[${repo}](${url})` : repo} (partially supported; do not implement yet)`;
      }).join("\n")
    : "- No repositories selected. Re-run after recovery; do not implement from this file."
}
`;
}
