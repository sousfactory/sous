# Tracker sheet: beads

How `/sous-plan` speaks to the tracker when the `tracker:` block of
`sous.yaml` says `type: beads`. The run phase uses the engine's bd adapter;
this sheet is its prose twin, so the plan prompt can name a verb and this
file says the command. Everything goes through the `bd` CLI in the
repository. `<labels>` is `tracker.labels`.

## Identity

- **`REF`:** the bead id as bd prints it (`bd-a3f8`), in text and in commit
  subjects. `ISSUE` is the same id.
- **Kind:** the bead type. An epic or feature is a feature, a bug is a bug,
  anything else is a task. The run phase reports it as the `type:feature`,
  `type:task` or `type:bug` label, so flows match without any label on the
  bead. Never set a label for the kind.
- **State labels:** the run phase claims a bead with `bd update --claim`
  under an actor named `… (sous:<branch>)`, and adds the bd label
  `<labels>:blocked` (`sous:blocked` by default) when it stops. A bead
  whose status is `in_progress` and whose owner names `sous:` is running; a
  bead with the blocked label is blocked. `<labels>:ready` is set by
  a human; `/sous-plan` sets it only through **set ready**, on a yes at its
  second gate.
- **Repo label:** the bd label `repo:<name>`, one per bead, naming the
  repository the work runs in, set only on an issue of a shared tracker
  (`tracker.shared: true`); on an unshared tracker the bead carries none.
  bd labels need no creating; the run phase
  reads them as they are.

## Verbs

- **Read the issue:** `bd show <id> --json`. The description is the body;
  `acceptance_criteria` is its own field; `parent`, `status`, `owner`,
  `labels` and `dependencies` are fields. Comments live in
  `.sous/runs/<id>/comments.md`, written by the run phase.
- **Parent of the issue:** the `parent` field of **read the issue**; empty
  means none.
- **List the children:** `bd list --parent <id> --all -n 0 --json`. The run
  phase picks the open child with the highest priority, oldest first,
  whose blockers are all closed; leave the priority at its default and
  publish in dependency order, so creation order is the default order.
- **Create the issue:** `bd create --title "<title>" --type epic --description "<problem statement>" --silent`
  (`--type task` or `--type bug` for a task or bug). `--silent` prints only
  the id.
- **Set the kind:** `bd update <id> --type epic|task|bug`.
- **Update the body:** `bd update <id> --body-file <file>`.
- **Create a child:** one command writes the body and the criteria:

  ```bash
  bd create --title "<slice title>" --type task --parent <ISSUE> --body-file <file> \
    --acceptance "- [ ] Criterion 1
  - [ ] Criterion 2" --silent
  ```

- **Add a blocker:** `bd dep add <child> --blocked-by <m>`, once per blocker.
  Blockers are `blocks` dependencies, never text in the body.
- **Set the acceptance criteria:** `bd update <id> --acceptance "<checklist>"`;
  the description stays as it is.
- **Set the repo label:** on a shared tracker only: `bd update <id> --add-label repo:<name>`, adding
  `--remove-label <other>` for any other `repo:*` label the bead carries.
- **Set ready:** `bd update <id> --add-label <labels>:ready`; bd labels
  need no creating.

## Child shape

A child is in shape when it is a task under the parent carrying, on a
shared tracker, the parent's `repo:<name>` label, its description
is the `## What to build` text of `.sous/templates/child.md` (what to
build from the user's perspective, without the heading), its
`acceptance_criteria` field holds the checklist, and its blockers are
`blocks` dependencies. The parent and the blockers are fields here, so
the body carries neither the parent section nor the blockers section of
the template. The run
phase hands the implement and review steps one body: the description,
then the criteria under `## Acceptance Criteria`.

A task or bug (`.sous/templates/task.md`) keeps its description and
carries the checklist in `acceptance_criteria`.
