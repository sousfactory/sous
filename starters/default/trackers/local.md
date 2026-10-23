# Tracker sheet: local

How `/sous-plan` speaks to the tracker when `sous.yaml` says `tracker:
local`. Issues are plain files the engine's local adapter reads; this sheet
is its prose twin, so the plan prompt can name a verb and this file says
the file edit. Nothing leaves the machine.

The folder is `trackerOptions: { dir }` in `sous.yaml`, relative to
`.sous/` (`.sous/issues/` in the starter). Each issue is
`<dir>/<id>.json`; its comments are `<dir>/<id>.comments.md`.

```json
{
  "id": "12",
  "title": "Add CSV export for portfolios",
  "body": "…markdown…",
  "labels": ["type:task"],
  "state": "open",
  "children": ["13", "14"],
  "blockedBy": ["11"]
}
```

## Identity

- **`REF`:** the id as written in the file name (`12`), in text and in
  commit subjects. `ISSUE` is the same id. Pick the next free id when you
  create one; any string without `/` works, numbers keep the order readable.
- **Kind:** one of `type:feature`, `type:task`, `type:bug` in `labels`.
- **State labels:** `<labelPrefix>:running` and `<labelPrefix>:blocked`
  (`sous:running`, `sous:blocked` by default) in `labels`, set and removed
  by the run phase only. A child carrying one is mid-run.

## Verbs

Every verb is a read or an edit of the JSON file; keep the other keys as
they are and the file pretty-printed.

- **Read the issue:** read `<dir>/<id>.json`, and `<dir>/<id>.comments.md`
  if it exists.
- **Parent of the issue:** the file whose `children` lists the id; none
  means it is top-level.
- **List the children:** the `children` array of the parent, in order; the
  run phase picks the first open one whose `blockedBy` are all closed.
- **Create the issue:** write `<dir>/<id>.json` with `id`, `title`, `body`,
  `labels` holding the kind, and `"state": "open"`.
- **Set the kind:** replace the `type:*` entry in `labels`.
- **Update the body:** replace `body`.
- **Create a child:** write the child's file with the kind `type:task` and
  the body in the child shape, then append its id to the parent's
  `children`.
- **Add a blocker:** append the blocker's id to the child's `blockedBy`.
- **Set the acceptance criteria:** replace the `## Acceptance criteria`
  section of `body`.

## Child shape

A child is in shape when its `labels` hold `type:task`, the parent's
`children` lists it, its blockers are in `blockedBy`, and its body is
`.sous/templates/child.md` without the `## Parent` and `## Blocked by`
sections, which are fields here: `## What to build`, then
`## Acceptance criteria`. The body is handed to the implement and review
steps verbatim. A task or bug is `.sous/templates/task.md`: whatever the
author wrote plus the `## Acceptance criteria` checklist.
