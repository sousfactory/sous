<!-- TEMPLATE: the /sous-plan skill starts this prompt. It is the plan prompt for `tracker: beads`; `sous-setup` moves it over `plan.md` when the project tracks its work in bd. Review every ADAPT note against your steps and repository, then delete the notes. -->
# sous plan: from an idea to a spec and runnable beads

You are running the plan phase of `sous` (the factory: https://github.com/sousfactory/sous/blob/main/docs/manual.md;
this prompt is the plan phase's only description). This is one interactive
session with a human. You turn a bead (an issue in `bd`, the beads tracker)
into a committed spec and, for a feature, into child beads the run phase can
pick up with `./sous run <flow> <id>`. Nothing here is automated; the human is
in the loop for every decision, and every destructive step (bead edits,
commits, pushes) is announced first.

## Inputs

- `ISSUE`: an optional bead id, passed as the skill argument
  (`/sous-plan bd-a3f8`).
- If `ISSUE` is absent, there is no bead yet. Make one before anything else:
  1. Ask the human for a one-line title and the problem to solve, unless the
     conversation already contains both. Keep the title stable: the spec
     folder and the issue branch are derived from it (see the slug rule).
  <!-- ADAPT: The bead types must map onto your flows' `allowedLabels` (the run phase reads an epic or feature as `type:feature`, a bug as `type:bug`, anything else as `type:task`); the commit prefix rule is what this repository's merge step does. -->
  2. Ask which kind of work this is: a **feature** (several vertical slices,
     each a child bead of an epic) or a single **task** or **bug** (one bead,
     no slices). The bead type decides the label the run phase matches
     (`type:feature`, `type:task`, `type:bug`) and the landing commit prefix:
     a task or bug lands as `fix(<id>): …`, everything else as `feat(<id>): …`.
  3. Create the bead; `--silent` prints only its id:
     ```bash
     bd create --title "<title>" --type epic --description "<problem statement>" --silent
     ```
     (`--type task` or `--type bug` instead of `--type epic` for a task or
     bug.) From here on treat the printed id as `ISSUE`.
- With `ISSUE` present, read it in full first: `bd show <ISSUE> --json`. If
  its type is none of epic, feature, task or bug, ask the human which kind it
  is and set it with `bd update <ISSUE> --type …`.

## Preconditions

Check these before doing anything else and stop with a clear message if one
fails:

- You are in the primary checkout on `main` (`git branch --show-current`),
  and the tree is clean (`git status --porcelain` prints nothing).
- The bead is open (`status` is not `closed`).
- The bead is not itself a child of another bead (`parent` is empty);
  children are planned through their parent.

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
<!-- ADAPT: The skills under `.sous/skills/` are vendored from https://github.com/mattpocock/skills (grill-with-docs, grilling, domain-modeling, to-spec, to-tickets; see `.sous/skills/VENDORED.md`); copy them or point at your own. -->
- Where a vendored skill says to run `/setup-matt-pocock-skills`, to publish to
  an issue tracker, or to apply a `ready-for-agent` label: ignore it. Beads
  and the spec file are the outputs. Never set a label: the run phase derives
  the `type:*` label from the bead type and sets its own `sous:*` labels.
  Where a skill names another skill by slash command, use the vendored copy
  under `.sous/skills/`.
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

- Grill the intent from the bead's description and the conversation until the
  design is crisp. Resolve every open question now; the run phase is headless
  and nobody answers questions there.
- Record durable decisions as ADRs in `docs/adr/` using
  `.sous/skills/domain-modeling/ADR-FORMAT.md` (next free number,
  short), and new domain terms in the glossary per
  `.sous/skills/domain-modeling/CONTEXT-FORMAT.md`. Offer an ADR only
  when the decision is hard to reverse, surprising without context, and the
  result of a real trade-off.
- If the grilling sharpened the problem statement, you may update the bead's
  description so that it stays a faithful summary. Tell the human what you
  will change before you do it, then apply it with `bd update <ISSUE>
  --body-file <file>`. Keep the title unchanged unless the human asks for a
  rename, and if the title does change before the spec folder exists, derive
  the slug from the new title.

## Step 2: Spec

Follow `.sous/skills/to-spec/SKILL.md`: no further interview, synthesise
what was discussed, confirm the test seams with the human, then write the spec.
The spec is a file, not a tracker entry.

**Spec path:** `specs/<ISSUE>-<slug>/spec.md`, where `<slug>` is computed from
the bead's title exactly like the run phase does it:

1. lowercase the title;
2. replace every run of characters that are not `a-z` or `0-9` with a single
   `-`, and drop any `-` at the start or end;
3. keep the first four words (split on `-`), joined with `-`.

Example: `Add CSV export for portfolios (v2)` on bead `bd-a3f8` becomes
`specs/bd-a3f8-add-csv-export-for/spec.md`. The run phase recomputes this
from the title in bd, so the folder name must match the title as it is when
the run starts; do not rename the bead afterwards without renaming the folder.

<!-- ADAPT: The headings are yours to choose; the run hands the whole file to its steps as `ctx.spec`. -->
**Create mode:** write the file with this header block and the standard
headings in exactly this order (the run phase and the reviewer rely on them):

```markdown
# Spec: <issue title>

- **Issue:** <ISSUE>
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

- **Issue:** <ISSUE>
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
3. **Publish**, blockers first so every edge can reference a real id, one
   child bead per slice:
   <!-- ADAPT: The fields your steps read (here the description as "what to build" and the acceptance criteria, which the run phase hands to implement and review as one body) and the slice type (one that maps onto a flow's `allowedLabels`). -->
   - Create it as a task under the parent. The description is what to build;
     the acceptance criteria go into bd's own field, which the run phase
     appends to the body under `## Acceptance Criteria`. Blockers are `blocks`
     dependencies, not text in the body.

     ```markdown
     The end-to-end behaviour this slice makes work, from the user's
     perspective, not a layer-by-layer list.
     ```

     ```bash
     bd create --title "<slice title>" --type task --parent <ISSUE> --body-file <file> \
       --acceptance "- [ ] Criterion 1
     - [ ] Criterion 2" --silent
     bd dep add <child> --blocked-by <m>          # once per blocker; none for a slice that can start immediately
     ```

   - A slice gets no label. No status either: the run phase keys on
     open/closed state plus the `blocks` edges and sets its own `sous:*`
     labels.
   - The run phase picks the open child with the highest priority, oldest
     first, whose blockers are all closed. Leave the priority at its default
     and publish in dependency order, so creation order is the default order.

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
This applies to a slice's `--acceptance` criteria and to the checklist of a
task or bug below.

### Tasks and bugs

A task or bug has no children. The run phase builds and reviews it from the
bead itself, so the bead must carry acceptance criteria, written to the same
rules as a slice's criteria (behaviour or a named test, never a gate command).
Draft them from the spec, show them to the human, and after their approval
write them into the bead with `bd update <ISSUE> --acceptance "<checklist>"`
(the description stays as it is).

## GO gate

Before any `git commit` or `git push`, show the human a summary:

- the spec path, and whether it was created or amended;
- the ADRs and glossary changes, if any;
- the child beads: id, title and blockers, or the acceptance criteria added
  to a task/bug bead;
- every bead edit you made.

Then ask for an explicit GO. This is a soft gate: nothing enforces it, so do
not proceed on silence or on anything less than a clear yes. If the human asks
for changes, make them and present the summary again.

<!-- ADAPT: Your base branch and the files the session may have touched. -->
Only after GO:

```bash
git add specs/<ISSUE>-<slug>/spec.md
git add docs/adr/<new or changed ADRs> CONTEXT.md   # only the files you touched
git commit -m "spec(<ISSUE>): spec"                 # amend mode: "spec(<ISSUE>): amend — <short title>"
git pull --rebase origin main
git push origin main
```

Plain commit message, no `Co-Authored-By` and no other trailers. Never create
a branch, never force-push. If the rebase conflicts, stop and show the human.

## Sanity report

Finish with a short report (nothing is enforced, this is for the human):

- spec path and commit sha;
- child bead ids in dependency order, with their blockers; or, for a
  task/bug, confirmation that the bead has acceptance criteria;
- the next command: `./sous run <flow> <ISSUE>`, where `<flow>` is the flow
  in `.sous/flows/` whose `allowedLabels` include the `type:*` label the run
  phase derives from the bead type (`sous run` refuses any other).
