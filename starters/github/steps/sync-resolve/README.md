# sync-resolve

Merges the base branch in and makes the branch whole again: resolves conflicts and repairs what the merge broke.

| | |
| --- | --- |
| Kind | prompt with `prepare` |
| Inputs | `baseBranch` |
| Output | `{ filesTouched }`; prepared `{ conflict, moved, checkLog? }` |
| Eval | skipped agent → ok; else no merge in progress, then the `verify` checks; max 3 |
| Used by | `task`, `feature` (as `sync`) |

Prepare merges and puts the issue itself on the bench. The agent runs only on a conflict, or when the `verify` checks fail after a clean merge (their log is `{{prepared.checkLog}}`); otherwise it is skipped. A merge already in progress counts as a conflict.
