# init

Prepares a delivery run: checks the issue and makes sure its spec exists.

| | |
| --- | --- |
| Kind | module |
| Inputs | — |
| Output | `{ specDir }` |
| Eval | — |
| Used by | `task`, `feature` (entry) |

Refuses a closed issue; a sub-issue runs like any other, its label decides the flow. Uses the `<specsDir>/<issue>-*/` folder the plan phase made, else commits a stub `spec.md` from the issue (`spec(#N): stub from issue`). Records `ctx.specDir`.
