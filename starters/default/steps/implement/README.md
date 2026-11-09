# implement

Implements the work item following the `implement` and `tdd` skills, and commits.

| | |
| --- | --- |
| Kind | prompt |
| Inputs | `task`: title and body of the work item; `divergence`: the lines `check-issue` found the code contradicting the task, empty when none |
| Output | `{ filesTouched, testsRun }` |
| Eval | the `verify` checks (`../verify/eval.ts`); max 3 iterations |
| Used by | `task`, `feature` |

The acceptance criteria are the definition of done. The agent runs single test classes; the eval runs the full build. A decision it makes that departs from the spec goes as one line with its reason under `## Decisions` in `spec.md`, the only edit it may make under the spec folder; the reviewer judges the line instead of flagging the diff. The `divergence` lines are built against the code, not the claim, and go there too when `spec.md` exists.
