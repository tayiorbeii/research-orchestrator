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
import { redactSecrets } from "./redact.js";

export interface WriteArtifactsOptions {
  /** Exact evidence anchors gathered during the run. */
  evidence?: EvidenceAnchor[];
  /** Pre-computed pattern; derived from the run when omitted. */
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
  const formats = options.formats ?? [...ALL_FORMATS];
  const evidence = options.evidence ?? collectRunAnchors(run);
  const pattern =
    options.pattern ?? extractPattern(run.featureSpec, run.scoredCandidates, evidence);

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
    await writeFile(path, redactSecrets(content), "utf8");
    refs.push({ path, kind, createdAt });
  };

  const status = deriveRunStatus(run, evidence);
  if (formats.includes("research_md")) {
    await writeOne("research.md", "research", renderResearchMd(run, evidence, pattern, status));
  }
  if (formats.includes("plan_md")) {
    await writeOne("plan.md", "plan", renderPlanMd(run, evidence, pattern, status));
  }
  if (formats.includes("evidence_json")) {
    await writeOne("evidence.json", "evidence", renderEvidenceJson(run, evidence, status));
  }
  if (formats.includes("checklist_md")) {
    await writeOne(
      "implementation-checklist.md",
      "checklist",
      renderChecklistMd(run, evidence, pattern, status),
    );
  }
  return refs;
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
  if (status.status === "inconclusive") return renderInconclusiveResearchMd(run, evidence, status);
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
  const implementationPattern = [
    "**Server flow**",
    ...map.serverFlow.map((s) => `- ${s}`),
    "",
    "**Client flow**",
    ...map.clientFlow.map((s) => `- ${s}`),
    ...(map.routeProtection && map.routeProtection.length > 0
      ? ["", "**Route protection**", ...map.routeProtection.map((s) => `- ${s}`)]
      : []),
  ].join("\n");

  const targetFiles = map.files
    .map((f) => `- \`${f.path}\` — ${f.role}${f.evidence.length > 0 ? ` (proved in ${f.evidence.length} anchor${f.evidence.length === 1 ? "" : "s"})` : ""}`)
    .join("\n");

  return `# Research: ${spec.feature}

## Goal

${run.goal}

## Summary

Run \`${run.id}\` evaluated ${run.candidates.length} candidate repo(s) against ${spec.proofRequirements.length} proof requirement(s), selected ${selected.length} repo(s), and captured ${evidence.length} evidence anchor(s) (${evidence.filter((a) => a.proofLevel === "proved").length} proved).

## Selected repositories

| Repo | Class | Score | Why selected |
|---|---:|---:|---|
${selectedTable || "| _none_ | - | - | no candidates met the selection threshold |"}

## Candidate analysis

${candidateAnalysis || "_No candidates analyzed._"}

## Implementation pattern

${implementationPattern}

## Evidence map

${evidenceMap || "_No evidence collected._"}

## Libraries and dependencies

${map.dependencies.map((d) => `- \`${d}\``).join("\n") || "_None identified._"}

## Files likely needed in target project

${targetFiles || "_None identified._"}

## Pitfalls and edge cases

${map.pitfalls.map((p) => `- ${p}`).join("\n")}

## Open questions

${pattern.openQuestions.map((q) => `- ${q}`).join("\n") || "- None outstanding."}

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
  if (status.status === "inconclusive") return renderInconclusivePlanMd(run, evidence, status);
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

Follow the pattern proved by ${run.selectedRepos.length} selected repo(s). Dependencies: ${map.dependencies.map((d) => `\`${d}\``).join(", ") || "none identified"}.

## Files to create or modify

| Path | Role | Action |
|---|---|---|
${filesTable || "| _none identified_ | - | - |"}

## Step-by-step implementation

${pattern.implementationSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Environment variables

${
  map.environmentVariables.length > 0
    ? map.environmentVariables.map((v) => `- \`${v}\` (name only — set the value in your secret store)`).join("\n")
    : "- None identified. Verify against the selected repos' README/env docs."
}

## Testing plan

${(map.tests ?? ["Add unit tests for the new flow.", "Add one integration/e2e path.", "Run a manual smoke test."]).map((t) => `- ${t}`).join("\n")}

## Rollback plan

- Land the change behind a small, isolated commit series so a single revert removes the feature.
- Keep the previous auth/feature path working until the new flow passes smoke tests.
- Document the env vars added so they can be removed cleanly on rollback.

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
    createdAt: run.createdAt,
    goal: run.goal,
    featureKey: run.featureSpec.featureKey,
    status: status.status,
    statusReasons: status.reasons,
    selectedRepos: run.selectedRepos,
    scoredCandidates: run.scoredCandidates,
    evidence,
    warnings: run.warnings,
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

export interface RunStatus {
  status: "complete" | "inconclusive";
  reasons: string[];
}

/**
 * Derive a run's outcome from concrete artifacts, not aspiration. A run is only
 * "complete" when it selected at least one repo AND captured proved evidence;
 * otherwise it is "inconclusive" with machine-readable reasons. This is what
 * prevents a zero-evidence run from looking like successful research.
 */
export function deriveRunStatus(run: ResearchRun, evidence: EvidenceAnchor[]): RunStatus {
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
  } else if (selectedEvidence.every((anchor) => anchor.proofLevel !== "proved")) {
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
  return status.status === "inconclusive"
    ? renderRecoveryChecklistMd(run, status)
    : renderDerivedChecklistMd(run, pattern);
}

/** Evidence-derived checklist for a complete (evidence-backed) run. */
function renderDerivedChecklistMd(run: ResearchRun, pattern: ExtractedPattern): string {
  const spec = run.featureSpec;
  const map = pattern.implementationMap;
  const flowSteps = [
    ...map.serverFlow.map((s) => `Server: ${s}`),
    ...map.clientFlow.map((s) => `Client: ${s}`),
    ...(map.routeProtection ?? []).map((s) => `Routing: ${s}`),
  ];
  const tests = map.tests ?? [];

  return `# Implementation Checklist: ${spec.feature}

## Dependencies
${
  map.dependencies.length > 0
    ? map.dependencies.map((d) => `- [ ] Install or verify \`${d}\`.`).join("\n")
    : "- [ ] Confirm required dependencies (none were identified from evidence)."
}

## Environment
${
  map.environmentVariables.length > 0
    ? map.environmentVariables
        .map((v) => `- [ ] Set \`${v}\` (name only; store the value in your secret store).`)
        .join("\n")
    : "- [ ] Confirm environment variables against the selected repos' README/env docs."
}

## Files to create or modify
${
  map.files.length > 0
    ? map.files
        .map(
          (f) =>
            `- [ ] \`${f.path}\` — ${f.role}${
              f.evidence.length > 0
                ? ` (follow the proved pattern from ${f.evidence.length} anchor${
                    f.evidence.length === 1 ? "" : "s"
                  })`
                : " (no direct proof; verify against the selected repos)"
            }.`,
        )
        .join("\n")
    : "- [ ] No target files were identified from evidence."
}

## Implementation flow
${
  flowSteps.length > 0
    ? flowSteps.map((s) => `- [ ] ${s}`).join("\n")
    : "- [ ] No implementation flow was extracted; follow the selected repos' evidence anchors."
}

## Tests
${
  tests.length > 0
    ? tests.map((t) => `- [ ] ${t}`).join("\n")
    : "- [ ] Add unit tests for the new flow.\n- [ ] Add one integration / e2e path.\n- [ ] Run a manual smoke test."
}

## Verification & rollout
- [ ] Re-check every accepted repo's evidence anchors against live source before relying on them.
- [ ] Land the change behind small, isolated commits so a single revert removes it.
- [ ] Update README / internal docs and resolve or explicitly accept open questions.
`;
}

/** Recovery checklist for an inconclusive run: never emits implementation/auth boilerplate. */
function renderRecoveryChecklistMd(run: ResearchRun, status: RunStatus): string {
  const spec = run.featureSpec;
  return `# Research Recovery Checklist: ${spec.feature}

> ⚠ Run status: **inconclusive** (${status.reasons.join(", ") || "unknown"}).
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
  const probeList =
    run.probes.length > 0
      ? run.probes.map((p) => `- [${p.kind}] ${p.query} — ${p.rationale}`).join("\n")
      : "- No probes were generated.";
  return `# Research: ${spec.feature} (INCONCLUSIVE)

> ⚠ **This run is INCONCLUSIVE.** No fully evidence-backed conclusion was reached.
> The sections below describe what was searched and why proof remained incomplete — they are
> diagnostics, not verified findings. Do not present this as completed research.

## Goal

${run.goal}

## Status

- **Status:** \`inconclusive\`
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

## What was searched

${probeList}

## Open questions (unresolved)

${recoveryQuestions(status).map((q) => `- ${q}`).join("\n")}

## Recovery steps

${recoverySteps(status).map((s) => `- ${s}`).join("\n")}

## Diagnostics (warnings)

${run.warnings.map((w) => `- ${w}`).join("\n") || "- none"}

## Skeptic notes

- An inconclusive run must never be presented as completed research.
- Re-run after fixing the highest-priority reason above before drawing any conclusion.
`;
}

function renderInconclusivePlanMd(
  run: ResearchRun,
  evidence: EvidenceAnchor[],
  status: RunStatus,
): string {
  const spec = run.featureSpec;
  const provedCount = evidence.filter((anchor) => anchor.proofLevel === "proved").length;
  return `# Plan: ${spec.feature} — INCONCLUSIVE (no evidence-backed plan)

> ⚠ No implementation plan is safe until the proof contract is complete. This
> file lists recovery actions, not steps to implement. Do not build from it.

## Objective

${run.goal}

## Status: inconclusive

Reasons: ${status.reasons.join(", ") || "unknown"}

## Why there is no plan

The run selected ${run.selectedRepos.length} repository/repositories and captured
${evidence.length} evidence anchor(s) (${provedCount} proved), but the proof contract
is still incomplete. Resolve the reasons above and re-run before implementing.

## Recovery actions

${recoverySteps(status).map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Probes attempted

${run.probes.map((p) => `- [${p.kind}] ${p.query}`).join("\n") || "- none"}

## References

${
  run.selectedRepos.length > 0
    ? run.selectedRepos.map((repo) => `- ${repo} (partially supported; do not implement yet)`).join("\n")
    : "- No repositories selected. Re-run after recovery; do not implement from this file."
}
`;
}
