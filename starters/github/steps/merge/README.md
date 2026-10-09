# merge

Lands the branch: squashes it onto the base branch in the repository checkout and cleans up.

| | |
| --- | --- |
| Kind | module |
| Inputs | `baseBranch`: the branch to squash onto; `mergedLabel` (optional): the state label to set, e.g. `sous:merged` |
| Output | `{ sha }` |
| Eval | — |
| Used by | `task`, `feature` (last step) |

Commit message `feat(#N): <title>`, or `fix(#N)` for `type:task` / `type:bug`. Closes sandbox, worktree and branch, sets `mergedLabel`, comments the result; the lifecycle closes the issue on `done`. Already merged → no squash. Never pushes.
