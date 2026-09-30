# 10 Evaluation Benchmarks

## Purpose and lane boundaries

`npm run eval` runs a deterministic, offline replay over frozen synthetic
provider corpora. It does not contact GitHub, Octocode, DeepWiki, or another live
provider. The report labels this as `mock_replay`; a future live pilot must be
reported separately with provider versions, exact input, source revisions,
calls, cost, and limitations. A mock result is not evidence of live search
quality or global repository recall.

The evaluator runs through the v2 brief engine. The under-specified held-out
case goes through the same conservative goal adapter used by `find --goal`;
the CLI also retains separate tests for the actual `--goal` and `--brief`
commands.

## Frozen corpus

Each task in `src/eval/benchmarkTasks.ts` includes synthetic provider source
text, explicit negative and noisy candidates, provenance, a query-tuning split,
and independently authored labels for relevant sources, supported facts, and
expected question coverage. Labels are not derived from scorer output. The
corpus covers:

| Fixture | Task family | Split | Surface |
|---|---|---|---|
| `library-webhook-signature` | webhook-signature API invocation | tuning | v2 brief |
| `bounded-retry-cancellation` | bounded retry and cancellation | tuning | v2 brief |
| `projection-rebuilding` | projection rebuilding from events | tuning | v2 brief |
| `review-tool-capabilities` | docs advertised versus issue proposed | held out | v2 brief |
| `mixed-api-and-retry` | mixed library and behavior request | held out | v2 brief |
| `underspecified-improvement` | deliberately under-specified request | held out | legacy goal adapter |

The held-out fixtures are excluded from query-tuning iterations. The
feature-exploration fixture currently carries `knownDefect:
"source-kind-allowlists"`; retain its labels until the core fix is integrated.
Historical Phase 0 adversarial inputs live in
`tests/fixtures/research-integrity/` and stay as regression fixtures, not
positive evidence. `examples/sample_research_run.json` is a newly executed
synthetic v2 replay over the bundled mock candidate corpus, not an in-place
upgrade of its former legacy envelope. The original v1 sample bytes are
preserved at `tests/fixtures/research-integrity/historical-sample-run-v1.json`
for legacy detection tests; the historical incident goal fixture is unchanged.

## Metrics (reported independently)

The JSON report contains each measure by task and a total where aggregation is
meaningful. It does not combine them into one score.

| Measure | Definition |
|---|---|
| Useful-source discovery | Labeled relevant sources returned by search, grouped by question and intent, over relevant sources in the frozen corpus. |
| Supported-claim precision | Engine-supported claims matched against independent question, subject, and assertion labels; reports true, false, labeled counts, and precision. |
| Unsupported verification | Supported claims unmatched by labels plus answer-level verified overclaims. |
| Question coverage | Expected and actual status per question, satisfied count, required questions left `not_attempted`, and whether untouched labels match. |
| Cost | Logical query units and file reads from the v2 budget ledger; elapsed time to first useful read and to the run outcome. |
| Provider/run events | Provider failures, partial reads, budget stops, and `needs_input`/inconclusive abstentions. |
| Legacy round-trip losses | V2-only populated fields lost by the compatibility projection that can be parsed as a v1 envelope. |

The elapsed-time measurements are local replay timings, not service latency.
The fixed v2-to-v1 projection count describes information absent from that
legacy envelope; it does not rewrite or upgrade historical evidence.

## Hard regression rule

The designated adversarial set is the Phase 0 research-integrity fixture suite
plus every negative candidate in the six replay fixtures. It must produce zero
false supported/verified outputs. Positive replay fixtures must continue to
produce their independently labeled supported facts; an abstention-only
implementation fails this rule. A known defect is reported without weakening
the label, and the integration owner reruns the corpus after both lanes merge.

## Running and interpreting the report

The confirmed CLI syntax is:

```sh
npm run eval
npm run cli -- eval --out .research/eval-report.json
npm run eval:receipts
```

The only eval flag is optional `--out <file.json>`. The command prints JSON to
stdout and optionally writes the same report to the requested path. `--out` is
not a provider selection flag. Live evaluation is a separate authorized
operation and is not part of this command.

The report names the exact held-out fixture ids. Do not tune query construction
against those cases. Do not treat the small frozen corpus as broad recall
measurement or add accuracy/latency thresholds before a live baseline exists.

## Demo receipts

Committed examples in `examples/receipts/` show a precise library request, an
abstract request resolved through a vocabulary round trip, advertised versus
proposed feature exploration, and an intentionally inconclusive request. Each
receipt is synthetic and preserves its evidence scope and remaining gaps.
Regenerate them with `npm run eval:receipts`.

## Validation commands

```sh
npm test
npm run build
npm run eval
```

Provider smoke tests are integration checks and do not constitute permission to
run a paid or live research campaign.
