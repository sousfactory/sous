# implement

Implements the work item following the `implement` and `tdd` skills, and commits.

| | |
| --- | --- |
| Kind | prompt |
| Inputs | `task`: title and body of the work item |
| Output | `{ filesTouched, testsRun }` |
| Eval | the `verify` checks (`../verify/eval.ts`); max 3 iterations |
| Used by | `task`, `feature` |

The acceptance criteria are the definition of done. The agent runs single test classes; the eval runs the full build.
