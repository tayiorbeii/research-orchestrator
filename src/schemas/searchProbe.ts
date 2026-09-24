import { z } from "zod";

export const SearchProbeKindSchema = z.enum([
  "high_precision",
  "recall",
  "path_targeted",
  "repo_search",
]);
export type SearchProbeKind = z.infer<typeof SearchProbeKindSchema>;

export const SearchProbeSchema = z.object({
  id: z.string().min(1),
  kind: SearchProbeKindSchema,
  query: z.string().min(1),
  rationale: z.string(),
  expectedSignals: z.array(z.string()).default([]),
});
export type SearchProbe = z.infer<typeof SearchProbeSchema>;
