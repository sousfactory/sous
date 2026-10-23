# review

Judges a diff cold and read-only against criteria and the repository rules, following the `code-review` skill.

| | |
| --- | --- |
| Kind | prompt |
| Inputs | `diffRange`: git range; `criteria`: the work item body or the spec |
| Output | `{ verdict, findings[] }`, finding `{ severity, file, line?, message }` |
| Eval | ok iff no `blocker` or `major` finding; the log lists them. An output without a `findings` array fails: no review happened. `loop: false`, max 2 |
| Used by | `task`, `feature` (as `review` and `review-full`) |

A failed eval does not retry: the flow routes the findings to `fix`. An `## Assumptions` line in the criteria is no criterion, and one that contradicts the issue is a blocker; a `## Decisions` line (written by implement or fix, with its reason) is judged instead of the departure it explains, and is a finding only when the reason does not hold.
