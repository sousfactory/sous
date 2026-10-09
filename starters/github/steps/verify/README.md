# verify

The project's checks, listed in `eval.ts` (`CHECKS`, a list of `{ command, dir?, when? }`), run in order in the worktree.

| | |
| --- | --- |
| Kind | eval-only |
| Inputs | — |
| Output | — |
| Eval | stops at the first failure; log is a `$ cmd (exit n)` transcript |
| Used by | no flow; its `eval.ts` is the check of `implement`, `fix` and `sync-resolve` |

A check with `when` runs only when `git diff --name-only <BASE_BRANCH>...HEAD` touches that folder. `sous init` copies this file with an empty list: fill in `CHECKS` and `BASE_BRANCH`; until then every eval passes with `WARN: no checks configured` in its log.
