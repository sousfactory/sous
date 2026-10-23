# Tracker sheet: GitHub

How `/sous-plan` speaks to the tracker when `sous.yaml` says `tracker:
github`. The run phase uses the engine's GitHub adapter; this sheet is its
prose twin, so the plan prompt can name a verb and this file says the
command. Everything goes through the `gh` CLI, which infers the repository
from the checkout.

## Identity

- **`REF`:** `#<number>` in text (commit subjects, the spec header). `ISSUE`
  is the bare number.
- **Kind:** one of the labels `type:feature`, `type:task`, `type:bug`. A
  missing label is a missing kind. `gh label list` shows what exists;
  `gh label create <name>` adds one.
- **State labels:** `<labelPrefix>:running` and `<labelPrefix>:blocked`
  (`sous:running`, `sous:blocked` by default), set and removed by the run
  phase only. A child carrying one is mid-run.

## Verbs

- **Read the issue:** `gh issue view <n> --json number,title,body,labels,state,comments`.
- **Parent of the issue:** `gh api repos/{owner}/{repo}/issues/<n>/parent --jq .number`;
  a 404 means it has none.
- **List the children:** `gh api --paginate repos/{owner}/{repo}/issues/<n>/sub_issues --jq '.[] | {number, title, state, labels: [.labels[].name]}'`,
  then **read the issue** for each body. This is the order the run phase
  picks work in: the lowest-numbered open child whose blockers are all closed.
- **Create the issue:** `gh issue create --title "<title>" --label type:<kind> --body "<problem statement>"`.
  The command prints the issue URL; its last path segment is the number.
- **Set the kind:** `gh issue edit <n> --add-label type:<kind>`, removing any
  other `type:*` label with `--remove-label`.
- **Update the body:** `gh issue edit <n> --body-file <file>`.
- **Create a child:** `gh issue create --title "<slice title>" --label type:task --body-file <file>`,
  then link it under the parent as a native sub-issue. The endpoint wants
  the child's REST database id (an integer), not the GraphQL node id that
  `gh issue view --json id` returns:

  ```bash
  cid=$(gh api "repos/{owner}/{repo}/issues/<child>" --jq .id)
  gh api -X POST "repos/{owner}/{repo}/issues/<parent>/sub_issues" -F sub_issue_id="$cid"
  ```

- **Add a blocker:** a `- #<m>` line under `## Blocked by` in the child's
  body (see the child shape); the run phase reads that section. There is no
  separate command: write the section when you create the child, or
  **update the body**.
- **Set the acceptance criteria:** replace the `## Acceptance criteria`
  section of the body and **update the body**.

## Child shape

A child is in shape when it has the `type:task` label and its body is
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
