# next-work

Puts the next work item on the bench: the first open child of the issue, in the tracker's order, with no open blockers.

| | |
| --- | --- |
| Kind | module |
| Inputs | — |
| Output | `{ work: {id,ref,title,body} \| null, remaining }` |
| Eval | — |
| Used by | `feature` |

Children, their order and their blockers come from the tracker (GitHub: sub-issues by number and the body's `## Blocked by`; bd: an epic's beads by priority, then `blocks` edges). Assigning `ctx.work` opens the child's scope. `work: null` with `remaining: 0` means all done; with more, all are blocked. A child with children of its own is refused.
