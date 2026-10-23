## Parent

<parent ref>

## What to build

The end-to-end behaviour this slice makes work, from the user's
perspective, not a layer-by-layer list.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by

- <blocker ref>

<!--
The body of a child issue (a slice of a feature), as /sous-plan publishes
it and reconciles existing children into it. Copy the sections, not this
comment. How the parent and the blockers are expressed is the tracker
sheet's (`trackers/<tracker>.md`, "Child shape"): on GitHub the two
sections above, as written; on bd and in the local tracker the parent and
the blockers are fields, and the body is `## What to build` and the
criteria only.

What the run phase parses:

- The GitHub tracker reads the lines under `## Blocked by` up to the next
  `## ` heading and treats every `#<number>` in them as a blocker. A slice
  with no blockers writes `None — can start immediately` there; a missing
  section means the same.
- The bd tracker keeps the criteria in the bead's own field and hands the
  steps the description followed by `## Acceptance Criteria`.
- The whole body goes to the implement and review steps verbatim, so
  `## Acceptance criteria` is their definition of done. Write criteria that
  can be checked from outside: behaviour or a named test, never the
  repository's build or test commands.
-->
