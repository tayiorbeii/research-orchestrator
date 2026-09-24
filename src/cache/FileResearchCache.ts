import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchRun } from "../schemas/index.js";
import { ResearchRunSchema } from "../schemas/index.js";
import { redactObject } from "../core/redact.js";

/**
 * File-based research-run cache (docs/01_architecture.md §9).
 *
 * .research-cache/
 *   runs/<run-id>.json
 *   repos/owner__repo.json
 *   features/<feature-key>.json
 *
 * Everything written passes through redaction; full file contents are never
 * cached here — anchors and summaries only.
 */
export class FileResearchCache {
  constructor(private readonly rootDir: string = ".research-cache") {}

  private path(...segments: string[]): string {
    return join(this.rootDir, ...segments);
  }

  async saveRun(run: ResearchRun): Promise<string> {
    const dir = this.path("runs");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${sanitize(run.id)}.json`);
    await writeFile(file, JSON.stringify(redactObject(run), null, 2), "utf8");
    await this.indexFeature(run);
    return file;
  }

  async loadRun(runId: string): Promise<ResearchRun | undefined> {
    try {
      const raw = await readFile(this.path("runs", `${sanitize(runId)}.json`), "utf8");
      return ResearchRunSchema.parse(JSON.parse(raw));
    } catch {
      return undefined;
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

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
