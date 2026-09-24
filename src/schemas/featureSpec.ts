import { z } from "zod";

export const ProofRequirementSchema = z.object({
  key: z.string().min(1),
  description: z.string(),
  required: z.boolean(),
  signals: z.array(z.string()).default([]),
});
export type ProofRequirement = z.infer<typeof ProofRequirementSchema>;

/**
 * Mirrors schemas/feature_spec.schema.json.
 * Required: featureKey, goal, feature, stack, requiredConcepts, proofRequirements.
 */
export const FeatureSpecSchema = z.object({
  featureKey: z.string().min(1),
  goal: z.string().min(1),
  feature: z.string().min(1),
  goalKind: z.enum(["application", "research"]).default("application"),
  stack: z.array(z.string()),
  libraries: z.array(z.string()).default([]),
  providers: z.array(z.string()).default([]),
  mustHave: z.array(z.string()).default([]),
  shouldHave: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  requiredConcepts: z.array(z.string()),
  likelyFiles: z.array(z.string()).default([]),
  proofRequirements: z.array(ProofRequirementSchema),
});
export type FeatureSpec = z.infer<typeof FeatureSpecSchema>;
