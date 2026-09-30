# Live pilot: GitHub, Python pre-review checks (2026-09-29)

Phase 6 of `plans/research-framing-and-evidence-integrity.md` calls for one bounded,
authorized live pilot. This is its record: the exact brief, provider, calls, outcomes,
and limitations for each attempt. The pilot found five defects that the mock fixtures
could not; each was fixed with a regression test before the next attempt.

## Setup

- **Provider:** `--mode github`, GitHub REST through the existing `gh` login (read-only public search and contents). No paid model calls.
- **Runtime:** Node v24.14.1, gh 2.100.0, kit `main`. Code search is rate-limited to 10 requests per minute, so the budgets were set low.
- **Topic:** the original incident's topic (deterministic Python pre-review checks), restated as a host-written brief with caller-supplied vocabulary (`ruff`, `mypy`, `diff-cover`, `.pre-commit-config.yaml`).
- **Why the brief was hand-written:** `find --goal` turns this goal into one question that needs all seven terms in a single excerpt. That is the conservative legacy adapter behaving as designed. The skill tells hosts to write briefs.

Brief (abridged):

| Question | Obligation fact |
|---|---|
| `q_ruff`: a repository runs ruff from `.pre-commit-config.yaml` | quotation, path `.pre-commit-config.yaml`, signals `["ruff"]`, scope `implemented` |
| `q_mypy`: a repository runs mypy from `.pre-commit-config.yaml` | quotation, path `.pre-commit-config.yaml`, signals `["mypy"]`, scope `implemented` |
| `q_diffcover`: a GitHub Actions workflow invokes diff-cover | workflow command `diff-cover` |

Budgets: `queryUnits: 8`, `fileReads: 16`, `fileReadsPerRepo: 4`, `refinementRounds: 1` (2 probes), `deadlineMs: 60000`. Raising the deadline to 120 s was correctly rejected as `budget_explicitly_raised`.

## Attempts

| # | Result | Defect found | Fix |
|---|---|---|---|
| 1 | Crash while writing artifacts (`JSON.parse` in `redactObject`) | Redaction ran regexes over serialized JSON. A live excerpt containing `GH_TOKEN="…"` had its escaped quote consumed. The same text-level pass also matched across escaped `\n` and silently deleted evidence text (the golden README excerpt had lost its `SITE_URL` line). | `a5352c9`: structural redaction; secret references such as `${{ secrets.X }}` kept verbatim. |
| 1b | Setup: a host-written brief with user-supplied terms flipped to `needs_input` on revision | `reviseBrief` counted only source-backed terms toward readiness, even though §7.1 ranks caller-supplied terms first. | `d62ed9d` |
| 2 | `inconclusive`; hits in `NEWS`, `CHANGES`, `TODO.md` | The probe compiler ignored obligation paths as qualifiers (bare `ruff` queries). v2 probe details were not persisted, and `evidence.json` lacked probes, outcomes, and the ledger. | `10e1fa5`: `ruff filename:.pre-commit-config.yaml` and similar; full probe persistence; complete `evidence.json`. |
| 2b | Engine said `partial`, while `evidence.json` said `inconclusive` with every question unresolved | Artifacts re-derived coverage from the FeatureSpec projection, whose question IDs never match brief assessments (an R14 violation). | `362a8aa`: shared pure `deriveBriefCoverage`. |
| 2c | A read was spent on the directory `scripts` | `bash scripts/ci/self-hosted/diff-cover.sh` was truncated to its first path segment. | `d8de9af` |
| 2d | All observations had revision `unknown` | The GitHub adapter never resolved a commit (§7.4). | `23b4de5`: default branch resolved to a SHA once per repo; reads and URLs pinned to it. |
| 3 | **`partial`**, consistent across the CLI receipt, `evidence.json`, and a cached re-render | — | — |

## Final attempt (3)

- **Probes:** `ruff filename:.pre-commit-config.yaml`, `mypy filename:.pre-commit-config.yaml`, `diff-cover path:.github/workflows`, plus one broad `ruff` fallback. All four succeeded (`relevant_leads`).
- **Ledger:** 4 query units, 16 file reads, 70 RPCs = 4 searches + 16 reads + 50 metadata and revision-resolution calls (25 candidates × 2). The metadata calls are reported as `unbudgetedMetadataCalls`.
- **Coverage:** `q_ruff` satisfied (5 repositories), `q_mypy` satisfied (5), `q_diffcover` unresolved. The outcome is `partial`: no single repository satisfied all three, and composite completion requires one.
- **Provenance:** all 37 observations are `immutable`; every supported claim is pinned to a commit SHA and cites a SHA URL.

Supported claims. Each means only "the pinned `.pre-commit-config.yaml` states the tool name". None proves the hook runs in CI or blocks merges.

| Question | Repository | Revision |
|---|---|---|
| q_ruff | nunchux-ai/ComfyUI-nunchaku | `b600f879a777` |
| q_ruff | uniswap-python/uniswap-python | `bc8fdf4b915e` |
| q_ruff | uselotus/lotus | `9c4fe5daa746` |
| q_ruff | curiousily/AI-Bootcamp | `8c98b756c284` |
| q_ruff | scipy-lectures/scientific-python-lectures | `817a97d8d9a2` |
| q_mypy | scipy-lectures/scientific-python-lectures | `817a97d8d9a2` |
| q_mypy | psycopg/psycopg | `3d43a1a2420f` |
| q_mypy | Dineshkarthik/telegram_media_downloader | `859272a8111b` |
| q_mypy | automl/SMAC3 | `841488796a82` |
| q_mypy | protectai/modelscan | `61fcec9c2a37` |

Two claims were checked independently against GitHub at their pinned SHAs: `id: ruff` at line 29 of the first repository's config, and `id: mypy` at line 44 of scipy-lectures'.

## Comparison with the original incident

The original first pass (recorded in the external incident file, not copied here) generated probes such as `"proven" "repository"` and selected zero repositories. The second pass anchored mainly on ignore files and changelogs. On the same topic this pilot issued only anchored, qualified probes, read the relevant configuration files, and returned ten narrow, pinned, independently checkable facts. It reported the diff-cover question as unresolved rather than inventing an answer.

This is one pilot on one topic, not a measure of live recall or ranking quality.

## Limitations

- `q_diffcover` is unresolved. The only diff-cover hits either invoked a wrapper script (`scripts/ci/self-hosted/diff-cover.sh`) or had no `run:` line naming the command. The workflow assessor never goes beyond `partial` without a YAML parser, by design.
- Supported claims are quotation-scoped. Whether the hooks run in CI, or block merges, was not assessed.
- Metadata calls are counted but have no separate limit.
- A single host-written brief was used. `find --goal` for this topic is intentionally too strict to produce support.
- Pilot outputs stayed in a session scratch directory. No private incident data or credentials were copied into the repository.
