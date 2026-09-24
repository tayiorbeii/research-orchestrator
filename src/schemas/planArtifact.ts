import { z } from "zod";
import { EvidenceAnchorSchema } from "./evidenceAnchor.js";

/** Mirrors schemas/plan_artifact.schema.json. */
export const PlanArtifactSchema = z.object({
  feature: z.string().min(1),
  summary: z.string().optional(),
  files: z.array(
    z.object({
      path: z.string().min(1),
      role: z.string().min(1),
      action: z.enum(["create", "modify", "inspect", "delete"]).optional(),
    }),
  ),
  implementationSteps: z.array(z.string()),
  environmentVariables: z.array(z.string()).default([]),
  tests: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  evidence: z.array(EvidenceAnchorSchema),
});
export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;
