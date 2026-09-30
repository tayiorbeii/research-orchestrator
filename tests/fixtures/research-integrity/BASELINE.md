# Research integrity fixture baseline

- Recorded: 2026-09-29
- Worktree: `phase0b-baseline-fixtures`
- Baseline commit: `9a7aa31b7b4bfd52de023093cf17865dca112273`
- Runtime: Node `v20.10.0`; `node_modules` is a symlink to the kit checkout's dependencies.
- Publication scope: local worktree only; no push, PR, or merge.

## Before fixture changes

| Command | Result |
| --- | --- |
| `npm test` | 21 test files passed, 1 failed during module loading; 281 tests passed. `src/pipeline/stages/srtFrames.test.ts` could not load because the installed `execa` uses `Set.prototype.union`, unavailable in Node 20.10.0. |
| `npm run build` | Passed (`tsc -p tsconfig.json` and `tsc -p bridges/tsconfig.json`). |

The test failure is an environment/runtime compatibility issue present before this lane's edits. No source, bridge, or schema files were changed to address it.
