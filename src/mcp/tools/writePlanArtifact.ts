import { z } from "zod";
import { EvidenceAnchorSchema, ResearchRunSchema, type ResearchRun } from "../../schemas/index.js";
import { writeArtifacts } from "../../core/writeArtifacts.js";
import { FileResearchCache } from "../../cache/FileResearchCache.js";
import { ResearchError } from "../../core/errors.js";
import { LEGACY_EVIDENCE_POLICY_VERSION, downgradeImportedAnchor, downgradeImportedScore } from "../../core/evidencePolicy.js";
import { deriveCoverage } from "../../core/assessment/coverage.js";

export const writePlanArtifactInputShape = {
  runId: z.string().optional().describe("Id of a cached research run."),
  researchRun: ResearchRunSchema.optional().describe("Inline research run (overrides runId)."),
  evidence: z.array(EvidenceAnchorSchema).optional(),
  outDir: z.string().min(1),
  formats: z
    .array(z.enum(["research_md", "plan_md", "evidence_json", "checklist_md"]))
    .optional(),
  targetProject: z
    .object({
      stack: z.array(z.string()).optional(),
      constraints: z.array(z.string()).optional(),
      existingFiles: z.array(z.string()).optional(),
    })
    .optional(),
};

const InputSchema = z.object(writePlanArtifactInputShape);
export type WritePlanArtifactInput = z.infer<typeof InputSchema>;

/** research.writePlanArtifact — write markdown/JSON artifacts from a run. */
export async function writePlanArtifact(input: WritePlanArtifactInput) {
  const parsed = InputSchema.parse(input);

  let run = parsed.researchRun
    ? downgradeInlineRun(parsed.researchRun)
    : undefined;
  if (!run && parsed.runId) {
    run = await new FileResearchCache().loadRun(parsed.runId);
  }
  if (!run) {
    throw new ResearchError(
      "artifact_write_failed",
      "No research run provided: pass researchRun inline or a runId of a cached run.",
      {
        recoverable: true,
        suggestedAction: "Call research.findImplementations first, then pass its runId.",
      },
    );
  }

  const artifacts = await writeArtifacts(run, parsed.outDir, {
    evidence: parsed.evidence?.map(downgradeImportedAnchor),
    formats: parsed.formats,
  });

  const unresolvedQuestions = [
    ...new Set(run.scoredCandidates.flatMap((s) => s.missingProof.map((m) => `${s.repo}: ${m}`))),
  ];
  const receipt = run.schemaVersion === 2 && run.observations && run.assessments && run.candidateStates
    ? deriveCoverage({
        spec: run.featureSpec, candidates: run.candidates.map((candidate) => candidate.repo),
        states: run.candidateStates, observations: run.observations, assessments: run.assessments,
      })
    : undefined;

  return {
    artifacts,
    summary: `Wrote ${artifacts.length} artifact(s) for run ${run.id} to ${parsed.outDir}.`,
    unresolvedQuestions,
    ...(receipt ? {
      coverage: receipt.coverage,
      outcome: {
        ...receipt.outcome,
        reasons: [...new Set([...receipt.outcome.reasons, ...(run.outcome?.reasons ?? [])])],
      },
    } : {}),
  };
}

export function downgradeInlineRun(run: ResearchRun): ResearchRun {
  return {
    ...run,
    evidencePolicyVersion: run.schemaVersion === 2 ? run.evidencePolicyVersion : LEGACY_EVIDENCE_POLICY_VERSION,
    ...(run.schemaVersion === 2 ? {
      observations: (run.observations ?? []).map((observation) => ({ ...observation, origin: "external" as const })),
      assessments: (run.assessments ?? []).map((assessment) => {
        const { evidenceOrigin: _evidenceOrigin, ...rest } = assessment;
        return { ...rest, assessorOrigin: "external" as const };
      }),
      candidateStates: (run.candidateStates ?? []).map((candidate) => ({
        ...candidate,
        ...(candidate.state === "eligible" ? { state: "ineligible" as const, reason: "Inline candidate disposition is externally asserted." } : {}),
      })),
      explanationResults: (run.explanationResults ?? []).map((result) => result.status === "succeeded"
        ? { ...result, explanation: downgradeExplanation(result.explanation) }
        : result),
    } : {}),
    scoredCandidates: run.scoredCandidates.map(downgradeImportedScore),
    candidates: run.candidates.map((candidate) => ({
      ...candidate,
      candidateSignals: candidate.candidateSignals.map((signal) => ({
        ...signal,
        confidence: Math.min(signal.confidence, 0.49),
        evidence: signal.evidence?.map(downgradeImportedAnchor),
      })),
    })),
    explanations: run.explanations.map(downgradeExplanation),
  };
}

function downgradeExplanation(explanation: ResearchRun["explanations"][number]): ResearchRun["explanations"][number] {
  return {
    ...explanation,
    evidencePolicyVersion: LEGACY_EVIDENCE_POLICY_VERSION,
    answers: explanation.answers.map((answer) => ({
      ...answer,
      verified: false,
      confidence: Math.min(answer.confidence, 0.5),
      evidence: answer.evidence.map(downgradeImportedAnchor),
    })),
    implementationMap: {
      ...explanation.implementationMap,
      files: explanation.implementationMap.files.map((file) => ({
        ...file,
        evidence: file.evidence.map(downgradeImportedAnchor),
      })),
    },
  };
}
