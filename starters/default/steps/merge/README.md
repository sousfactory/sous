# merge

Lands the branch: squashes it onto the base branch in the repository checkout and cleans up.

| | |
| --- | --- |
| Kind | module |
| Inputs | `baseBranch`: the branch to squash onto; `mergedLabel` (optional): the state label to set, e.g. `sous:merged`; `resync` (optional): `true` to land only what was synced; `push` (optional): a remote, e.g. `origin`, to land the base branch on |
| Output | `{ stale, sha? }` |
| Eval | — |
| Used by | `task`, `feature` (last step) |

Commit message `feat(#N): <title>`, or `fix(#N)` for `type:task` / `type:bug`. Closes sandbox, worktree and branch, sets `mergedLabel`, comments the result; the lifecycle closes the issue on `done`. Already merged → no squash. Without `push` it never fetches or pushes.

With `resync: ${{ true }}`, when the base branch has commits the branch lacks (another run merged since the last `sync`), it merges and cleans up nothing and answers `{ stale: true }`. `task` and `feature` set it and route that back to `sync`, so the new base is merged in, checked and reviewed before anything lands. A flow that sets `resync` must route `result.output.stale`, or it reaches `done` with nothing landed.

With `push: origin`, the step first fast-forwards the base branch from `origin`, so the freshness check sees what landed there (a moved remote base makes the branch stale under `resync`), and after the squash pushes the base branch to `origin`; the summary and the comment name the push. A local base that diverged from the remote's fails the step before anything is squashed. A failed push keeps the squash on the local base, fails the step with the push error and says on the issue that the merge landed locally and was not pushed; a rerun finds the branch merged and pushes again.

The checks, the fast-forward, the squash and the push run under `ctx.repoLock`, as one transaction on the shared checkout: a parallel run's merge cannot slip in between the freshness check and the commit.
