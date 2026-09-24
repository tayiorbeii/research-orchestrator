import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runResearch } from "../core/pipeline.js";
import { writeArtifacts } from "../core/writeArtifacts.js";
import { MockEvidenceProvider } from "../adapters/MockEvidenceProvider.js";
import { BENCHMARK_TASKS, type BenchmarkTask } from "./benchmarkTasks.js";

/** Metrics model from docs/10_eval_benchmarks.md. */
export interface ResearchRunMetrics {
  taskId: string;
  lane: string;
  wallMs: number;
  toolCalls: number;
  providerCalls: number;
  candidateRepos: number;
  provedRepos: number;
  falsePositiveRepos: number;
  exactEvidenceAnchors: number;
  artifactCompletenessScore: number;
  humanCorrectionCount: number;
}

export interface EvalReport {
  lane: string;
  createdAt: string;
  metrics: ResearchRunMetrics[];
}

export interface RunEvalOptions {
  tasks?: BenchmarkTask[];
  outFile?: string;
  lane?: string;
}

/** Run the mock benchmark lane and save metrics as JSON. */
export async function runEval(options: RunEvalOptions = {}): Promise<EvalReport> {
  const lane = options.lane ?? "orchestrator_mock";
  const tasks = (options.tasks ?? BENCHMARK_TASKS).filter((t) => t.mockReady);
  const metrics: ResearchRunMetrics[] = [];

  for (const task of tasks) {
    const started = Date.now();
    const provider = new MockEvidenceProvider();
    const { run, evidence, pattern } = await runResearch({
      goal: task.goal,
      provider,
      deterministic: true,
    });
    const artifactDir = join(tmpdir(), `ro-eval-${task.id}-${Date.now()}`);
    await writeArtifacts(run, artifactDir, { evidence, pattern });
    const research = await readFile(join(artifactDir, "research.md"), "utf8");

    metrics.push({
      taskId: task.id,
      lane,
      wallMs: Date.now() - started,
      toolCalls: 0,
      providerCalls: run.candidates.length + 1,
      candidateRepos: run.candidates.length,
      provedRepos: run.scoredCandidates.filter(
        (s) => s.score >= 0.7 && evidence.some((a) => a.repo === s.repo && a.proofLevel === "proved"),
      ).length,
      falsePositiveRepos: run.scoredCandidates.filter((s) => s.class === "false_positive").length,
      exactEvidenceAnchors: evidence.filter((a) => a.proofLevel === "proved").length,
      artifactCompletenessScore: completenessScore(research, evidence.length, run.selectedRepos.length),
      humanCorrectionCount: 0,
    });
  }

  const report: EvalReport = { lane, createdAt: new Date().toISOString(), metrics };
  if (options.outFile) {
    await mkdir(join(options.outFile, ".."), { recursive: true });
    await writeFile(options.outFile, JSON.stringify(report, null, 2), "utf8");
  }
  return report;
}

/**
 * Completeness rubric (0-5) approximation from docs/10_eval_benchmarks.md:
 * required sections present, evidence anchors captured, repos selected.
 */
export function completenessScore(
  researchMd: string,
  anchorCount: number,
  selectedCount: number,
): number {
  let score = 0;
  const requiredSections = [
    "## Selected repositories",
    "## Candidate analysis",
    "## Implementation pattern",
    "## Evidence map",
    "## Pitfalls",
    "## Open questions",
  ];
  const present = requiredSections.filter((s) => researchMd.includes(s)).length;
  if (present >= 4) score += 2;
  else if (present >= 2) score += 1;
  if (anchorCount >= 3) score += 2;
  else if (anchorCount >= 1) score += 1;
  if (selectedCount >= 1) score += 1;
  return Math.min(score, 5);
}
