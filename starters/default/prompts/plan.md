<!-- TEMPLATE: the /sous-plan skill starts this prompt. It came with the starter and speaks to the tracker only through the verbs defined in `.sous/trackers/<tracker>.md` (github, beads, local). Review every ADAPT note against your steps and repository, then delete the notes. -->
# sous plan: from an idea to a spec and runnable issues

You are running the plan phase of `sous` (the factory: https://github.com/sousfactory/sous/blob/main/docs/manual.md;
this prompt is the plan phase's only description). This is one interactive
session with a human. You turn an issue into a committed spec and, for a
feature, into children the run phase can pick up with
`./sous run <flow> <ISSUE>`. Nothing here is automated; the human is in the
loop for every decision, and every destructive step (issue edits, commits,
pushes) is announced first.

The procedure is a numbered sequence of steps. Each step names its cases;
take the one that applies and move on. `docs/PLAN-SKILL-FLOW.md` in the
sous repository draws the same sequence as one diagram.

## Inputs

- `ISSUE`: an optional issue id, passed as the skill argument (`/sous-plan
  123`, `/sous-plan #123`, `/sous-plan bd-a3f8`); a leading `#` is not part
  of the id.
- **The tracker sheet.** Read `tracker:` from `.sous/sous.yaml`. The sheet
  is `.sous/trackers/<tracker>.md` (`github.md`, `beads.md`, `local.md`; for
  a module such as `trackers/jira.ts`, the `.md` beside it). Every tracker
  verb below is written in bold, **like this**, and the sheet defines it as
  a command or a file edit. Use the sheet's commands and nothing else to
  talk to the tracker. The sheet also defines `REF`, how the issue is
  written in text (`#42`, `bd-a3f8`), the **kind** (feature, task or bug,
  and where it is stored), the **state labels** the run phase sets, and
  the **child shape** the run phase parses. Where a vendored skill says to
  run `/setup-matt-pocock-skills` or to read `docs/agents/issue-tracker.md`,
  the sheet is that configuration; where it says to publish to the issue
  tracker or to apply a `ready-for-agent` label, this prompt says what to
  publish instead.
- **Settings** from `.sous/sous.yaml`: `baseBranch` (the base, `main`
  unless changed), the `branch` template, `labelPrefix` (`sous` unless
  changed) and `specsDir` (`../specs` from `.sous`, so `specs/` at the
  repository root).

## 1. The issue

- **No `ISSUE`:** there is no issue yet. Ask the human for a one-line title
  and the problem to solve, unless the conversation already contains both,
  and which kind of work it is: a **feature** (several vertical slices, each
  a child) or a single **task** or **bug** (one issue, no slices). Keep the
  title stable: the spec folder and the branch are derived from it (see the
  slug rule). Then **create the issue** with that kind and the problem
  statement as its body. From here on treat the new id as `ISSUE`.
  <!-- ADAPT: The kinds must match your flows' `allowedLabels`; the commit prefix rule is what this repository's merge step does. -->
  The kind decides the flow that runs the issue and the landing commit
  prefix: a task or bug lands as `fix(REF): …`, everything else as
  `feat(REF): …`.
- **`ISSUE` given:** **read the issue** in full: title, body, kind, state,
  comments and, for a feature, its **children**. If it has no kind, ask the
  human which kind it is and **set the kind**.

## 2. Preconditions

Stop with a clear message if one fails:

- The issue is open.
- The issue is not itself a child of another issue (the **parent of the issue**
  is empty); children are planned through their parent.
- You are in the primary checkout on the base branch (`git branch
  --show-current` prints `baseBranch`) and the tree is clean (`git status
  --porcelain` prints nothing).

## 3. Run state and target

The run phase marks an issue it works on with the **state labels**
`<labelPrefix>:running` and `<labelPrefix>:blocked`. The labels and the
local worktree decide where this session writes:

- **`<labelPrefix>:running`:** stop. A run is in progress; nothing may be
  amended, neither on the base nor on the branch. Tell the human to block
  the run or wait for it.
- **`<labelPrefix>:blocked`:** compute the run's branch from the `branch`
  template in `sous.yaml` (`${{ issue.id }}` is `ISSUE`, `${{ slug }}` is
  the slug of the title by the rule in step 5). Find its worktree:
  `git worktree list --porcelain` lists each worktree's path followed by
  `branch refs/heads/<branch>`.
  - **Worktree here:** the target is that worktree. The spec is read,
    edited and committed there, on the branch, and never pushed; the
    re-entered run reads it from the branch.
  - **No worktree here:** stop. The run lives on another machine (its
    blocked comment on the issue names the worktree); amend it there.
- **Neither label:** no run exists. The target is the primary checkout on
  the base branch.

From here on, every file path is relative to the target and every `git`
command runs in the target (`git -C <target> …` when the target is the
worktree). The checkout precondition above still holds: the session
never leaves the base branch in the primary checkout.

## 4. Mode

<!-- ADAPT: `specs/` is the `specsDir` setting; change it here and below if yours differs. -->
Look for an existing spec in the target: `ls -d specs/<ISSUE>-*/ 2>/dev/null`.

- **None:** create mode. You will write a new `spec.md`.
- **One exists and holds a `spec.md`:** amend mode. Read it. You will only
  *append* `## Amendment — <short title>` sections at the end of the file;
  never rewrite, reorder or delete existing sections. Draft slices (step 8)
  only for the new scope.

## 5. Ground rules for the whole session

<!-- ADAPT: Your repository's rule files and decision records. -->
- Read `CODING_STANDARDS.md`, `CONTRIBUTING.md` and every file under
  `docs/adr/` before step 6. They are the source of truth for how code is
  written and verified; the spec must not contradict them.
<!-- ADAPT: The skills under `.sous/skills/` are vendored from https://github.com/mattpocock/skills (grill-with-docs, grilling, domain-modeling, to-spec, to-tickets; see `.sous/skills/VENDORED.md`); copy them or point at your own. -->
- Where a vendored skill names another skill by slash command, use the
  vendored copy under `.sous/skills/`. The issue, its children and the spec
  file are the outputs; the kinds are the only classification you ever set.
  Never set a state label: the run phase owns the `sous:*` labels.
- Facts live in the repo: look them up instead of asking. Decisions are the
  human's: ask, recommend an answer, wait.
<!-- ADAPT: The folders the session may write: spec folder, decision records, glossary. -->
- You may edit files only under `specs/<ISSUE>-<slug>/`, `docs/adr/` and the
  glossary (`CONTEXT.md`) that the domain-modeling skill maintains. Never
  create branches, never touch `.sandcastle/` beyond the target worktree,
  never run `./sous`.
- Do not commit or push anything before the GO gate in step 9.

**Slug rule.** `<slug>` is computed from the issue title exactly like the
run phase does it:

1. lowercase the title;
2. replace every run of characters that are not `a-z` or `0-9` with a single
   `-`, and drop any `-` at the start or end;
3. keep the first four words (split on `-`), joined with `-`.

Example: `Add CSV export for portfolios (v2)` on issue 42 becomes
`specs/42-add-csv-export-for/spec.md`. The run phase recomputes this from
the title on the tracker, so the folder name must match the title as it is
when the run starts; do not rename the issue afterwards without renaming
the folder.

## 6. Clarify

Follow `.sous/skills/grill-with-docs/SKILL.md`. It drives
`.sous/skills/grilling/SKILL.md` (one question at a time, with your
recommended answer, until shared understanding) and
`.sous/skills/domain-modeling/SKILL.md` (challenge terms, probe with
scenarios, cross-check the code).

- Grill the intent from the issue body and the conversation until the design
  is crisp. Resolve every open question now; the run phase is headless and
  nobody answers questions there. In amend mode, grill the new scope only.
- **Amend mode with nothing new:** when the human confirms that the
  conversation adds no scope, skip step 7 and go to step 8, which still
  checks the children or the criteria. Do not invent an amendment.
- Record durable decisions as ADRs in `docs/adr/` using
  `.sous/skills/domain-modeling/ADR-FORMAT.md` (next free number,
  short), and new domain terms in the glossary per
  `.sous/skills/domain-modeling/CONTEXT-FORMAT.md`. Offer an ADR only
  when the decision is hard to reverse, surprising without context, and the
  result of a real trade-off.
- If the grilling sharpened the problem statement, you may
  **update the body** of the issue so that it stays a faithful summary. Tell the human
  what you will change before you do it. Keep the title unchanged unless the
  human asks for a rename, and if the title does change before the spec
  folder exists, derive the slug from the new title.

## 7. Spec

Follow `.sous/skills/to-spec/SKILL.md`: no further interview, synthesise
what was discussed, confirm the test seams with the human, then write the spec.
The spec is a file, not a tracker entry.

**Spec path:** `specs/<ISSUE>-<slug>/spec.md` in the target, by the slug rule.

<!-- ADAPT: The headings are yours to choose; the run hands the whole file to its steps as `ctx.spec`. -->
**Create mode:** write the file with this header block and the standard
headings in exactly this order (the run phase and the reviewer rely on them):

```markdown
# Spec: <issue title>

- **Issue:** REF
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

- **Issue:** REF
- **Status:** draft
```

followed by the same standard subsections as `###` headings, covering only the
new scope. Existing text stays untouched.

## 8. Children or criteria

### Features

Follow `.sous/skills/to-tickets/SKILL.md` for drafting and quizzing; what
gets published is defined here.

1. **Reconcile the existing children.** **List the children** of the issue
   and read each one. A closed child, or one carrying a state label, is
   left as it is. For every other child whose body is not in the **child
   shape** of the sheet: show the human the rewrite first, then **update
   the body**: the author's text goes under `## What to build` unchanged,
   the acceptance criteria are derived from it, and the blockers it names
   become edges. **Set the kind** to task where it is missing. A child that
   is already in shape is left as it is.
2. **Draft** tracer-bullet vertical slices from the spec for what the kept
   children do not cover: each a narrow but complete path through every
   layer, demoable on its own, sized for one fresh context window;
   prefactoring first; wide refactors as expand, migrate, contract. Give
   each slice its blocked-by edges, to kept children where the order needs
   them. In amend mode, draft only the slices for the amendment. When the
   kept children cover the spec, there is nothing to draft.
3. **Quiz the human** on granularity and edges as the skill describes, and
   iterate until they approve the breakdown. Nothing is published before that.
4. **Publish**, blockers first so every edge can reference a real id, one
   child per slice: **create a child** of the issue with the kind task, the
   body in the **child shape**, and **add a blocker** for each edge. The
   run phase picks the first open child whose blockers are all closed, in
   the order the sheet describes, so publishing in dependency order also
   gives a sensible default order.

<!-- ADAPT: The body sections your steps parse (here `## What to build` and `## Acceptance criteria`, which implement and review receive as one body) are the child shape in the tracker sheet. -->
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
This applies to a child's acceptance criteria and to the checklist of a task
or bug below.

### Tasks and bugs

A task or bug has no children. The run phase builds and reviews it from the
issue itself, so the issue must carry an acceptance criteria checklist,
written to the same rules as a slice's criteria (behaviour or a named test,
never a gate command). If the issue already has criteria that match the
spec, leave them. Otherwise draft them from the spec, show them to the
human, and after their approval **set the acceptance criteria**, which
replaces the existing checklist rather than appending to it.

## 9. GO gate

First check what changed in the target: `git status --porcelain` limited
to the spec folder, `docs/adr/` and the glossary.

- **Nothing to commit:** skip the gate. Report as in step 10, listing the
  children you rewrote, if any, and stop. Issue edits were each announced
  on their own; nothing is committed.
- **Something to commit:** before any `git commit` or `git push`, show the
  human a summary:
  - the target (base checkout, or the worktree on the branch);
  - the spec path, and whether it was created or amended;
  - the ADRs and glossary changes, if any;
  - the children: id, title and blockers, with the ones you rewrote marked;
    or the acceptance criteria added to a task or bug;
  - every issue edit you made.

  Then ask for an explicit GO. This is a soft gate: nothing enforces it, so
  do not proceed on silence or on anything less than a clear yes. If the
  human asks for changes, go back to step 6 with them and present the
  summary again.

<!-- ADAPT: The files the session may have touched. -->
Only after GO. The target is the base checkout:

```bash
git add specs/<ISSUE>-<slug>/spec.md
git add docs/adr/<new or changed ADRs> CONTEXT.md   # only the files you touched
git commit -m "spec(REF): spec"                     # amend mode: "spec(REF): amend — <short title>"
git pull --rebase origin <baseBranch>
git push origin <baseBranch>
```

The target is the worktree of a blocked run:

```bash
git -C <worktree> add specs/<ISSUE>-<slug>/spec.md
git -C <worktree> add docs/adr/<new or changed ADRs> CONTEXT.md   # only the files you touched
git -C <worktree> commit -m "spec(REF): amend — <short title>"
```

No push: the amendment reaches the base with the run's merge and dies with
a `--restart`. Add only the paths named above; the worktree may hold the
run's uncommitted work.

Plain commit message, no `Co-Authored-By` and no other trailers. Never create
a branch, never force-push. If the rebase conflicts, stop and show the human.

## 10. Sanity report

Finish with a short report (nothing is enforced, this is for the human):

- the target, the spec path and the commit sha, or "already planned,
  nothing committed";
- the children in dependency order, with their blockers, and which ones
  were rewritten; or, for a task or bug, confirmation that the issue has
  acceptance criteria;
- for a worktree commit: the amendment is on the branch and reaches the
  base with the merge;
- the next command: `./sous run <flow> <ISSUE>`, where `<flow>` is the flow
  in `.sous/flows/` whose `allowedLabels` include the `type:*` label the
  tracker reports for the issue's kind (`sous run` refuses any other). For
  a blocked run that is the same command the blocked comment names; the run
  re-enters at the blocked step.
