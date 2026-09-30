import type { ClaimAssessment, SourceObservation } from "../../schemas/researchContracts.js";
import { claimEvidenceOrigin, isAssessableObservation, RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION, SYNTHETIC_EVIDENCE_LIMITATION } from "../evidencePolicy.js";
import { renderTargetAssertion, type ClaimAssessor, type ClaimSpec } from "./types.js";

const assertionPattern = /^workflow command\s+(.+?)\s+(?:appears on a run: line|is present)\s+in file\s+(.+)$/i;

function sameSubject(claim: ClaimSpec, observation: SourceObservation): boolean {
  return observation.repo === claim.subject.repo &&
    (claim.subject.revision === undefined || observation.resolvedRevision === claim.subject.revision);
}

function result(claim: ClaimSpec, status: ClaimAssessment["status"], ids: string[], rationale: string, limitations: string[], remaining: string[], observationOrigin?: SourceObservation["origin"]): ClaimAssessment {
  const evidenceOrigin = observationOrigin ? claimEvidenceOrigin({ origin: observationOrigin }) : undefined;
  return {
    claimId: claim.claimId,
    questionId: claim.questionId,
    subject: claim.subject,
    assertion: claim.assertion,
    requiredObservationIds: ids,
    status,
    method: "workflow_command",
    assessorOrigin: "engine",
    ...(evidenceOrigin ? { evidenceOrigin } : {}),
    evidencePolicyVersion: RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION,
    rationale,
    remainingObligations: remaining,
    limitations: evidenceOrigin === "synthetic" ? [...limitations, SYNTHETIC_EVIDENCE_LIMITATION] : limitations,
  };
}

function indent(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function scopedStep(lines: string[], runIndex: number): string[] | undefined {
  const runIndent = indent(lines[runIndex]!);
  let start = -1;
  for (let index = runIndex; index >= 0; index--) {
    if (/^\s*-\s/.test(lines[index]!) && indent(lines[index]!) <= runIndent) {
      start = index;
      break;
    }
  }
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = runIndex + 1; index < lines.length; index++) {
    if (/^\s*-\s/.test(lines[index]!) && indent(lines[index]!) === indent(lines[start]!)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end);
}

export const workflowCommandAssessor: ClaimAssessor = (claim, observations) => {
  if (claim.target && claim.assertion !== renderTargetAssertion(claim.target)) return result(claim, "unsupported", [], "assertion does not match structured target", ["The assertion must render the structured target exactly."], ["Use the canonical assertion rendered from the structured target."]);
  if (claim.target && claim.target.kind !== "workflow") return result(claim, "unsupported", [], "structured target does not match workflow assessor", [], ["Use a workflow target for workflow command assessment."]);
  const structured = claim.target?.kind === "workflow" ? claim.target : undefined;
  const match = structured ? null : claim.assertion.match(assertionPattern);
  if (!structured && !match) return result(claim, "unsupported", [], "The assertion does not use the narrow workflow command form understood by this assessor.", ["Claims are limited to command text on a workflow run: line."], ["Restate the claim as a workflow run command presence fact."]);
  const command = structured?.command ?? match![1]!;
  const path = structured?.file ?? match?.[2];
  const matching = observations.filter((item) => sameSubject(claim, item) && (path === undefined || item.path === path) && item.excerpt !== undefined);
  if (matching.length === 0) return result(claim, "not_assessed", [], "No same-repository, matching-revision observation was available for the asserted workflow file.", ["A claim naming a revision requires an observation resolved to that revision."], ["Read the asserted workflow excerpt at the claim's repository revision."]);
  if (!matching.some(isAssessableObservation)) return result(claim, "not_assessed", matching.map((item) => item.id), "Non-engine observations cannot produce engine-supported assessments.", ["Only engine or synthetic workflow observations are assessed."], ["Read the workflow from an engine-origin source observation."]);

  for (const observation of matching.filter(isAssessableObservation)) {
    const lines = observation.excerpt!.split(/\r?\n/);
    const commandNeedle = command.trim().replace(/["']/g, "");
    const runIndices = lines.flatMap((line, index) => /^\s*(?:-\s*)?run\s*:\s*(.*)$/i.test(line) ? [index] : []);
    const matchingIndex = runIndices.find((index) => {
      const inline = lines[index]!.match(/^\s*(?:-\s*)?run\s*:\s*(.*)$/i)?.[1]?.trim() ?? "";
      if (inline && inline !== "|" && inline !== ">") return inline.replace(/["']/g, "").includes(commandNeedle);
      let block = "";
      for (let offset = index + 1; offset < lines.length; offset++) {
        if (lines[offset]!.trim() && indent(lines[offset]!) <= indent(lines[index]!)) break;
        block += `\n${lines[offset]}`;
      }
      return block.replace(/["']/g, "").includes(commandNeedle);
    });
    if (matchingIndex === undefined) {
      const limitations = ["no safe parser installed; quotation only", "Workflow conditions and runtime execution are not assessed."];
      const status = observation.readStatus === "partial" ? "partial" : "unsupported";
      return result(claim, status, [observation.id], "No matching run: command was found in the observed excerpt; unsupported does not mean false.", limitations, ["Inspect a complete workflow excerpt containing the requested run: line."], observation.origin);
    }

    const step = scopedStep(lines, matchingIndex);
    const concernLines = lines.filter((line) => /continue-on-error\s*:\s*true|if\s*:\s*false/i.test(line));
    const scopedConcerns = step?.filter((line) => /continue-on-error\s*:\s*true|if\s*:\s*false/i.test(line)) ?? [];
    const limitations = ["no safe parser installed; quotation only", "Triggers, conditions, continue-on-error, and runtime execution are not fully parsed."];
    if (observation.readStatus === "partial") limitations.push("Only the returned bounded excerpt was inspected; omitted step context may change interpretation.");
    if (observation.revisionStatus !== "immutable") limitations.push("The observation revision is not established as immutable.");

    if (scopedConcerns.length > 0) {
      return result(claim, "contradicted", [observation.id], "The command is present, but the same unambiguously scoped workflow step disables it or allows failure.", [...limitations, `Same-step condition: ${scopedConcerns.map((line) => line.trim()).join("; ")}`], ["Separate command presence from whether the workflow executes or enforces it."], observation.origin);
    }
    if (concernLines.length > 0 && scopedConcerns.length === 0) limitations.push("A disable/allowed-failure condition appears in the excerpt, but its relationship to this command is ambiguous.");
    return result(claim, "partial", [observation.id], "The command text appears on a run: line; this assessor cannot establish workflow execution or full enforcement.", limitations, ["Assess the step's triggers and conditions with a workflow-aware parser."], observation.origin);
  }
  return result(claim, "unsupported", matching.map((item) => item.id), "No supplied workflow observation established the asserted command.", ["Unsupported means the supplied evidence does not establish the claim."], ["Inspect the relevant workflow run: step."]);
};
