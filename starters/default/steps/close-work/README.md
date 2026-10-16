# close-work

Closes the current sub-issue: comments its commits, closes it, marks it done in the run record. Idempotent.

| | |
| --- | --- |
| Kind | module |
| Inputs | `commits`: the sub-issue's shas (array or JSON array string) |
| Output | `{ work }` |
| Eval | — |
| Used by | `feature` |

Refuses when the issue itself is on the bench; `merge` closes that.
