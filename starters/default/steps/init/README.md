# init

Guards a delivery run: the issue is open and the worktree is on the run's branch.

| | |
| --- | --- |
| Kind | module |
| Inputs | — |
| Output | `{}` |
| Eval | — |
| Used by | `task`, `feature` (entry) |

Refuses a closed issue and a worktree on another branch; a sub-issue runs like any other, its label decides the flow. Writes nothing: the spec is `ctx.spec`, which `sous run` reads from `<specsDir>/<issue>-*/spec.md` in the worktree at every start, or builds from the issue when the plan phase wrote none.
