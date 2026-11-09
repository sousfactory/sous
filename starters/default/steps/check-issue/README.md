# check-issue

Checks the issue against the code before anything is planned or built, so a run does not build on an issue that no longer holds.

| | |
| --- | --- |
| Kind | prompt with `prepare` |
| Inputs | `issue` (ref, title and body as filed) |
| Output | `{ verdict, evidence[], divergence? }`, evidence `{ command, result }`; prepared `{ verdict: open \| closed }` |
| Eval | `holds` and `unclear` pass; `fixed` and `false-premise` fail with the verdict and every command with its result as the log; a blocking verdict without evidence, or no verdict, fails. `loop: false`, so a failure routes instead of retrying |
| Used by | `task` (after `init`), `feature` (after `next-work`) |

The agent, read-only on the code, checks whether the described defect still exists, whether each named file, symbol, test or fixture exists and says what the issue says, whether each "broken", "missing" or "there is no X" claim is true, and reproduces a behavioural claim. A failed eval routes to `blocked` with the evidence as the comment; the human closes or rewrites the issue, never the run. An issue that is partly false but whose defect is real gets `holds`, and each divergence becomes a line under `## Decisions`: in `spec.md` when the branch has one, and always in `divergence`, which the task flow hands to `plan` and `implement`, and the feature flow to `implement` and the child's `review`. Prepare skips the agent on an issue a human has closed; the feature flow then goes on to the next child. To drop the check, delete the flow entry and point the previous step's route at the next one.
