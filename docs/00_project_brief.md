# 00 Project Brief

## Project name

Research Orchestrator

## One-sentence summary

A workflow engine that uses Octocode, GitHub, optional DeepWiki enrichment, and local evidence processing to find implementation examples, score repositories, extract patterns, and generate grounded implementation plans.

## Problem

Coding agents can write plausible implementation plans without enough evidence. Existing tools can search code, but they rarely produce a complete research artifact that answers:

- Which real repositories implement this feature?
- Are they production apps, examples, docs, or false positives?
- Which files prove the implementation?
- What libraries and patterns are actually used?
- What should be copied, adapted, or avoided?
- What open questions remain before implementation?

## Target user

A developer using AI coding agents and parallel subagents who wants grounded implementation research before starting work.

## Product goals

1. Turn vague feature goals into structured feature specs.
2. Generate search probes automatically.
3. Collect and deduplicate candidate repositories.
4. Score candidates with explicit proof requirements.
5. Read exact file evidence and preserve anchors.
6. Use DeepWiki when it adds high-level repo explanation.
7. Fall back to Octocode/local evidence when DeepWiki is unavailable or stale.
8. Produce artifacts that a coding agent can consume directly.

## Non-goals

For the initial release, do not build:

- a replacement for Octocode
- a full code search engine
- a global GitHub index
- a vector database
- a browser-heavy DeepWiki scraper as the required path
- a hosted SaaS
- a web dashboard

## Core insight

Octocode is strongest as an evidence engine. What is missing is a task-specific workflow layer that understands research intent, candidate scoring, evidence requirements, and planning artifacts.

## MVP user story

As a developer, I can run:

```bash
research-orchestrator find \
  --goal "Next.js + Convex app with email magic links via Resend" \
  --out .research/next-convex-magic-link
```

and receive:

```text
research.md
plan.md
evidence.json
implementation-checklist.md
```

## Success metrics

### Quality

- Accepted candidate repos have at least three evidence anchors.
- Final recommendations cite exact files/lines when available.
- False-positive repo rate after scoring is under 25%.
- The generated plan requires fewer human corrections than an ungrounded agent plan.

### Speed

- Top 10 candidate discovery under 45 seconds in a normal networked run.
- Top 3 deep-proof analysis under 3 minutes.
- Mock/test flow under 5 seconds.

### Usability

- The agent prompt can bootstrap the project without additional explanation.
- Artifacts are readable by humans and machines.
- The workflow can run in mock mode without credentials.
