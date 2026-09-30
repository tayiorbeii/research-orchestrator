import type { ClaimAssessment, SourceObservation } from "../../schemas/researchContracts.js";
import { claimEvidenceOrigin, isAssessableObservation, RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION, SYNTHETIC_EVIDENCE_LIMITATION } from "../evidencePolicy.js";
import { renderTargetAssertion, type ClaimAssessor, type ClaimSpec } from "./types.js";

const assertionPattern = /^package\s+(.+?)\s+is declared at constraint\s+(.*?)\s+in file\s+(.+)$/i;
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function sameSubject(claim: ClaimSpec, observation: SourceObservation): boolean {
  return observation.repo === claim.subject.repo &&
    (claim.subject.revision === undefined || observation.resolvedRevision === claim.subject.revision);
}

function assessment(claim: ClaimSpec, status: ClaimAssessment["status"], ids: string[], rationale: string, limitations: string[], remaining: string[], observationOrigin?: SourceObservation["origin"]): ClaimAssessment {
  const evidenceOrigin = observationOrigin ? claimEvidenceOrigin({ origin: observationOrigin }) : undefined;
  return {
    claimId: claim.claimId,
    questionId: claim.questionId,
    subject: claim.subject,
    assertion: claim.assertion,
    requiredObservationIds: ids,
    status,
    method: "dependency_declaration",
    assessorOrigin: "engine",
    ...(evidenceOrigin ? { evidenceOrigin } : {}),
    evidencePolicyVersion: RESEARCH_RUN_V2_EVIDENCE_POLICY_VERSION,
    rationale,
    remainingObligations: remaining,
    limitations: evidenceOrigin === "synthetic" ? [...limitations, SYNTHETIC_EVIDENCE_LIMITATION] : limitations,
  };
}

export const dependencyDeclarationAssessor: ClaimAssessor = (claim, observations) => {
  if (claim.target && claim.assertion !== renderTargetAssertion(claim.target)) return assessment(claim, "unsupported", [], "assertion does not match structured target", ["The assertion must render the structured target exactly."], ["Use the canonical assertion rendered from the structured target."]);
  if (claim.target && claim.target.kind !== "dependency") return assessment(claim, "unsupported", [], "structured target does not match dependency assessor", [], ["Use a dependency target for dependency declaration assessment."]);
  const structured = claim.target?.kind === "dependency" ? claim.target : undefined;
  const match = structured ? undefined : claim.assertion.match(assertionPattern);
  if (!structured && !match) return assessment(claim, "unsupported", [], "The assertion does not use the narrow package declaration form understood by this assessor.", ["Only package name, literal constraint, and source file declarations are assessed."], ["Restate the claim as a package declaration fact."]);

  const assertedName = structured?.packageName ?? match![1]!;
  const assertedConstraint = structured ? structured.constraint : match![2]!;
  const assertedPath = structured ? structured.file : match![3]!;
  const matching = observations.filter((item) => sameSubject(claim, item) && (assertedPath === undefined || item.path === assertedPath) && item.excerpt !== undefined);
  if (matching.length === 0) return assessment(claim, "not_assessed", [], "No same-repository, matching-revision observation was available for the asserted file.", ["An exact resolved revision is required when the claim names one."], ["Read the asserted file at the claim's repository revision."]);
  if (!matching.some(isAssessableObservation)) return assessment(claim, "not_assessed", matching.map((item) => item.id), "Non-engine observations cannot produce engine-supported assessments.", ["Only engine or synthetic declaration observations are assessed."], ["Read the declaration from an engine-origin source observation."]);

  for (const observation of matching.filter(isAssessableObservation)) {
    const excerpt = observation.excerpt!;
    const limitations: string[] = [];
    let found = false;
    let parseable = false;

    if (assertedPath?.endsWith("package.json") || (assertedPath === undefined && observation.path?.endsWith("package.json"))) {
      try {
        const parsed: unknown = JSON.parse(excerpt);
        if (parsed !== null && typeof parsed === "object") {
          parseable = true;
          for (const section of sections) {
            const entries = (parsed as Record<string, unknown>)[section];
            if (entries !== null && typeof entries === "object" && !Array.isArray(entries)) {
              const entry = Object.entries(entries as Record<string, unknown>).find(([name]) => normalizePackageName(name) === normalizePackageName(assertedName));
              if (entry && typeof entry[1] === "string" && (assertedConstraint === undefined || entry[1] === assertedConstraint)) {
                found = true;
                const constraintDescription = assertedConstraint === undefined ? ` at observed constraint ${entry[1]}` : "";
                limitations.push(`Declaration was found in ${section}${constraintDescription}; this does not prove invocation, installation, or enforcement.`);
                break;
              }
            }
          }
        }
      } catch {
        limitations.push("package.json excerpt was not complete valid JSON.");
      }
    } else if (assertedPath?.endsWith("requirements.txt") || (assertedPath === undefined && observation.path?.endsWith("requirements.txt"))) {
      const lines = excerpt.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim().split(/\s+#/, 1)[0]!.trim();
        if (!line || line.startsWith("#")) continue;
        if (line.startsWith("-") || /^(?:https?:|git\+|file:)/i.test(line)) {
          limitations.push("requirements.txt includes an ignored include, option, or URL line; coverage may be incomplete.");
          continue;
        }
        const requirement = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9_,.-]+\])?\s*(.*)$/);
        if (!requirement) {
          limitations.push("requirements.txt includes a line outside the supported narrow format.");
          continue;
        }
        if (normalizePackageName(requirement[1]!) === normalizePackageName(assertedName) && (assertedConstraint === undefined || requirement[2]!.trim() === assertedConstraint)) {
          found = true;
          if (assertedConstraint === undefined) limitations.push(`Declaration was found at observed constraint ${requirement[2]!.trim() || "(none)"}.`);
        }
      }
      parseable = true;
      if (observation.readStatus === "partial") limitations.push("Only the returned requirements.txt excerpt was inspected.");
    } else {
      limitations.push("Only package.json and requirements.txt declarations are parsed.");
    }

    if (observation.readStatus === "partial") limitations.push("A partial read cannot establish absence outside the excerpt.");
    if (observation.revisionStatus !== "immutable") limitations.push("The observation revision is not established as immutable.");

    if (found) {
      const blocked = limitations.some((item) => item.includes("ignored include") || item.includes("outside the supported"));
      return assessment(claim, blocked ? "partial" : "supported", [observation.id], blocked
        ? "The excerpt contains the requested declaration, but its provenance or parser coverage prevents full engine support."
        : "The parsed declaration matches the package name and literal constraint in the same-subject observation.",
      limitations.length ? limitations : ["A declaration does not prove invocation, installation, or enforcement."], blocked ? ["Verify the remaining provenance or requirements-file coverage."] : [], observation.origin);
    }
    if (parseable && observation.readStatus === "complete") {
      const incompleteRequirementsCoverage = limitations.some((item) => item.includes("ignored include") || item.includes("outside the supported"));
      const status = !incompleteRequirementsCoverage ? "unsupported" : "partial";
      return assessment(claim, status, [observation.id], "The observed declaration file did not establish the asserted package and constraint; unsupported does not mean false.", [...limitations, "Declarations do not establish whether a package is invoked or enforced."], ["Inspect a complete same-revision declaration source or narrow the assertion."], observation.origin);
    }
    return assessment(claim, "partial", [observation.id], "The available excerpt or format does not establish the asserted declaration.", limitations.length ? limitations : ["The source could not be parsed safely."], ["Provide a complete supported-format declaration excerpt."], observation.origin);
  }
  return assessment(claim, "unsupported", matching.map((item) => item.id), "No matching declaration was found in the supplied same-subject observation.", ["Unsupported means the evidence does not establish the claim, not that it is false.", "Dependency presence never establishes invocation or enforcement."], ["Inspect the relevant declaration section and source context."]);
};
