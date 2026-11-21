# Tracker sheet: GitHub

How `/sous-plan` speaks to the tracker when the `tracker:` block of
`sous.yaml` says `type: github`: the sheet `.sous/trackers/<type>.md` of
that type. The run phase uses the engine's GitHub
adapter; this sheet is its prose twin, so the plan prompt can name a verb
and this file says the command. Everything goes through the `gh` CLI,
always on the repository the block names: `<repo>` is `tracker.repo`
(`owner/name`), never inferred from the checkout. `<labels>` is
`tracker.labels`, the state-label prefix; it has no default (`sous` in
the starter).

## Identity

- **`REF`:** `#<number>` in text (commit subjects, the spec header). `ISSUE`
  is the bare number.
- **Kind:** one of the labels `type:feature`, `type:task`, `type:bug`. A
  missing label is a missing kind. `gh label list -R <repo>` shows what exists;
  `gh label create <name> -R <repo>` adds one.
- **State labels:** `<labels>:running` and `<labels>:blocked`
  (`sous:running`, `sous:blocked` with `labels: sous`), set and removed by the run
  phase only. A child carrying one is mid-run. `<labels>:ready` is set
  by a human; `/sous-plan` sets it only through **set ready**, on a yes at
  its second gate.
- **Repo label:** `repo:<name>`, one per issue, naming the repository the
  work runs in, set only on an issue of a shared tracker (`tracker.shared:
  true`); on an unshared tracker the issue carries none. A label must exist
  in the repository before it is applied: `gh label list -R <repo> --search
  repo:` shows what exists.

## Verbs

- **Read the issue:** `gh issue view <n> -R <repo> --json number,title,body,labels,state,comments`.
- **Parent of the issue:** `gh api repos/<repo>/issues/<n>/parent --jq .number`;
  a 404 means it has none.
- **List the children:** `gh api --paginate repos/<repo>/issues/<n>/sub_issues --jq '.[] | {number, title, state, labels: [.labels[].name]}'`,
  then **read the issue** for each body. This is the order the run phase
  picks work in: the lowest-numbered open child whose blockers are all closed.
- **Create the issue:** `gh issue create -R <repo> --title "<title>" --label type:<kind> --body "<problem statement>"`.
  The command prints the issue URL; its last path segment is the number.
- **Set the kind:** `gh issue edit <n> -R <repo> --add-label type:<kind>`, removing any
  other `type:*` label with `--remove-label`.
- **Update the body:** `gh issue edit <n> -R <repo> --body-file <file>`.
- **Create a child:** `gh issue create -R <repo> --title "<slice title>" --label type:task --body-file <file>`,
  then link it under the parent as a native sub-issue. The endpoint wants
  the child's REST database id (an integer), not the GraphQL node id that
  `gh issue view --json id` returns:

  ```bash
  cid=$(gh api "repos/<repo>/issues/<child>" --jq .id)
  gh api -X POST "repos/<repo>/issues/<parent>/sub_issues" -F sub_issue_id="$cid"
  ```

- **Add a blocker:** a `- #<m>` line under `## Blocked by` in the child's
  body (see the child shape); the run phase reads that section. There is no
  separate command: write the section when you create the child, or
  **update the body**.
- **Set the acceptance criteria:** replace the `## Acceptance criteria`
  section of the body and **update the body**.
- **Set the repo label:** on a shared tracker only: when `repo:<name>` is
  missing from `gh label list -R <repo> --search repo:`,
  `gh label create repo:<name> -R <repo>` first; then
  `gh issue edit <n> -R <repo> --add-label repo:<name>`, removing any other `repo:*`
  label with `--remove-label`.
- **Set ready:** when `<labels>:ready` is missing from
  `gh label list -R <repo> --search <labels>:`,
  `gh label create <labels>:ready -R <repo>` first; then
  `gh issue edit <n> -R <repo> --add-label <labels>:ready`.

## Child shape

A child is in shape when it has the `type:task` label and, on a shared
tracker, the parent's `repo:<name>` label, and its body is
`.sous/templates/child.md` as written, all four sections: `## Parent` with
`#<parent>`, `## What to build`, `## Acceptance criteria`, `## Blocked by`
with one `- #<m>` per blocker. A slice with no blockers writes
`None — can start immediately` under `## Blocked by`; a missing section
means the same. The run phase reads the lines under `## Blocked by` up to
the next `## ` heading and treats every `#<number>` in them as a blocker.
The whole body is handed to the implement and review steps verbatim, so
`## Acceptance criteria` is their definition of done. A task or bug is
`.sous/templates/task.md`: the author's text, then the checklist.

A task or bug has no `## Parent` and no `## Blocked by`; its body keeps
whatever the author wrote plus the `## Acceptance criteria` checklist.
