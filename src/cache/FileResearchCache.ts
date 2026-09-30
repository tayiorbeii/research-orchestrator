import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchRun } from "../schemas/index.js";
import { ResearchRunSchema, ResearchRunV2Schema, detectRunVersion } from "../schemas/index.js";
import { redactObject, redactResearchRun } from "../core/redact.js";
import {
  EVIDENCE_POLICY_VERSION,
  LEGACY_EVIDENCE_POLICY_VERSION,
  downgradeImportedAnchor,
  downgradeImportedScore,
} from "../core/evidencePolicy.js";

/**
 * File-based research-run cache (docs/01_architecture.md §9).
 *
 * .research-cache/
 *   runs/<run-id>.json
 *   repos/owner__repo.json
 *   features/<feature-key>.json
 *
 * Persisted observations contain redacted source excerpts (large reads are
 * reduced to bounded context); raw provider responses are not cached.
 */
export class FileResearchCache {
  constructor(private readonly rootDir: string = ".research-cache") {}

  private path(...segments: string[]): string {
    return join(this.rootDir, ...segments);
  }

  async saveRun(run: ResearchRun): Promise<string> {
    const completeRun = run.schemaVersion === 2 ? ResearchRunV2Schema.parse(run) : run;
    const versionedRun = {
      ...completeRun,
      ...("parentRunId" in run && typeof run.parentRunId === "string" ? { parentRunId: run.parentRunId } : {}),
      evidencePolicyVersion: completeRun.evidencePolicyVersion ?? LEGACY_EVIDENCE_POLICY_VERSION,
      evidenceOrigin: completeRun.evidenceOrigin ?? "legacy_unvalidated" as const,
    };
    const dir = this.path("runs");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${sanitize(run.id)}.json`);
    await writeFile(file, JSON.stringify(redactResearchRun(versionedRun as ResearchRun), null, 2), "utf8");
    await this.indexFeature(versionedRun);
    return file;
  }

  async loadRun(runId: string): Promise<ResearchRun> {
    const result = await this.loadRunDetailed(runId);
    if (result.status === "ok" || result.status === "legacy_v1") return result.run;
    throw new ResearchCacheReadError(result.status, result.message);
  }

  async loadRunDetailed(runId: string): Promise<
    | { status: "ok"; run: ResearchRun }
    | { status: "legacy_v1"; run: ResearchRun }
    | { status: "not_found"; message: string }
    | { status: "corrupt_json"; message: string }
    | { status: "unknown_schema_version"; message: string }
  > {
    let raw: string;
    try {
      raw = await readFile(this.path("runs", `${sanitize(runId)}.json`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "not_found", message: `Research run ${runId} was not found.` };
      return { status: "corrupt_json", message: `Could not read cached run ${runId}: ${(error as Error).message}` };
    }
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch {
      return { status: "corrupt_json", message: `Cached run ${runId} contains invalid JSON.` };
    }
    const version = detectRunVersion(decoded);
    if (version === "unknown") return { status: "unknown_schema_version", message: `Cached run ${runId} has an unknown schema version or envelope.` };
    try {
      const parsed = version === "v2" ? ResearchRunV2Schema.parse(decoded) : ResearchRunSchema.parse(decoded);
      const currentRun = version === "v2" || (version === "v1" && parsed.evidencePolicyVersion === EVIDENCE_POLICY_VERSION);
      // Trust boundary: cache records are engine-written; caller inputs are downgraded at MCP boundaries (§5.5).
      // Legacy normalization is a read-only view; never rewrite original bytes.
      const run = {
        ...parsed,
        ...(typeof (decoded as Record<string, unknown>).parentRunId === "string" ? { parentRunId: (decoded as Record<string, unknown>).parentRunId } : {}),
        evidencePolicyVersion: currentRun ? parsed.evidencePolicyVersion : LEGACY_EVIDENCE_POLICY_VERSION,
        evidenceOrigin: parsed.evidenceOrigin ?? LEGACY_EVIDENCE_POLICY_VERSION,
        scoredCandidates: currentRun
          ? parsed.scoredCandidates
          : parsed.scoredCandidates.map(downgradeImportedScore),
        candidates: parsed.candidates.map((candidate) => ({
          ...candidate,
          candidateSignals: candidate.candidateSignals.map((signal) => ({
            ...signal,
            confidence: currentRun ? signal.confidence : Math.min(signal.confidence, 0.49),
            evidence: signal.evidence?.map((anchor) =>
              currentRun && anchor.evidencePolicyVersion === EVIDENCE_POLICY_VERSION
                ? anchor
                : downgradeImportedAnchor(anchor),
            ),
          })),
        })),
        explanations: parsed.explanations.map((explanation) => {
          const currentExplanation =
            currentRun && explanation.evidencePolicyVersion === EVIDENCE_POLICY_VERSION;
          return {
            ...explanation,
            evidencePolicyVersion: currentExplanation
              ? explanation.evidencePolicyVersion
              : LEGACY_EVIDENCE_POLICY_VERSION,
            answers: explanation.answers.map((answer) => ({
              ...answer,
              verified: false,
              confidence: currentExplanation ? answer.confidence : Math.min(answer.confidence, 0.5),
              evidence: answer.evidence.map((anchor) =>
                currentExplanation && anchor.evidencePolicyVersion === EVIDENCE_POLICY_VERSION
                  ? anchor
                  : downgradeImportedAnchor(anchor),
              ),
            })),
            implementationMap: {
              ...explanation.implementationMap,
              files: explanation.implementationMap.files.map((file) => ({
                ...file,
                evidence: file.evidence.map((anchor) =>
                  currentExplanation && anchor.evidencePolicyVersion === EVIDENCE_POLICY_VERSION
                    ? anchor
                    : downgradeImportedAnchor(anchor),
                ),
              })),
            },
          };
        }),
      } as ResearchRun;
      return version === "v1" ? { status: "legacy_v1", run } : { status: "ok", run };
    } catch (error) {
      return { status: "corrupt_json", message: `Cached run ${runId} does not match its schema: ${(error as Error).message}` };
    }
  }

  async saveRepoNotes(repo: string, notes: unknown): Promise<string> {
    const dir = this.path("repos");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${sanitize(repo.replace("/", "__"))}.json`);
    await writeFile(file, JSON.stringify(redactObject(notes), null, 2), "utf8");
    return file;
  }

  async loadRepoNotes(repo: string): Promise<unknown | undefined> {
    try {
      const raw = await readFile(
        this.path("repos", `${sanitize(repo.replace("/", "__"))}.json`),
        "utf8",
      );
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private async indexFeature(run: ResearchRun): Promise<void> {
    const dir = this.path("features");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${sanitize(run.featureSpec.featureKey)}.json`);
    let existing: { runs: string[] } = { runs: [] };
    try {
      existing = JSON.parse(await readFile(file, "utf8")) as { runs: string[] };
    } catch {
      // first run for this feature
    }
    if (!existing.runs.includes(run.id)) existing.runs.push(run.id);
    await writeFile(file, JSON.stringify(existing, null, 2), "utf8");
  }

  async clear(): Promise<void> {
    await rm(this.rootDir, { recursive: true, force: true });
  }
}

export class ResearchCacheReadError extends Error {
  constructor(readonly code: "not_found" | "corrupt_json" | "unknown_schema_version", message: string) {
    super(message);
    this.name = "ResearchCacheReadError";
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
