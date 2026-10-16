# sync-resolve

Merges the base branch in and makes the branch whole again: resolves conflicts and repairs what the merge broke.

| | |
| --- | --- |
| Kind | prompt with `prepare` |
| Inputs | `baseBranch` |
| Output | `{ filesTouched }`; prepared `{ conflict, moved }` |
| Eval | nothing came in → ok; else no merge in progress, then the `verify` checks; max 3 |
| Used by | `task`, `feature` (as `sync`) |

Prepare merges and puts the issue itself on the bench, then says when the agent runs: `always` on a conflict (a merge already in progress counts as one), `on-fail` after a merge that moved HEAD, so the eval runs the checks first and the agent repairs only when they fail, with their transcript appended to its prompt; `never` when the branch was already up to date.
