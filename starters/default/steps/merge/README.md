# merge

Lands the branch: squashes it onto the base branch in the repository checkout and cleans up.

| | |
| --- | --- |
| Kind | module |
| Inputs | `baseBranch`: the branch to squash onto; `mergedLabel` (optional): the state label to set, e.g. `sous:merged`; `resync` (optional): `true` to land only what was synced |
| Output | `{ stale, sha? }` |
| Eval | — |
| Used by | `task`, `feature` (last step) |

Commit message `feat(#N): <title>`, or `fix(#N)` for `type:task` / `type:bug`. Closes sandbox, worktree and branch, sets `mergedLabel`, comments the result; the lifecycle closes the issue on `done`. Already merged → no squash. Never pushes.

With `resync: ${{ true }}`, when the base branch has commits the branch lacks (another run merged since the last `sync`), it merges and cleans up nothing and answers `{ stale: true }`. `task` and `feature` set it and route that back to `sync`, so the new base is merged in, checked and reviewed before anything lands. A flow that sets `resync` must route `result.output.stale`, or it reaches `done` with nothing landed.

The checks and the squash run under `ctx.repoLock`, as one transaction on the shared checkout: a parallel run's merge cannot slip in between the freshness check and the commit.
