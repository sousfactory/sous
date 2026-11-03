# verify

The project's checks, listed in `eval.ts` (`CHECKS`, a list of `{ command, dir?, when? }`), run in order in the worktree.

| | |
| --- | --- |
| Kind | eval-only |
| Inputs | — |
| Output | — |
| Eval | stops at the first failure; log is a `$ cmd (exit n)` transcript |
| Used by | no flow; its `eval.ts` is the check of `implement`, `fix` and `sync-resolve` |

A check with `when` runs only when `git diff --name-only <ctx.baseBranch>...HEAD` touches that folder; `ctx.baseBranch` is the `baseBranch` setting in `sous.yaml`. `sous init` copies this file with an empty list: fill in `CHECKS`; until then every eval passes with `WARN: no checks configured` in its log.
