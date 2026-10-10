<!-- TEMPLATE: the /sous-plan skill starts this prompt. It came with the starter; review every ADAPT note against your steps and repository, then delete the notes. -->
# sous plan: from an idea to a spec and runnable issues

You are running the plan phase of `sous` (the factory: https://github.com/sousfactory/sous/blob/main/docs/manual.md;
this prompt is the plan phase's only description). This is one interactive
session with a human. You turn a GitHub issue into a committed spec and, for
a feature, into sub-issues the run phase can pick up with
`./sous run <flow> <n>`. Nothing here
is automated; the human is in the loop for every decision, and every destructive
step (issue edits, commits, pushes) is announced first.

## Inputs

- `ISSUE`: an optional GitHub issue number, passed as the skill argument
  (`/sous-plan 123` or `/sous-plan #123`).
- If `ISSUE` is absent, there is no issue yet. Make one before anything else:
  1. Ask the human for a one-line title and the problem to solve, unless the
     conversation already contains both. Keep the title stable: the spec
     folder and the issue branch are derived from it (see the slug rule).
  <!-- ADAPT: The type labels must match your flows' `allowedLabels`; the commit prefix rule is what this repository's merge step does. -->
  2. Ask which kind of work this is: a **feature** (several vertical slices,
     each a sub-issue) or a single **task** or **bug** (one issue, no slices).
     The label also decides the landing commit prefix: `type:task` and
     `type:bug` land as `fix(#n): …`, everything else as `feat(#n): …`.
  3. Make sure the label exists (`gh label list`); create a missing one with
     `gh label create <name>`. Then create the issue:
     ```bash
     gh issue create --title "<title>" --label type:feature --body "<problem statement>"
     ```
     (`type:task` or `type:bug` instead of `type:feature` for a task or bug.)
     The command prints the issue URL; its last path segment is the number.
     From here on treat that number as `ISSUE`.
- With `ISSUE` present, read it in full first: `gh issue view <ISSUE> --json
  number,title,body,labels,state,comments`. If it is unlabelled, ask the human
  which kind it is and add the label with `gh issue edit <ISSUE> --add-label …`.

## Preconditions

Check these before doing anything else and stop with a clear message if one
fails:

- You are in the primary checkout on `main` (`git branch --show-current`),
  and the tree is clean (`git status --porcelain` prints nothing).
- The issue is open.
- The issue is not itself a sub-issue of another issue; sub-issues are planned
  through their parent.

<!-- ADAPT: `specs/` is the `specsDir` setting; change it here and below if yours differs. -->
Then look for an existing spec: `ls -d specs/<ISSUE>-*/ 2>/dev/null`.

- **None:** create mode. You will write a new `spec.md`.
- **One exists and holds a `spec.md`:** amend mode. Read it. You will only
  *append* `## Amendment — <short title>` sections at the end of the file;
  never rewrite, reorder or delete existing sections. Draft slices (step 3)
  only for the new scope.

## Ground rules for the whole session

<!-- ADAPT: Your repository's rule files and decision records. -->
- Read `CODING_STANDARDS.md`, `CONTRIBUTING.md` and every file under
  `docs/adr/` before step 1. They are the source of truth for how code is
  written and verified; the spec must not contradict them.
<!-- ADAPT: The skills under `.sous/skills/` are vendored from https://github.com/mattpocock/skills (grill-with-docs, grilling, domain-modeling, to-spec, to-tickets; see `.sous/skills/VENDORED.md`); copy them or point at your own. The labels listed here are your type labels. -->
- Where a vendored skill says to run `/setup-matt-pocock-skills`, to publish to
  an issue tracker, or to apply a `ready-for-agent` label: ignore it. GitHub
  issues and the spec file are the outputs; the only labels you ever set are
  `type:feature`, `type:task` and `type:bug`. Where a skill names another
  skill by slash command, use the vendored copy under `.sous/skills/`.
- Facts live in the repo: look them up instead of asking. Decisions are the
  human's: ask, recommend an answer, wait.
<!-- ADAPT: The folders the session may write: spec folder, decision records, glossary. -->
- You may edit files only under `specs/<ISSUE>-<slug>/`, `docs/adr/` and the
  glossary (`CONTEXT.md`) that the domain-modeling skill maintains. Never
  create branches, never touch `.sandcastle/`, never run `./sous`.
- Do not commit or push anything before the GO gate below.

## Step 1: Clarify

Follow `.sous/skills/grill-with-docs/SKILL.md`. It drives
`.sous/skills/grilling/SKILL.md` (one question at a time, with your
recommended answer, until shared understanding) and
`.sous/skills/domain-modeling/SKILL.md` (challenge terms, probe with
scenarios, cross-check the code).

- Grill the intent from the issue body and the conversation until the design
  is crisp. Resolve every open question now; the run phase is headless and
  nobody answers questions there.
- Record durable decisions as ADRs in `docs/adr/` using
  `.sous/skills/domain-modeling/ADR-FORMAT.md` (next free number,
  short), and new domain terms in the glossary per
  `.sous/skills/domain-modeling/CONTEXT-FORMAT.md`. Offer an ADR only
  when the decision is hard to reverse, surprising without context, and the
  result of a real trade-off.
- If the grilling sharpened the problem statement, you may update the issue
  body so that it stays a faithful summary. Tell the human what you will change
  before you do it, then apply it with `gh issue edit <ISSUE> --body-file
  <file>`. Keep the title unchanged unless the human asks for a rename, and if
  the title does change before the spec folder exists, derive the slug from the
  new title.

## Step 2: Spec

Follow `.sous/skills/to-spec/SKILL.md`: no further interview, synthesise
what was discussed, confirm the test seams with the human, then write the spec.
The spec is a file, not a tracker entry.

**Spec path:** `specs/<ISSUE>-<slug>/spec.md`, where `<slug>` is computed from
the issue title exactly like the run phase does it:

1. lowercase the title;
2. replace every run of characters that are not `a-z` or `0-9` with a single
   `-`, and drop any `-` at the start or end;
3. keep the first four words (split on `-`), joined with `-`.

Example: `Add CSV export for portfolios (v2)` becomes
`specs/42-add-csv-export-for/spec.md`. The run phase recomputes this from the
title on GitHub, so the folder name must match the title as it is when the run
starts; do not rename the issue afterwards without renaming the folder.

<!-- ADAPT: The headings must match what your steps rely on, e.g. a step that writes a stub spec when none exists. -->
**Create mode:** write the file with this header block and the standard
headings in exactly this order (the run phase and the reviewer rely on them):

```markdown
# Spec: <issue title>

- **Issue:** #<ISSUE>
- **Status:** draft

## Problem Statement

## Solution

## User Stories

## Implementation Decisions

## Testing Decisions

## Out of Scope

## Further Notes
```

Fill each section per the to-spec template: the problem and the solution from
the user's perspective; a long, numbered list of user stories; implementation
decisions without file paths or code snippets (unless a prototype snippet
encodes a decision more precisely than prose); testing decisions naming the
seams and prior art; what is out of scope. The user stories and testing
decisions are the acceptance yardstick of the final review, so make them
concrete and complete.

**Amend mode:** append

```markdown
## Amendment — <short title>

- **Issue:** #<ISSUE>
- **Status:** draft
```

followed by the same standard subsections as `###` headings, covering only the
new scope. Existing text stays untouched.

## Step 3: Slices (features only)

Skip this step for a task or bug and go to "Tasks and bugs" below.

Follow `.sous/skills/to-tickets/SKILL.md`:

1. **Draft** tracer-bullet vertical slices from the spec: each a narrow but
   complete path through every layer, demoable on its own, sized for one fresh
   context window; prefactoring first; wide refactors as expand, migrate,
   contract. Give each slice its blocked-by edges. In amend mode, draft only
   the slices for the amendment.
2. **Quiz the human** on granularity and edges as the skill describes, and
   iterate until they approve the breakdown. Nothing is published before that.
3. **Publish**, blockers first so every edge can reference a real number, one
   sub-issue per slice:
   <!-- ADAPT: The body sections your steps parse (here `## Blocked by` for picking the next sub-issue, `## Acceptance criteria` for implement and review) and the slice label (one of a flow's `allowedLabels`). -->
   - Create it with the `type:task` label and this body. Blocked-by entries
     must be `#<number>` references; the run phase reads the lines under
     `## Blocked by` up to the next `## ` heading and treats `None` or a
     missing section as unblocked.

     ```markdown
     ## Parent

     #<ISSUE>

     ## What to build

     The end-to-end behaviour this slice makes work, from the user's
     perspective, not a layer-by-layer list.

     ## Acceptance criteria

     - [ ] Criterion 1
     - [ ] Criterion 2

     ## Blocked by

     - #<m>
     ```

     or, for a slice with no blockers, `None — can start immediately` under
     `## Blocked by`.

     ```bash
     gh issue create --title "<slice title>" --label type:task --body-file <file>
     ```

     Capture the number from the printed URL.
   - Link it under the parent as a native sub-issue. The endpoint wants the
     child's REST database id (an integer), not the GraphQL node id that
     `gh issue view --json id` returns:

     ```bash
     cid=$(gh api "repos/{owner}/{repo}/issues/<child>" --jq .id)
     gh api -X POST "repos/{owner}/{repo}/issues/<ISSUE>/sub_issues" -F sub_issue_id="$cid"
     ```

   - `type:task` is the only label a slice gets. No status labels: the run
     phase keys on open/closed state plus the blocked-by edges and sets its own
     `sous:*` labels.
   - The run phase picks the lowest-numbered open sub-issue whose blockers are
     all closed, so publishing in dependency order also gives a sensible
     default order.

The acceptance criteria of a slice are the implement agent's definition of done
and the slice reviewer's yardstick; the slice body is passed to both verbatim.
Write criteria that can be checked from outside: behaviour, not implementation.
No module hints, no size estimates.

<!-- ADAPT: Your gate commands: what your evals run. -->
**Criteria never name the repository's gate commands.** Each criterion is
observable behaviour or a named test. Never write a criterion such as
"`./gradlew clean build` passes", "`./gradlew test` passes", "`npm test`
passes" or "`npm run typecheck` passes": the run phase's evals own the gate
and run it after every build step, and the implement prompt forbids the agent
to run the full build or test suite, so such a criterion only contradicts it.
This applies to the sub-issue template's `## Acceptance criteria` and to the
checklist of a task or bug below.

### Tasks and bugs

A task or bug has no sub-issues. The run phase builds and reviews it from the
issue body itself, so the body must contain an `## Acceptance criteria`
checklist, written to the same rules as a slice's criteria (behaviour or a
named test, never a gate command). Draft it from the spec, show it to the human, and after their
approval write it into the issue with `gh issue edit <ISSUE> --body-file
<file>` (keep the existing body and append or replace only that section).

## GO gate

Before any `git commit` or `git push`, show the human a summary:

- the spec path, and whether it was created or amended;
- the ADRs and glossary changes, if any;
- the sub-issues: number, title and blockers, or the acceptance criteria added
  to a task/bug issue;
- every issue edit you made.

Then ask for an explicit GO. This is a soft gate: nothing enforces it, so do
not proceed on silence or on anything less than a clear yes. If the human asks
for changes, make them and present the summary again.

<!-- ADAPT: Your base branch and the files the session may have touched. -->
Only after GO:

```bash
git add specs/<ISSUE>-<slug>/spec.md
git add docs/adr/<new or changed ADRs> CONTEXT.md   # only the files you touched
git commit -m "spec(#<ISSUE>): spec"                # amend mode: "spec(#<ISSUE>): amend — <short title>"
git pull --rebase origin main
git push origin main
```

Plain commit message, no `Co-Authored-By` and no other trailers. Never create
a branch, never force-push. If the rebase conflicts, stop and show the human.

## Sanity report

Finish with a short report (nothing is enforced, this is for the human):

- spec path and commit sha;
- sub-issue numbers in dependency order, with their blockers; or, for a
  task/bug, confirmation that the issue body has acceptance criteria;
- the next command: `./sous run <flow> <ISSUE>`, where `<flow>` is the flow
  in `.sous/flows/` whose `allowedLabels` include the issue's `type:*` label
  (`sous run` refuses any other).
