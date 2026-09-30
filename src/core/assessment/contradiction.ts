import type { ClaimAssessment, SourceObservation } from "../../schemas/researchContracts.js";
import type { ClaimSpec } from "./types.js";

/**
 * Apply same-subject falsifier checks to an already supported narrow claim.
 * Ambiguous scope and revision changes narrow the assessment to partial;
 * neither is treated as evidence that the claim is false.
 */
export function assessScopedContradiction(
  claim: ClaimSpec,
  supported: ClaimAssessment,
  observations: readonly SourceObservation[],
): ClaimAssessment {
  if (supported.status !== "supported") return supported;
  const subject = observations.filter((observation) => observation.repo === claim.subject.repo);
  const supportRevisions = unique(supported.requiredObservationIds.flatMap((id) => {
    const revision = subject.find((observation) => observation.id === id)?.resolvedRevision;
    return revision ? [revision] : [];
  }));
  const targetRevision = claim.subject.revision ?? (supportRevisions.length === 1 ? supportRevisions[0] : undefined);
  const subjectRevisions = unique(subject.flatMap((observation) => observation.resolvedRevision ? [observation.resolvedRevision] : []));
  const sameRevision = subject.filter((observation) =>
    targetRevision !== undefined
      ? observation.resolvedRevision === targetRevision
      : subjectRevisions.length <= 1,
  );
  const otherRevision = subject.filter((observation) =>
    observation.resolvedRevision !== undefined &&
    (targetRevision !== undefined
      ? observation.resolvedRevision !== targetRevision
      : subjectRevisions.length > 1),
  );

  const findings = sameRevision.flatMap((observation) => findFalsifiers(claim, observation));
  const disconnectedHelper = findDisconnectedHelper(claim, sameRevision);
  if (disconnectedHelper) findings.push(disconnectedHelper);
  const scoped = findings.find((finding) => finding.scope === "same_subject");
  if (scoped) {
    return {
      ...supported,
      status: "contradicted",
      requiredObservationIds: unique([...supported.requiredObservationIds, scoped.observationId]),
      rationale: `The supported assertion is disabled in the same repository and revision: ${scoped.detail}`,
      remainingObligations: ["Separate the source-presence fact from whether this scoped subject is active or enforced."],
      limitations: unique([...supported.limitations, "Contradiction is limited to the matching source scope and revision."]),
    };
  }

  const concern = findings[0];
  if (otherRevision.length > 0 || supportRevisions.length > 1) {
    const revisions = unique(otherRevision.map((observation) => observation.resolvedRevision!).filter(Boolean));
    return {
      ...supported,
      status: "partial",
      requiredObservationIds: unique([...supported.requiredObservationIds, ...otherRevision.map((item) => item.id)]),
      rationale: `${supported.rationale} A potentially conflicting observation belongs to a different revision (${revisions.join(", ")}); both observations are retained as historical/current variation.`,
      remainingObligations: ["Compare claims within one pinned revision before describing current behavior."],
      limitations: unique([...supported.limitations, "Evidence from different revisions is not a contradiction."]),
    };
  }
  if (concern) {
    return {
      ...supported,
      status: "partial",
      requiredObservationIds: unique([...supported.requiredObservationIds, concern.observationId]),
      rationale: `${supported.rationale} A possible falsifier was observed, but its relationship to the asserted subject is not established: ${concern.detail}`,
      remainingObligations: ["Inspect the enclosing rule, job, step, and path scope before making an enforcement claim."],
      limitations: unique([...supported.limitations, "A nearby but unscoped override or skip does not establish contradiction."]),
    };
  }
  return supported;
}

interface Falsifier {
  observationId: string;
  scope: "same_subject" | "ambiguous";
  detail: string;
}

function findFalsifiers(claim: ClaimSpec, observation: SourceObservation): Falsifier[] {
  if (!observation.excerpt || observation.readStatus === "unavailable" || observation.readStatus === "failed") return [];
  const lines = observation.excerpt.split(/\r?\n/);
  const rule = assertedRule(claim.assertion);
  const assertedPath = assertedPathFromClaim(claim.assertion);
  const results: Falsifier[] = [];

  if (claim.target?.kind === "workflow" || /workflow|CI|job|step|command/i.test(claim.assertion)) {
    const command = claim.target?.kind === "workflow" ? claim.target.command : commandFromAssertion(claim.assertion);
    const runIndex = lines.findIndex((line) => /^\s*(?:-\s*)?run\s*:/i.test(line) && (!command || line.includes(command) || enclosingRun(lines, line, lines.indexOf(line)).includes(command)));
    if (runIndex >= 0) {
      const step = scopedYamlItem(lines, runIndex);
      const job = scopedYamlJob(lines, runIndex);
      const stepDisabler = step.find((line) => /continue-on-error\s*:\s*true|if\s*:\s*(?:false|\$\{\{\s*false\s*\}\})|(?:skip|disabled)\s*:\s*true/i.test(line));
      const jobStart = lines.findIndex((line) => job.includes(line));
      const jobIndent = jobStart < 0 ? -1 : lineIndent(lines[jobStart]!);
      const jobDisabler = job.find((line) => lineIndent(line) <= jobIndent + 2 && /allow_failure\s*:\s*true|if\s*:\s*(?:false|\$\{\{\s*false\s*\}\})|(?:skip|disabled)\s*:\s*true/i.test(line));
      const disabler = stepDisabler ?? jobDisabler;
      if (disabler) results.push({ observationId: observation.id, scope: "same_subject", detail: disabler.trim() });
      const nearby = lines.find((line) => /continue-on-error\s*:\s*true|allow_failure\s*:\s*true|if\s*:\s*false/i.test(line));
      if (!disabler && nearby) results.push({ observationId: observation.id, scope: "ambiguous", detail: nearby.trim() });
    }
  }

  if (rule) {
    const escaped = escapeRegex(rule);
    const ruleIndex = lines.findIndex((line) => new RegExp(`\\b${escaped}\\b`, "i").test(line));
    const sectionStart = ruleIndex < 0 ? -1 : findLastIndex(lines.slice(0, ruleIndex + 1), (line) => /^\s*\[[^\]]+\]\s*$/.test(line));
    const header = sectionStart < 0 ? "" : lines[sectionStart]!;
    const previousPath = ruleIndex < 0 ? undefined : [...lines.slice(0, ruleIndex + 1)].reverse().find((line) => /["'][^"']+["']\s*=/.test(line));
    const ignore = ruleIndex < 0 ? undefined : /ignore|exclude|disable|noqa/i.test(header)
      ? lines[ruleIndex]
      : lines.find((line) => new RegExp(`(?:ignore|extend-ignore|per-file-ignores|exclude|disable|noqa)[^\\n]*\\b${escaped}\\b`, "i").test(line));
    if (ignore) {
      const subjectPath = assertedPath ?? pathFromClaim(claim);
      const scoped = subjectPath
        ? Boolean(previousPath && lineScopesToPath(previousPath, subjectPath))
        : isSingleRuleOverride(ignore, rule);
      results.push({ observationId: observation.id, scope: scoped ? "same_subject" : "ambiguous", detail: ignore.trim() });
    }
  }

  const configKey = claim.target?.kind === "config" ? claim.target.keyPath.split(".").at(-1) : undefined;
  if (configKey) {
    const disabledFlag = lines.find((line) =>
      new RegExp(`(?:^|[.\\s"'])${escapeRegex(configKey)}\\s*[:=]\\s*(?:false|0|off|no)\\b`, "i").test(line),
    );
    if (disabledFlag) results.push({ observationId: observation.id, scope: "same_subject", detail: disabledFlag.trim() });
  }

  const exception = lines.find((line) => /(?:exclude|ignore|skip|except|paths-ignore)\s*[:=]/i.test(line) && assertedPath && globMayMatch(line, assertedPath));
  if (exception) results.push({ observationId: observation.id, scope: "same_subject", detail: exception.trim() });

  return results;
}

function findDisconnectedHelper(claim: ClaimSpec, observations: readonly SourceObservation[]): Falsifier | undefined {
  const target = claim.target;
  if (target?.kind !== "workflow") return undefined;
  const rawPath = target.command.trim().replace(/^python(?:3)?\s+|^bash\s+|^sh\s+|^node\s+/i, "").replace(/^\.\//, "").split(/\s/)[0]!;
  if (!rawPath.startsWith("scripts/")) return undefined;
  const workflow = observations.find((observation) => observation.path === target.file && observation.excerpt?.includes(rawPath));
  const helper = observations.find((observation) => observation.path === rawPath && observation.excerpt !== undefined && observation.readStatus === "complete");
  if (!workflow || !helper || helper.id === workflow.id) return undefined;
  const executableLines = helper.excerpt!.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const noOp = executableLines.length > 0 && executableLines.every((line) => /^(?:pass\b|exit\s+0\b|raise\s+SystemExit\(0\)|echo\s+["']?(?:skip|disabled|todo)\b)/i.test(line));
  if (!noOp) return undefined;
  return { observationId: helper.id, scope: "same_subject", detail: `workflow references ${rawPath}, whose same-revision contents are an explicit no-op` };
}

function assertedRule(assertion: string): string | undefined {
  return assertion.match(/\b(?:rule|ruff|mypy|pyright|semgrep)\s*(?:code\s*)?([A-Z]{1,5}\d{1,5})\b/i)?.[1];
}

function assertedPathFromClaim(assertion: string): string | undefined {
  return assertion.match(/(?:for|on|in)\s+(?:path\s+)?[`"']?([\w./*-]+\.[\w*]+)[`"']?/i)?.[1];
}

function pathFromClaim(claim: ClaimSpec): string | undefined {
  if (claim.target?.kind === "config") return claim.target.file;
  if (claim.target?.kind === "workflow") return claim.target.file;
  return assertedPathFromClaim(claim.assertion);
}

function commandFromAssertion(assertion: string): string | undefined {
  return assertion.match(/(?:command|invocation)\s+["'`]?([^"'`]+?)["'`]?\s+(?:is|appears|runs)/i)?.[1]?.trim();
}

function scopedYamlItem(lines: string[], index: number): string[] {
  const indent = lineIndent(lines[index]!);
  let start = index;
  while (start > 0 && !(lineIndent(lines[start - 1]!) <= indent && /^\s*-\s/.test(lines[start - 1]!))) start -= 1;
  let end = index + 1;
  while (end < lines.length && !(/^\s*-\s/.test(lines[end]!) && lineIndent(lines[end]!) <= indent)) end += 1;
  return lines.slice(start, end);
}

function scopedYamlJob(lines: string[], index: number): string[] {
  const start = findLastIndex(lines.slice(0, index + 1), (line) => /^\s{2}[\w-]+\s*:\s*$/.test(line));
  if (start < 0) return [];
  const base = lineIndent(lines[start]!);
  let end = index + 1;
  while (end < lines.length && !(lineIndent(lines[end]!) <= base && /^\s{2}[\w-]+\s*:\s*$/.test(lines[end]!))) end += 1;
  return lines.slice(start, end);
}

function enclosingRun(lines: string[], line: string, index: number): string {
  void line;
  return scopedYamlItem(lines, index).join("\n");
}

function lineIndent(line: string): number { return line.match(/^\s*/)?.[0].length ?? 0; }
function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (predicate(items[index]!)) return index;
  return -1;
}
function isSingleRuleOverride(line: string, rule: string): boolean {
  const values = line.match(/[A-Z]{1,5}\d{1,5}/g) ?? [];
  return values.length === 1 && values[0]!.toLowerCase() === rule.toLowerCase();
}
function lineScopesToPath(line: string, path: string): boolean {
  const globs = line.match(/[\w./*-]+\.[\w*]+/g) ?? [];
  return globs.some((glob) => globMayMatch(glob, path));
}
function globMayMatch(globLine: string, path: string): boolean {
  const patterns = globLine.match(/[\w./*-]+\.[\w*]+/g) ?? [globLine];
  return patterns.some((pattern) => {
    const regex = `^${pattern.split("*").map(escapeRegex).join(".*")}$`;
    try { return new RegExp(regex).test(path); } catch { return false; }
  });
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function unique(values: string[]): string[] { return [...new Set(values)]; }
