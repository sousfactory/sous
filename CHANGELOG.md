# Changelog

What changed for people who run sous, write steps or adapt the starter.
One section per version, newest first; the release workflow publishes the
section of the tagged version as the GitHub Release. Versions before 0.4.0
are described in their annotated tag messages (`git tag -n99 v0.3.0`).

## 0.5.0

### Added

- **`templates/`.** The shapes the prompts write live in one folder:
  `spec.md` (the headings every step reads by name, each with a
  placeholder saying what it holds and who writes it; the prompts explain
  no section of their own) with `spec-amendment.md`, `child.md` (the body of a slice, with the parsing
  contract of the GitHub and bd trackers in its comment) and `task.md`
  (a lone issue). The plan prompt and the tracker sheets point at them
  instead of inlining headings; the sheets keep only how the parent and
  the blockers are expressed. The `plan` step reaches the folder through
  `ctx.templatesDir`, a new ctx value and prompt placeholder backed by
  the `templatesDir` setting (default `templates`). The starter tests
  read the templates and hold the prompts and the plan step's eval to
  them.

- **`## Decisions` in the spec.** The `implement` and `fix` steps may
  append one line per decision they make while building to a
  `## Decisions` section at the end of `spec.md`, with its reason, and
  may touch nothing else under the spec folder: a departure from a story
  or a testing decision, or a review finding the fix refutes. The review
  prompt judges the decision instead of flagging the departure, and a
  decision whose reason does not hold is a finding as the departure would
  be. The `plan` step writes the section empty; a spec from `/sous-plan`
  gets it on the first decision.

- **The `plan` step.** The task flow derives a spec from the issue when
  the branch has none: `init → plan → implement`. Prepare finds
  `spec.md` in the worktree and skips the agent; otherwise the agent
  restates the issue into the spec headings, decides what the issue left
  open by the simplest reading and lists each choice under
  `## Assumptions`, and leaves a question open only when the readings
  differ in observable behaviour or the choice is expensive to reverse.
  Open questions fail the eval and the flow stops `blocked` with them as
  the comment; answer them in the file or the issue and run again. The
  review prompt treats an assumption as no criterion and one that
  contradicts the issue as a blocker.

### Changed

- **Upgrading a project from 0.4.0.** Copy `templates/`, `trackers/` and
  `steps/plan/` from the starter into `.sous/`, replace `prompts/plan.md`
  with the starter's (`prompts/plan.beads.md` is gone: the one prompt
  speaks to every tracker through its sheet), put `plan` between `init`
  and `implement` in the task flow, and take the implement, fix and
  review prompts' new `## Decisions` rules. `templatesDir` defaults to
  `templates`, so `sous.yaml` needs no new key.

- **`ctx.spec` is resolved when each step starts**, from the worktree as
  it stands (one file read, never a tracker call), instead of once per
  run. A step that writes the spec is seen by the steps after it. The
  executor port `spec` is a function of the spec folder now; fakes built
  with `portsOf` follow.

- **The spec is read from the worktree.** `sous run` reads
  `specs/<id>-<slug>/spec.md` from the run's worktree at every start, not
  from the primary checkout, so the spec travels with the branch: an
  amendment committed on the branch while the run was blocked reaches the
  next start, and a run on another machine sees the same text. A new run
  whose checkout has no planned folder looks for one on the branch too.
  The first run forks the branch from the local base, so pull before the
  first start when the spec was pushed from elsewhere. The starter's
  implement prompt forbids edits under the spec folder.
- **One plan prompt, a sheet per tracker.** `prompts/plan.md` speaks to the
  tracker only through verbs that `trackers/<tracker>.md` defines; the
  starter ships `github.md`, `beads.md` and `local.md`, and a tracker
  module gets a sheet beside it. `prompts/plan.beads.md` is gone: a
  project that moved it over `plan.md` takes the new `plan.md` and keeps
  `tracker: beads` in `sous.yaml`. The local tracker can be planned
  against for the first time.
- **`/sous-plan` follows the run state.** A running issue is refused. A
  blocked issue whose worktree is on this machine is amended there and
  committed on the branch without a push; blocked elsewhere is refused.
  With no run, the spec is committed and pushed on the base branch as
  before. The skill reconciles a feature's existing children into the
  child shape before drafting the missing slices, and a rerun with no new
  scope changes and commits nothing. `docs/PLAN-SKILL-FLOW.md` draws the
  procedure.

## 0.4.0

### Breaking

- **The spec is `ctx.spec`.** `sous run` reads `specs/<id>-<slug>/spec.md`
  from the repository checkout at every start, committed or not, and hands
  the markdown to every step as `ctx.spec` (`{{ctx.spec}}` in prompts,
  `${{ ctx.spec }}` in flows, `ctx.spec` in modules and evals). Without a
  file the issue is the spec: its title and body. A run never writes or
  commits a spec. Projects whose prompts read `{{ctx.specDir}}/spec.md`
  from the worktree, or whose `init` writes a stub, should switch to
  `ctx.spec`; `ctx.specDir` stays as the folder path.
- **Starter `init` only guards.** It checks the issue is open and the
  worktree is on the run's branch, and writes nothing. `implement`, `fix`
  and `sync-resolve` inline `{{ctx.spec}}`; the task flow's reviews and
  the feature flow's `review-full` judge against `ctx.spec`.
- **Starter folder renamed** from `starters/github` to `starters/default`.

### Changed

- **Re-entry after `blocked` starts a fresh attempt.** The step still evals
  the recorded result first with a fresh counter, so a hand fix moves on
  without an agent call. If that eval fails, `prepare` runs again, the
  prompt is rendered again from the current inputs and goes to a fresh
  session with `resume:` honoured as on a first visit; the old session and
  its eval log are dropped. A rerun after a crash or Ctrl-C keeps
  continuing the same attempt. To change a spec or acceptance text while a
  run is blocked, edit it on the checkout or in the issue and run again;
  `--restart` is for a branch that is wrong.
- The `run.start` event records where the spec came from (`file` or
  `issue`); `sous status` and the UI show it on the run.

### Added

- `/sous-setup` asks whether work is tracked on GitHub or in bd, checks that
  tracker's prerequisites and writes the answer into `sous.yaml`. The
  starter ships `prompts/plan.beads.md`: the plan procedure over `bd`, with
  a feature as an epic, acceptance criteria in bd's own field and blockers
  as `blocks` dependencies.
- `CHANGELOG.md`, and a GitHub Release per tag with its section as notes.
