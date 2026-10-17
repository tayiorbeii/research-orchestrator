# 01 Architecture

## System overview

There is one execution path. A caller writes a **research brief** (questions with
obligations made of facts); a bare goal sentence is only a weaker way to write one
(`draftBriefFromGoal`). The engine turns facts into searches, reads source at pinned
revisions, assesses every fact against every repository it read, and writes artifacts
from one report model.

```text
Request (brief, or goal → drafted brief)
  ↓ validateBrief / reviseBrief            — readiness, lookup round trip
  ↓ compileProbes                          — one search per distinctive term, plus
  │                                          one combined search per multi-signal fact
  ↓ executeBrief
  │   search (EvidenceProvider)            — probe outcomes + budget ledger
  │   selectCandidateRepos                 — seeds, multi-question repos, round-robin
  │   collectEvidence                      — reads at a pinned SHA when the provider
  │                                          can resolve one; excerpts cut to the hit
  │                                          cluster the assessors need
  │   claim ledger (assessBriefClaims)     — fact × read-repository → verdict
  │   deriveBriefCoverage                  — satisfied / partial / unresolved per question
  │   reinvestment loop                    — while required questions are unresolved and
  │                                          budget remains: read unopened hits, promote
  │                                          hit repositories, reassess
  ↓ ResearchRunV2                          — observations, assessments (with fact refs),
  │                                          coverage, outcome, ledger, probes
  ↓ deriveBriefReport → writeArtifacts     — research.md, plan.md, checklist, evidence.json
  ↓ FileResearchCache                      — resume with --resume <run-id>
```

## Modules

### Brief (`src/core/brief/`)

- `draftBriefFromGoal` — goal words become one quotation fact each under an `any`
  obligation; readiness reports missing vocabulary.
- `validateBrief`, `reviseBrief` — schema and budget rules; lookup submissions become a
  new revision that never changes question statements.
- `compileProbes` — provider-neutral probes from vocabulary and facts; unsupported
  qualifiers degrade with a recorded failure. A fact with several signals, or a
  combine-`all` obligation, gets one combined search; a generic word is never
  searched alone.
- `proofTargets` — what evidence collection looks for, derived from the facts alone
  (requirements, declared paths, ecosystem hints). The envelope `FeatureSpec` is a
  projection kept for legacy consumers.
- `executeBrief` — the run: searches, candidate selection, proving pass, claim ledger,
  coverage, reinvestment, receipts. Budget accounting lives in one wrapped provider
  (`budgetedReadProvider`), which also memoizes revision resolution per repository.
- `runBudgets` — live defaults (32 searches, 150 reads, 30 minutes) and operator overrides.

### Evidence (`src/core/collectEvidence.ts`, `sourceSelection.ts`)

Reads a candidate's matched paths (or an explicit follow-up path set), pins the
revision when the provider can, records one observation per read (complete, partial,
unavailable, failed) and one anchor per signal hit. Files over 8 KB keep the merged
±12-line hit cluster that states the most distinct signals — the same window the
quotation assessor requires — so excerpt cutting cannot defeat assessment.
`classifySourcePath` decides which paths count as implementation, ecosystem
configuration, or deployment configuration.

### Assessment (`src/core/assessment/`)

- `claimLedger` — mints a claim per (fact, repository with observations), dispatches to
  the assessor for the fact's kind, and stamps each verdict with a `fact` reference
  `{questionId, obligationIndex, factIndex, kind}`. Coverage matches on that data,
  never on a parsed id.
- `verdict` — the one envelope every assessor returns.
- `types` (quotation), `dependencyDeclaration`, `configValue`, `workflowCommand` —
  pure assessors: observations in, verdict out. `contradiction` narrows a supported
  claim when same-revision evidence disables it.
- `briefCoverage` — per-question status from obligation `combine`/`scope` semantics and
  the run outcome.

### Report (`src/core/report/briefReport.ts`)

`deriveBriefReport` turns a run into, per question: supported findings (repo, path:line,
quoted text, link, pinned revision), leads (files that state the signals but cannot
count), unsatisfied facts, and unopened search hits to read next; plus the search
table, a compact candidate table, the budget receipt and grouped diagnostics.
`writeArtifacts` renders all three markdown artifacts from it. `evidence.json` carries
the full run.

### Providers (`src/adapters/`)

`EvidenceProvider` is the seam: search code, search repositories, repository metadata,
file reads at a ref, optional revision resolution and issue access.

- `OctocodeEvidenceProvider` — Octocode MCP tools through an injected `callTool`
  (`bridges/octocode-mcp.ts`). Octocode cannot resolve revisions, so the CLI composes a
  resolver from the GitHub REST provider (`githubRevisionResolver`); reads then pass
  the pinned SHA as the branch.
- `GitHubEvidenceProvider` — REST search and reads with native revision pinning.
- `MockEvidenceProvider` — fixtures for tests, `--mode mock`, and the eval harness.
- `HybridRepoExplainer` / `DeepWikiExplainer` — the MCP `explainRepoPattern` tool.

### Legacy modules

`normalizeFeatureSpec`, `scoreCandidate`, `extractPattern` and `assessment/coverage.ts`
serve the `scoreRepos` / `explainRepoPattern` MCP tools and inline legacy runs. They are
not on the research path.

## Design rules

- Core logic depends on the `EvidenceProvider` interface, never on Octocode, DeepWiki
  or GitHub directly.
- A supported claim means one same-subject observation states the asserted text; it
  never claims behavior. Documentation and changelog files need an `advertised` fact.
- Runs are honest about budget: the ledger records every unit spent, the receipt names
  what was not read and why, and a deterministic run reports fixed timestamps.
- Coverage, the report and the artifacts derive from the same run data; nothing is
  recomputed differently at render time.
