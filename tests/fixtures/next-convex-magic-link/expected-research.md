> **Synthetic/mock evidence:** fixture observations are not live repository findings.

# Research: Next.js + Convex app with email magic links via Resend

## Goal

Next.js + Convex app with email magic links via Resend

## Status

- **complete** (synthetic_evidence)
- Questions satisfied: 1/1; supported findings: 2
- Candidates discovered: 2; read: 2

## Summary

Run `run_mock_next_convex_magic_link_auth` found 2 source-backed finding(s) across 1 satisfied question(s). A supported finding means only that the cited file states the quoted text at the cited line; read it in context before relying on it.

## Findings by question

### q1 — Next.js Next Convex Resend in the context of: Next.js + Convex app with email magic links via Resend

- Status: **satisfied** (required)
- Supported:
  - **headcodecms/headcodecms** `proxy.ts`:5 — `} from "@convex-dev/auth/nextjs/server";` ([link](https://github.com/headcodecms/headcodecms/blob/0123456789abcdef0123456789abcdef01234567/proxy.ts#L5)) — Next _(pinned 0123456)_
  - **headcodecms/headcodecms** `convex/auth.ts`:6 — `Resend({` ([link](https://github.com/headcodecms/headcodecms/blob/0123456789abcdef0123456789abcdef01234567/convex/auth.ts#L6)) — Resend _(pinned 0123456)_
- Leads (not proof):
  - justinwlin/convex-magic-link-authentication `README.md` — Convex: states the signals, but not in a source file this fact can count (unscoped scope)
  - justinwlin/convex-magic-link-authentication `README.md` — Resend: states the signals, but not in a source file this fact can count (unscoped scope)

## What was searched

| Question | Compiled query | Endpoint | Outcome | Results |
|---|---|---|---|---:|
| Next.js Next Convex Resend in the context of: Next.js + Convex app with email magic links via Resend | `Next.js` | codeSearch | succeeded (relevant_leads) | 8 |
| Next.js Next Convex Resend in the context of: Next.js + Convex app with email magic links via Resend | `Next` | codeSearch | succeeded (relevant_leads) | 8 |
| Next.js Next Convex Resend in the context of: Next.js + Convex app with email magic links via Resend | `Convex` | codeSearch | succeeded (relevant_leads) | 8 |
| Next.js Next Convex Resend in the context of: Next.js + Convex app with email magic links via Resend | `Resend` | codeSearch | succeeded (relevant_leads) | 8 |

## Candidates

| Repository | Files read | Unavailable | Supported claims | State |
|---|---:|---:|---:|---|
| [headcodecms/headcodecms](https://github.com/headcodecms/headcodecms) | 4 | 0 | 2 | eligible |
| [justinwlin/convex-magic-link-authentication](https://github.com/justinwlin/convex-magic-link-authentication) | 1 | 0 | 0 | ineligible |

## Budget receipt

- Searches 4/16; file reads 5/48; RPC calls 11; unbudgeted metadata calls 2; elapsed 0s.

## Diagnostics

- none

## Skeptic notes

- A supported finding is a quotation, not verified behavior: open the file at the cited revision and read the surrounding control flow.
- Leads state the signals in files this fact cannot count (documentation, changelogs, imports); they point at where to look, not at proof.
- Unsatisfied facts with unopened hits are the cheapest next step: resume the run or read those files directly.
