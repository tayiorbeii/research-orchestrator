import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  BudgetLedgerSchema, BriefReadinessSchema, ProbeOutcomeSchema, ResearchBriefSchema,
  SearchProbeSchema, SearchProbeV2Schema, VocabularyTermSchema,
} from "../src/schemas/index.js";

const brief = {
  id: "brief-1", revision: 1, goal: "Find a server auth example",
  questions: [{ id: "q1", statement: "Where is auth configured?", intentHints: ["implementation_behavior"], required: true,
    answerScope: "One source-backed example.", obligations: [{ facts: [{ kind: "quotation", path: "src/auth.ts", signals: ["auth"] }], combine: "all", scope: "same_repository" }] }],
  mechanisms: [], vocabulary: [{ id: "v1", text: "auth", questionIds: ["q1"], kind: "symbol", origin: "user_supplied", status: "proposed" }],
  seeds: [], allowedSourceKinds: ["repository_file"], budgets: { maxQuestions: 6, queryUnits: 16, reconnaissanceReads: 4, fileReads: 48, fileReadsPerRepo: 12, refinementRounds: 1, refinementProbes: 4, deadlineMs: 60000 },
  readiness: { status: "needs_input", reasons: [{ code: "missing_vocabulary", questionIds: ["q1"], detail: "Need a package or symbol." }] }, lookupOutcomes: [],
};
const probe = { id: "p1", questionIds: ["q1"], mechanismIds: [], termIds: ["v1"], purpose: "source_location", intent: "Locate auth source", providerQuery: "auth",
  providerArgs: { query: "auth" }, expectedSourceKinds: ["repository_file"], expectedPaths: ["src/auth.ts"], capabilityVersion: "provider-v1", rationale: "Question-scoped source lookup.", alternativesLeftOpen: [], predecessorProbeIds: [] };
const outcome = { probeId: "p1", status: "succeeded", resultClass: "relevant_leads", basis: "One result matched the requested source path.", truncated: false, resultIds: ["org/repo:src/auth.ts"], queryUnits: 1, requestCount: 1, durationMs: 12, predecessorProbeIds: [] };
const ledger = { limits: { maxQuestions: 6, queryUnits: 16, reconnaissanceReads: 4, fileReads: 48, fileReadsPerRepo: 12, refinementRounds: 1, refinementProbes: 4, deadlineMs: 60000 },
  consumed: { queryUnits: 1, rpcCount: 1, reconnaissanceReads: 0, fileReads: 0, fileReadsByRepo: {}, refinementRounds: 0, refinementProbes: 0 }, cancelled: false };

describe("Phase 3 contracts", () => {
  it("keeps the legacy probe shape and accepts the needs_input brief", () => {
    expect(SearchProbeSchema.parse({ id: "old", kind: "high_precision", query: "auth", rationale: "legacy" }).id).toBe("old");
    expect(ResearchBriefSchema.parse(brief).readiness.status).toBe("needs_input");
    expect(BriefReadinessSchema.parse(brief.readiness).status).toBe("needs_input");
  });

  it("keeps each new Zod contract aligned with its JSON Schema sample", async () => {
    const files = ["research_brief.schema.json", "vocabulary_term.schema.json", "search_probe_v2.schema.json", "probe_outcome.schema.json", "budget_ledger.schema.json"];
    const docs = new Map<string, Record<string, unknown>>();
    for (const file of files) docs.set(file, JSON.parse(await readFile(new URL(`../schemas/${file}`, import.meta.url), "utf8")) as Record<string, unknown>);
    const vocabulary = brief.vocabulary[0];
    const samples: Array<[string, unknown, (value: unknown) => boolean]> = [
      ["research_brief.schema.json", brief, (v) => ResearchBriefSchema.safeParse(v).success],
      ["vocabulary_term.schema.json", vocabulary, (v) => VocabularyTermSchema.safeParse(v).success],
      ["search_probe_v2.schema.json", probe, (v) => SearchProbeV2Schema.safeParse(v).success],
      ["probe_outcome.schema.json", outcome, (v) => ProbeOutcomeSchema.safeParse(v).success],
      ["budget_ledger.schema.json", ledger, (v) => BudgetLedgerSchema.safeParse(v).success],
    ];
    for (const [file, value, zod] of samples) {
      expect(zod(value), `${file} Zod`).toBe(true);
      expect(matches(docs.get(file)!, value, docs), `${file} JSON Schema`).toBe(true);
    }
    expect(matches(docs.get("research_brief.schema.json")!, { ...brief, readiness: { status: "ready" } }, docs)).toBe(true);
    expect(ResearchBriefSchema.safeParse({ ...brief, readiness: { status: "ready" } }).success).toBe(true);
  });
});

function matches(schema: Record<string, unknown>, value: unknown, docs: Map<string, Record<string, unknown>>, document = schema): boolean {
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (ref.startsWith("#/")) return matches(ref.split("/").slice(1).reduce((at: unknown, key) => (at as Record<string, unknown>)[key.replaceAll("~1", "/").replaceAll("~0", "~")], document) as Record<string, unknown>, value, docs, document);
    const [file, fragment] = ref.split("#");
    const root = docs.get(file!);
    if (!root) return false;
    const target = fragment ? fragment.slice(2).split("/").reduce((at: unknown, key) => (at as Record<string, unknown>)[key], root) as Record<string, unknown> : root;
    return matches(target, value, docs, root);
  }
  if ("const" in schema && schema.const !== value) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.oneOf && !(schema.oneOf as Record<string, unknown>[]).some((child) => matches(child, value, docs, document))) return false;
  if (schema.anyOf && !(schema.anyOf as Record<string, unknown>[]).some((child) => matches(child, value, docs, document))) return false;
  if (schema.allOf && !(schema.allOf as Record<string, unknown>[]).every((child) => matches(child, value, docs, document))) return false;
  if (schema.if && matches(schema.if as Record<string, unknown>, value, docs, document) && schema.then && !matches(schema.then as Record<string, unknown>, value, docs, document)) return false;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if (((schema.required as string[] | undefined) ?? []).some((key) => !(key in object))) return false;
    const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [key, child] of Object.entries(props)) if (key in object && !matches(child, object[key], docs, document)) return false;
    if (schema.additionalProperties === false && Object.keys(object).some((key) => !(key in props))) return false;
    if (typeof schema.additionalProperties === "object") {
      for (const [key, entry] of Object.entries(object)) if (!(key in props) && !matches(schema.additionalProperties as Record<string, unknown>, entry, docs, document)) return false;
    }
    return true;
  }
  if (schema.type === "array") return Array.isArray(value) && value.length >= Number(schema.minItems ?? 0) && value.every((item) => matches(schema.items as Record<string, unknown>, item, docs, document));
  if (schema.type === "string") return typeof value === "string" && value.length >= Number(schema.minLength ?? 0);
  if (schema.type === "integer") return Number.isInteger(value) && Number(value) >= Number(schema.minimum ?? -Infinity);
  if (schema.type === "number") return typeof value === "number" && value >= Number(schema.minimum ?? -Infinity);
  if (schema.type === "boolean") return typeof value === "boolean";
  return true;
}
