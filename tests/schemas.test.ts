import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as exportedSchemas from "../src/schemas/index.js";
import {
  CandidateRepoSchema,
  ClaimAssessmentSchema,
  ClaimEvidenceOriginSchema,
  EvidenceAnchorSchema,
  EvidencePolicyVersionSchema,
  FeatureSpecSchema,
  RepoPatternExplanationSchema,
  ResearchRunV2Schema,
  SearchProbeSchema,
  ResearchBriefSchema,
} from "../src/schemas/index.js";

describe("schemas match the kit's JSON schema contracts", () => {
  it("covers every exported Zod schema's required keys and enums in JSON Schema contracts", async () => {
    const names = (await (await import("node:fs/promises")).readdir(new URL("../schemas/", import.meta.url))).filter((name) => name.endsWith(".schema.json"));
    const files = await Promise.all(names.map(async (name) => JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8")) as JsonSchemaNode));
    const nodes: JsonSchemaNode[] = [];
    for (const file of files) collectJsonSchemaNodes(file, nodes);
    const contracts = Object.entries(exportedSchemas).filter(([name, value]) => name.endsWith("Schema") && isZodSchema(value));
    expect(contracts.length).toBeGreaterThan(40);

    for (const [name, schema] of contracts) {
      const requiredGroups: string[][] = [];
      const enumGroups: unknown[][] = [];
      collectZodContract(schema, requiredGroups, enumGroups);
      for (const required of requiredGroups) {
        expect(nodes.some((node) => sameSet(node.required ?? [], required)), `${name} required keys: ${required.join(", ")}`).toBe(true);
      }
      for (const values of enumGroups) {
        expect(nodes.some((node) => sameSet(jsonEnumValues(node), values)), `${name} enum: ${JSON.stringify(values)}`).toBe(true);
      }
    }
  });

  it("keeps evidence policy version enums aligned across generated JSON schemas", async () => {
    const expected = [...EvidencePolicyVersionSchema.options];
    const [claimSchema, anchorSchema, runSchema] = await Promise.all([
      readFile(new URL("../schemas/claim_assessment.schema.json", import.meta.url), "utf8").then((raw) => JSON.parse(raw)),
      readFile(new URL("../schemas/evidence_anchor.schema.json", import.meta.url), "utf8").then((raw) => JSON.parse(raw)),
      readFile(new URL("../schemas/research_run.schema.json", import.meta.url), "utf8").then((raw) => JSON.parse(raw)),
    ]) as [{ properties: { evidencePolicyVersion: { enum: string[] }; evidenceOrigin: { enum: string[] } } }, { properties: { evidencePolicyVersion: { enum: string[] } } }, { properties: { evidencePolicyVersion: { enum: string[] }; explanations: { items: { properties: { evidencePolicyVersion: { enum: string[] } } } } } }];
    expect(claimSchema.properties.evidencePolicyVersion.enum).toEqual(expected);
    expect(claimSchema.properties.evidenceOrigin.enum).toEqual([...ClaimEvidenceOriginSchema.options]);
    expect(anchorSchema.properties.evidencePolicyVersion.enum).toEqual(expected);
    expect(runSchema.properties.evidencePolicyVersion.enum).toEqual(expected);
    expect(runSchema.properties.explanations.items.properties.evidencePolicyVersion.enum).toEqual(expected);

    const assessment = {
      claimId: "c1", questionId: "q1", subject: { repo: "org/repo" }, assertion: "claim", requiredObservationIds: [],
      status: "supported", method: "exact_source_quotation", assessorOrigin: "engine", evidencePolicyVersion: expected[0],
      rationale: "checked", remainingObligations: [], limitations: [],
    };
    expect(ClaimAssessmentSchema.safeParse(assessment).success).toBe(true);
    expect(validateSchemaShape(claimSchema, assessment)).toBe(true);
    expect(ClaimAssessmentSchema.safeParse({ ...assessment, evidencePolicyVersion: "unknown" }).success).toBe(false);
    expect(validateSchemaShape(claimSchema, { ...assessment, evidencePolicyVersion: "unknown" })).toBe(false);
  });

  it("accepts the example feature spec fixture", async () => {
    const raw = JSON.parse(
      await readFile(new URL("../examples/next_convex_magic_link.feature.json", import.meta.url), "utf8"),
    );
    expect(() => FeatureSpecSchema.parse(raw)).not.toThrow();
  });

  it("rejects unknown caller brief keys in both Zod and JSON Schema", async () => {
    const brief = {
      id: "strict-brief", revision: 1, goal: "Find an example",
      questions: [{ id: "q1", statement: "Where?", intentHints: ["implementation_behavior"], required: true, answerScope: "one", obligations: [{ facts: [{ kind: "quotation", signals: ["example"] }], combine: "all", scope: "same_repository" }] }],
      mechanisms: [], vocabulary: [], seeds: [], allowedSourceKinds: ["repository_file"],
      budgets: { maxQuestions: 6, queryUnits: 1, reconnaissanceReads: 1, fileReads: 1, fileReadsPerRepo: 1, refinementRounds: 0, refinementProbes: 0, deadlineMs: 1000 },
      readiness: { status: "ready" }, lookupOutcomes: [], unexpected: true,
    };
    const jsonSchema = JSON.parse(await readFile(new URL("../schemas/research_brief.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(ResearchBriefSchema.safeParse(brief).success).toBe(false);
    expect(validateSchemaShape(jsonSchema, brief)).toBe(false);
    expect(jsonSchema.additionalProperties).toBe(false);
  });

  it("accepts the example probes fixture", async () => {
    const raw = JSON.parse(
      await readFile(new URL("../examples/next_convex_magic_link.probes.json", import.meta.url), "utf8"),
    ) as Array<{ synthetic: boolean; provenance: string }>;
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((probe) => probe.synthetic && probe.provenance.includes("Illustrative"))).toBe(true);
    for (const probe of raw) expect(() => SearchProbeSchema.parse(probe)).not.toThrow();
  });

  it("accepts the sample research run candidates", async () => {
    const raw = JSON.parse(
      await readFile(new URL("../examples/sample_research_run.json", import.meta.url), "utf8"),
    ) as { candidates: unknown[]; schemaVersion: number; synthetic: boolean; provenance: string };
    expect(raw.schemaVersion).toBe(2);
    expect(raw.synthetic).toBe(true);
    expect(raw.provenance).toContain("not a conversion or upgrade");
    expect(ResearchRunV2Schema.safeParse(raw).success).toBe(true);
    for (const candidate of raw.candidates) {
      expect(() => CandidateRepoSchema.parse(candidate)).not.toThrow();
    }
  });

  it("rejects invalid feature specs", () => {
    expect(() => FeatureSpecSchema.parse({ goal: "x" })).toThrow();
    expect(() =>
      FeatureSpecSchema.parse({
        featureKey: "",
        goal: "x",
        feature: "y",
        stack: [],
        requiredConcepts: [],
        proofRequirements: [],
      }),
    ).toThrow();
  });

  it("rejects invalid evidence anchors", () => {
    expect(() =>
      EvidenceAnchorSchema.parse({
        id: "e1",
        provider: "not-a-provider",
        path: "a.ts",
        role: "x",
        proofLevel: "proved",
      }),
    ).toThrow();
    expect(() =>
      EvidenceAnchorSchema.parse({
        id: "e1",
        provider: "mock",
        path: "a.ts",
        role: "x",
        proofLevel: "proved",
        startLine: 0,
      }),
    ).toThrow();
  });

  it("validates a repository explanation against both Zod and the JSON Schema contract", async () => {
    const researchSchema = JSON.parse(
      await readFile(new URL("../schemas/research_run.schema.json", import.meta.url), "utf8"),
    ) as { properties: { explanations: { items: Record<string, unknown> } } };
    const explanationSchema = researchSchema.properties.explanations.items;
    const explanation = {
      repo: "acme/example",
      evidencePolicyVersion: "phase1_exact_quotation_v1",
      evidenceOrigin: "repository_observation",
      source: "hybrid",
      answers: [{ question: "Where?", answer: "Unassessed.", evidence: [], confidence: 0.5, verified: false }],
      implementationMap: {
        dependencies: [], files: [], serverFlow: [], clientFlow: [], environmentVariables: [], pitfalls: [],
      },
      warnings: [],
    };

    expect(RepoPatternExplanationSchema.parse(explanation)).toEqual(explanation);
    expect(validateSchemaShape(explanationSchema, explanation)).toBe(true);

    const missingSource = { ...explanation } as Record<string, unknown>;
    delete missingSource.source;
    expect(RepoPatternExplanationSchema.safeParse(missingSource).success).toBe(false);
    expect(validateSchemaShape(explanationSchema, missingSource)).toBe(false);
  });
});

type JsonSchemaNode = {
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  $defs?: Record<string, JsonSchemaNode>;
  definitions?: Record<string, JsonSchemaNode>;
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  additionalProperties?: JsonSchemaNode | boolean;
  if?: JsonSchemaNode;
  then?: JsonSchemaNode;
  else?: JsonSchemaNode;
  [key: string]: unknown;
};

function isZodSchema(value: unknown): value is { _def: Record<string, unknown>; isOptional(): boolean } {
  return Boolean(value && typeof value === "object" && "_def" in value && typeof (value as { safeParse?: unknown }).safeParse === "function");
}

function collectJsonSchemaNodes(node: JsonSchemaNode, output: JsonSchemaNode[]): void {
  output.push(node);
  for (const child of Object.values(node.properties ?? {})) collectJsonSchemaNodes(child, output);
  for (const child of [node.items, node.if, node.then, node.else, ...(node.oneOf ?? []), ...(node.anyOf ?? []), ...(node.allOf ?? []), ...Object.values(node.$defs ?? {}), ...Object.values(node.definitions ?? {})]) {
    if (child && typeof child === "object") collectJsonSchemaNodes(child, output);
  }
  if (node.additionalProperties && typeof node.additionalProperties === "object") collectJsonSchemaNodes(node.additionalProperties, output);
}

function collectZodContract(schema: unknown, requiredGroups: string[][], enumGroups: unknown[][], seen = new Set<unknown>()): void {
  if (!isZodSchema(schema) || seen.has(schema)) return;
  seen.add(schema);
  const def = schema._def;
  const kind = String(def.typeName ?? "");
  if (kind === "ZodObject") {
    const shapeValue = def.shape;
    const shape = (typeof shapeValue === "function" ? shapeValue() : shapeValue) as Record<string, unknown>;
    requiredGroups.push(Object.entries(shape).filter(([, child]) => isZodSchema(child) && !child.isOptional()).map(([key]) => key));
    Object.values(shape).forEach((child) => collectZodContract(child, requiredGroups, enumGroups, seen));
  } else if (kind === "ZodEnum" || kind === "ZodNativeEnum") {
    enumGroups.push((def.values ?? def.entries ? Object.values(def.values ?? def.entries as object) : []) as unknown[]);
  } else if (kind === "ZodLiteral") {
    const values = Array.isArray(def.value) ? def.value : [def.value];
    enumGroups.push(values);
  }
  for (const key of ["innerType", "type", "schema", "element", "valueType"]) {
    if (def[key]) collectZodContract(def[key], requiredGroups, enumGroups, seen);
  }
  const options = def.options;
  if (options instanceof Map) for (const child of options.values()) collectZodContract(child, requiredGroups, enumGroups, seen);
  else if (Array.isArray(options)) for (const child of options) collectZodContract(child, requiredGroups, enumGroups, seen);
}

function jsonEnumValues(node: JsonSchemaNode): unknown[] {
  if (Array.isArray(node.enum)) return node.enum;
  if ("const" in node) return [node.const];
  return [];
}

function sameSet(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length && [...left].every((item) => right.some((candidate) => JSON.stringify(candidate) === JSON.stringify(item)));
}

/** Small JSON Schema subset used to check the explanation contract without adding a dependency. */
function validateSchemaShape(schema: Record<string, unknown>, value: unknown): boolean {
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    const required = (schema.required as string[] | undefined) ?? [];
    if (required.some((key) => !(key in object))) return false;
    const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    if (schema.additionalProperties === false && Object.keys(object).some((key) => !(key in properties))) return false;
    return Object.entries(properties).every(([key, child]) =>
      !(key in object) || validateSchemaShape(child, object[key]),
    );
  }
  if (type === "array") {
    return Array.isArray(value) && value.every((item) => validateSchemaShape(schema.items as Record<string, unknown>, item));
  }
  if (type === "string") {
    const values = schema.enum as unknown[] | undefined;
    return typeof value === "string" && (!values || values.includes(value));
  }
  if (type === "number") {
    return typeof value === "number" && value >= Number(schema.minimum ?? -Infinity) && value <= Number(schema.maximum ?? Infinity);
  }
  if (type === "boolean") return typeof value === "boolean";
  return true;
}
