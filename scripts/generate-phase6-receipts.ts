import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reviseBrief } from "../src/core/brief/reviseBrief.js";
import { BENCHMARK_TASKS } from "../src/eval/benchmarkTasks.js";
import { runEval } from "../src/eval/runEval.js";

const selected = [
  ["library-webhook-signature", "library-webhook-signature.json"],
  ["projection-rebuilding", "projection-vocabulary-round-trip.json"],
  ["review-tool-capabilities", "review-tool-capabilities.json"],
  ["underspecified-improvement", "underspecified-improvement.json"],
] as const;
const report = await runEval();
const outDir = join(process.cwd(), "examples/receipts");
await mkdir(outDir, { recursive: true });

for (const [id, filename] of selected) {
  const task = BENCHMARK_TASKS.find((item) => item.id === id)!;
  const metric = report.metrics.find((item) => item.taskId === id)!;
  const abstractRoundTrip = id === "projection-rebuilding" ? projectionVocabularyRoundTrip(task.brief) : undefined;
  const receipt = {
    synthetic: true,
    banner: "SYNTHETIC MOCK RECEIPT — NOT LIVE PROVIDER EVIDENCE",
    provenance: task.provenance,
    fixtureId: task.id,
    title: task.title,
    surface: task.surface,
    split: task.split,
    prompt: task.goal,
    ...(abstractRoundTrip ? { vocabularyRoundTrip: abstractRoundTrip } : {}),
    frozenCorpus: task.sources.map(({ id: sourceId, repo, path, content, relevance }) => ({ sourceId, repo, path, excerpt: content, label: relevance })),
    independentLabels: task.labels,
    result: metric,
    evaluationLane: "mock_replay",
  };
  await writeFile(join(outDir, filename), JSON.stringify(receipt, null, 2) + "\n", "utf8");
}

function projectionVocabularyRoundTrip(brief: (typeof BENCHMARK_TASKS)[number]["brief"]) {
  const sourceRef = "synthetic://vocabulary/projection-rebuilding";
  const draft = {
    ...brief,
    revision: 1,
    vocabulary: [],
    readiness: { status: "needs_input" as const, reasons: [{ code: "missing_vocabulary" as const, questionIds: ["projection"], detail: "Resolve the abstract projection mechanism into searchable terms." }] },
    lookupNeeds: [{ questionId: "projection", need: "vocabulary" as const, suggestedSourceKinds: ["documentation_page" as const], remainingAllowance: 1 }],
  };
  const termIds = ["projection-rebuild", "event-store-replay"];
  const revised = reviseBrief(draft, {
    terms: [
      { id: termIds[0], text: "rebuildProjection", questionIds: ["projection"], mechanismId: "projection-rebuild", kind: "symbol", origin: "remote_source_derived", sourceRefs: [sourceRef], status: "observed" },
      { id: termIds[1], text: "eventStore.readFrom", questionIds: ["projection"], mechanismId: "projection-rebuild", kind: "symbol", origin: "remote_source_derived", sourceRefs: [sourceRef], status: "observed" },
    ],
    lookupOutcomes: [{ questionId: "projection", sourceRef, status: "succeeded", termIdsGained: termIds, detail: "Synthetic fixture vocabulary mapping; no live lookup." }],
  });
  return {
    initialReadiness: draft.readiness.status,
    lookupSourceRef: sourceRef,
    lookupOutcome: "succeeded (synthetic vocabulary mapping)",
    revisedReadiness: revised.brief.readiness.status,
    revisedTerms: revised.brief.vocabulary.map((term) => ({ text: term.text, origin: term.origin, status: term.status, sourceRefs: term.sourceRefs })),
    issues: revised.issues.map((issue) => issue.code),
  };
}
