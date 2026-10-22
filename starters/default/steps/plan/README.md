# plan

Derives a spec from the issue when the branch has none, so later steps never build and review against a bare ticket.

| | |
| --- | --- |
| Kind | prompt with `prepare` |
| Inputs | `issue` (ref, title and body as filed) |
| Output | `{ assumptions, openQuestions }`; prepared `{ exists }` |
| Eval | `spec.md` on the branch, committed, with no `## Open questions` items; `loop: false`, so questions route instead of retrying |
| Used by | `task` |

Prepare finds `spec.md` in the worktree (planned with `/sous-plan`, or derived on an earlier run) and skips the agent; the eval only confirms the file. Otherwise the agent restates the issue into the spec headings, decides what the issue left open by the simplest reading and lists each choice under `## Assumptions`, and leaves a question open only when the readings differ in observable behaviour or the choice is expensive to reverse. Open questions fail the eval with the questions as the log; the flow routes to `blocked`, the human answers in the file or the issue and runs the issue again, and the answered file passes eval-first. The next step sees the spec through `ctx.spec`, which the executor reads from the worktree at every step start.
