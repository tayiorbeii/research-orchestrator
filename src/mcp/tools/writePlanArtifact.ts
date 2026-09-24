import { z } from "zod";
import { EvidenceAnchorSchema, ResearchRunSchema } from "../../schemas/index.js";
import { writeArtifacts } from "../../core/writeArtifacts.js";
import { FileResearchCache } from "../../cache/FileResearchCache.js";
import { ResearchError } from "../../core/errors.js";

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

  let run = parsed.researchRun;
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
    evidence: parsed.evidence,
    formats: parsed.formats,
  });

  const unresolvedQuestions = [
    ...new Set(run.scoredCandidates.flatMap((s) => s.missingProof.map((m) => `${s.repo}: ${m}`))),
  ];

  return {
    artifacts,
    summary: `Wrote ${artifacts.length} artifact(s) for run ${run.id} to ${parsed.outDir}.`,
    unresolvedQuestions,
  };
}
