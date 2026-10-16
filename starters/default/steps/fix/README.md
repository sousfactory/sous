# fix

Addresses blocking review findings or a failed verification, and commits.

| | |
| --- | --- |
| Kind | prompt |
| Inputs | `input`: findings or log; `inputKind`: `review` \| `verify`; `diffRange` |
| Output | `{ filesTouched, testsRun }` |
| Eval | the `verify` checks; max 3 iterations |
| Used by | `task`, `feature` (as `fix` and `fix-review-full`) |

Resumes the implement session in the slice loop (`resume:` in the flow).
