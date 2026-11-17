# Changelog

What changed for people who run sous, write steps or adapt the starter.
One section per version, newest first; the release workflow publishes the
section of the tagged version as the GitHub Release. Versions before 0.4.0
are described in their annotated tag messages (`git tag -n99 v0.3.0`).

## Unreleased

### Breaking

- **A project tracker module implements `list`.** `sous validate` and
  `sous run` report a module without it as lacking `list`; one that has
  no way to search returns the matching issues it knows of, or `[]`, in
  ascending numeric id order, as the `Tracker` port now says.

### Changed

- **`sous run` prints what a code step did.** After a module step's
  `start` line the run prints the step's summary, so the output shows
  `merge: squashed … into main as abc1234, pushed main to origin`, the
  line `sous watch` passes on for the runs it starts.
- **`/sous-plan` labels what it plans `repo:<name>`.** At GO the issue and
  every child get one `repo:<name>` label, created in the tracker when
  missing: the repository's own name, or in a home repository the `repos:`
  entry the session asks for first, whose checkout then supplies the
  settings, tracker and templates and receives the spec and its commit. A
  feature's children carry the parent's label; a feature split across
  repositories is refused as an epic. The tracker sheets
  gain **set the repo label**, and `templates/child.md` names the label.
- **`/sous-plan` asks whether the work may start now.** After GO and
  publishing, a second gate asks one question, recommending yes. On a yes
  the session sets `sous:ready` on the planned issue, never on a feature's
  children, creating the label where the tracker needs it, so `sous watch`
  picks it up; on a no the report names `sous:ready` as the manual step
  beside `./sous run`. The ground rules make `sous:ready` the one state
  label the session may set; it still never runs `./sous`. The tracker
  sheets gain **set ready**.

### Added

- **`tracker.list({ labels })`: the open issues carrying every named
  label, in ascending numeric id order.** The GitHub tracker pages through
  every matching issue with `gh api --paginate` (no cap; pull requests
  left out), beads asks `bd list`, the local tracker scans its folder, and
  `fakeTracker` in `sous-factory/testing` answers from its seeded issues.
  Closed issues and issues carrying only some of the labels are left out.
- **The starter `merge` step pushes what it merged, when asked.** With
  `push: origin` on its entry it fast-forwards the base branch from
  `origin` before the freshness check (a moved remote base routes back to
  `sync` under `resync`), squashes, and pushes the base branch, all under
  the repository lock; the summary and the issue comment name the push. A
  base that diverged from the remote's fails the step before squashing; a
  failed push keeps the squash locally and says so on the issue. Without
  the input nothing is fetched or pushed. The starter flows show the line
  commented out. The git port gains `fastForward(cwd, branch, remote)` and
  `push(cwd, branch, remote)`, and `fakeGit` in `sous-factory/testing`
  scripts them (`remoteAhead`, `diverged`, `pushError`, `pushed`).
- **`sous watch` runs the repository unattended.** It polls the tracker
  (every 60 seconds, `--interval <seconds>`) for open issues labelled
  `<prefix>:ready` with no open blockers and starts the repository's own
  `sous run <flow> <issue>` for the lowest-numbered one whose `type:*`
  label exactly one flow accepts, one run at a time, counting a run
  started by hand. A blocked issue runs again once it also carries ready;
  a `<prefix>:running` issue with a stale lock is rerun once, and blocked
  with a comment naming its log folder when the rerun crashes too; setting
  ready on it hands it back to the same daemon. A ready issue whose lock
  names a dead pid has the lock removed before it starts. `--once` makes
  one pass and waits for its run; Ctrl-C or SIGTERM goes to the run's
  whole process group (the `.sous/sous` wrapper and the run under it),
  which records the interrupt, and once a signal has arrived no run
  starts, wherever the pass was. One `sous watch` per project
  (`.sous/locks/watch.pid`); skips are reported once, a quiet pass prints
  nothing. Manual how-to 20, "Run as an automated loop".
- **A blocker in another GitHub repository.** A `## Blocked by` line
  `owner/repo#n` is asked of that repository by the GitHub tracker in
  `blockers()` and `isClosed()`; the beads and local trackers fail with
  an error naming the reference, and `sous watch` skips the issue.
- **A home repository serves several repositories.** `repos:` in its
  `sous.yaml` maps names to checkout paths (relative to the repository,
  absolute or `~`; a plain list of paths is named by folder), each with
  its own `.sous/`; `sous validate` reports a path without one, and one
  whose `.sous/` has no `sous` wrapper. `sous watch` there asks each
  listed repository's tracker and starts its own `.sous/sous run <flow>
  <issue>` in it, never on the home repository's engine: an entry without
  `.sous/sous` is reported once and runs nothing. One run per repository,
  repositories in parallel. An issue runs in the entry its `repo:<name>`
  label names; one without the label or naming no entry is reported once
  and skipped. Without `repos:`, `sous watch` skips an issue labelled for
  another repository, whose name is `name:` in `sous.yaml`, else the
  `origin` remote's repository, else the folder.
- **The GitHub tracker takes `trackerOptions: { repo: owner/name }`.**
  Every `gh` call addresses that repository (`-R`, or the path of a `gh
  api` endpoint), so a repository whose issues live elsewhere needs no
  `GH_REPO`. Without it `gh` infers the repository from the checkout.
- **`sous ui` over `repos:` lists the runs of every listed repository.**
  One list with the repository's folder in a column; a run opens with its
  flow graph, steps and logs as before, and a step change in any listed
  repository reaches the open page live. A run record on another session
  schema version is listed with its issue, title, flow and branch where
  they read, marked unreadable with its version, and the rest of the page
  renders. A listed repository whose `sous.yaml` the home engine cannot
  read (a newer engine's key, say) is one error row naming the problem,
  and the server starts. Without `repos:` the UI is unchanged.
- **`sous ui` refuses to start on a `repos:` problem.** A listed path
  without a `.sous/sous.yaml`, or two entries under one name, is printed
  and the UI exits 1, as `sous watch` does.
- **`name:` in `sous.yaml`.** The repository's name in `repo:<name>`
  labels; unset, the repository part of the `origin` remote, else the
  folder.
- **`sous-factory/read` exports `repoEntries`, `repoProblems` and
  `RepoEntry`.** The listed repositories of a home project with absolute
  paths, and what `sous validate` says about them, for tools that read
  a project beside the engine.

## 0.8.0

### Breaking

- **Session schema 9.** The step record gains `costUsd` and `costUnknown`.
  A run in flight under 0.7.0 does not survive the upgrade: `sous run` and
  `sous status` reject its `session.json` with the another-schema error.
  Finish or `--restart` such runs before upgrading the engine.
- **The starter's flows change shape.** `check-issue` sits after `init`
  in the task flow and after `next-work` in the feature flow, and
  `implement` takes a new `divergence` input. A project on the 0.7.0
  starter keeps working as it is; one that adopts `check-issue` copies
  `steps/check-issue/`, the flow entries and the `divergence` input.

### Added

- **What an agent call cost, in the run record, in `sous status` and in
  flows.** The Claude CLI's `total_cost_usd` becomes `costUsd` on the
  call's `iteration.agent.end` event; a call whose CLI reports no cost
  (Codex) carries none, never `0`. `sous status <issue>` shows
  `cost $x.xx` on every step line and on the run line, with a trailing
  `+` when some call reported no cost and nothing when none did. The step
  record gains `costUsd` and `costUnknown`, summed over every visit and
  iteration of the step for the work item, so a flow can route on money:
  `when: steps.fix.costUsd > 20`. `agentResult` in `sous-factory/testing`
  takes an optional cost as its third argument; `formatCost` is exported
  from `sous-factory/read`. **The session schema goes to 9:** a run in
  flight under an older engine does not survive the upgrade; `sous run`
  and `sous status` reject its `session.json` with the another-schema
  error. Finish or `--restart` such runs.

- **What a run cost, in `sous ui`.** Each agent iteration shows its cost
  after its token counts, the run's step table has a `Cost` column beside
  `Duration`, and the run header shows the run's total with its duration;
  a `+` marks a lower bound and its tooltip says how many agent calls
  reported no cost. A run without a costed call shows no figure, never
  `$0.00`. The strings are the ones `sous status` prints.

- **The starter's `check-issue` step.** The task flow runs it after
  `init`, the feature flow for each child after `next-work`, before
  anything is planned or built: an agent, read-only on the code, checks
  whether the issue still holds against the worktree and answers `holds`,
  `fixed`, `false-premise` or `unclear` with each command it ran and its
  result as the evidence. `holds` and `unclear` go on; `fixed` and
  `false-premise` stop the run as blocked with the evidence as the
  comment, and the human closes or rewrites the issue, never the run. A
  partly false issue whose defect is real goes on with the divergence as a
  line under the spec's `## Decisions`; with no spec on the branch yet,
  `plan` gets the lines through its new optional `divergence` input. In
  the feature flow `implement` gets them through its new `divergence`
  input and the child's `review` as a `## Decisions` section of its
  criteria; a project on an older starter that adopts `check-issue` adds
  `divergence` to its `implement` entries in both flows. A
  child closed after such a block is skipped without an agent on the next
  run. One more agent call per issue; a project that does not want it
  deletes the entry and points `init` at `plan` (task) or `next-work` at
  `implement` (feature). Projects on an older starter copy
  `steps/check-issue/` and the flow entries to adopt it.

- **`run: { shell }`.** A third kind of step beside `run.prompt` and
  `run.module`: a deterministic command run once per visit in the
  worktree, a `step.yaml` alone. Its `result.output` is
  `{ stdout, stderr, code }` plus `json` when the whole of stdout parses
  as JSON, so `when: result.output.code !== 0` and
  `when: result.output.json.count > 0` route; a non-zero exit is not a
  failure by itself. Inputs reach the command as `SOUS_INPUT_<NAME>`
  (`diffRange` is `SOUS_INPUT_DIFF_RANGE`), the run's facts as
  `SOUS_WORKTREE`, `SOUS_BRANCH`, `SOUS_BASE_BRANCH` and the rest; nothing
  is spliced into the command line. `sous validate` rejects `agent:` and
  `prepare` on a shell step and two inputs on one variable.
  `fakeSandbox().execCalls` in `sous-factory/testing` records the `env`
  a call passed. No upgrade step is needed; only a project test that
  reads `step.run.module` once `prompt` is ruled out must now rule out
  `shell` too, as the starter's `test/steps/steps.test.ts` does.

### Fixed

- **`Sandbox.close()` is idempotent.** A run whose worktree was already
  gone when the starter's `merge` ran (a flow that removes it in a step of
  its own, or a rerun of a `merge` that crashed after its clean-up) ended
  `crashed` with `exec failed: spawn sh ENOENT` and `sous run` exited 1,
  though the work had shipped. `close()` now resolves without running
  anything when the worktree directory does not exist, and `merge` labels,
  comments and answers `already in <base>`. A host command whose working
  directory does not exist now fails with
  `exec failed: spawn sh ENOENT (cwd <path> does not exist)`, which
  `ctx.exec` reports as its stderr. No upgrade step is needed; the
  starter's `merge` is unchanged.

## 0.7.0

### Added

- **`uiPort` in `sous.yaml`.** The port `sous ui` listens on at
  127.0.0.1, default 4680, so two projects on one machine each keep their
  own; `--port <n>` still wins for one start. The starter's `sous.yaml`
  writes it out. A taken port now ends in one line,
  `sous ui: port <n> is in use (another sous ui, or another project?); set uiPort in sous.yaml or pass --port`,
  and exit status 1 instead of a stack trace. No upgrade step is needed:
  without the key `sous ui` listens on 4680 as before.
- **`ctx.baseBranch`.** The `baseBranch` setting from `sous.yaml`, beside
  `ctx.branch`, readable in `when:` and `${{ }}` expressions, in modules
  and in evals; it is not a prompt placeholder. The starter's task and
  feature flows pass it to the sync and merge entries and diff
  `<baseBranch>...HEAD` in review-full and fix-review-full, and the verify
  eval takes its diff scope from it: `BASE_BRANCH` is gone from
  `steps/verify/eval.ts`. On a base other than `main`, setting
  `baseBranch` is now the whole migration. `ctxOf` and `portsOf` in
  `sous-factory/testing` take a `baseBranch` option, default `main`.

### Fixed

- **The review range survives an implement that committed nothing.** The
  starter's review and fix entries diffed
  `steps.implement.commits[0] + "^..HEAD"`, which became
  `undefined^..HEAD` when implement recorded no commits (the work was
  already on the branch), and the reviewer's `git diff` failed. Both
  flows now fall back to `<baseBranch>...HEAD`: the whole branch, which in
  the feature flow is wider than the slice but never skips the gate.

  To upgrade, copy `flows/task.yaml`, `flows/feature.yaml` and
  `steps/verify/eval.ts` from the starter, keeping your filled `CHECKS`
  in the eval. If your flows diverged, make three edits per flow instead:
  `baseBranch: ${{ ctx.baseBranch }}` on sync and merge,
  `diffRange: ${{ ctx.baseBranch + "...HEAD" }}` on review-full and
  fix-review-full, and on review and fix
  `diffRange: '${{ steps.implement.commits[0] ? steps.implement.commits[0] + "^..HEAD" : ctx.baseBranch + "...HEAD" }}'`
  (quoted: the ` : ` is not allowed in a plain YAML value). The setup
  checklist and the starter README no longer mention a base constant.

- **`- None.` is not an open question.** The spec template suggests
  `None.` for an empty `## Assumptions` or `## Open questions` list, and
  the starter's `plan` eval counted it as one item, so a spec with no open
  questions blocked the run at `plan` with "leaves 1 question open: None.".
  The eval now ignores an item that is only `None` or `None.`, in any
  case, and counts no assumption for it; the template says `None.` is the
  only item. Projects copy `steps/plan/eval.ts` and `templates/spec.md`
  from the starter.

## 0.6.0

### Changed

- **The sandbox is sous's own; `@ai-hero/sandcastle` is gone.** The
  engine runs the agent CLI itself: one module per agent
  (`adapters/agents/claude.ts`, `codex.ts`) builds the command line and
  parses the streamed lines; the host runner spawns it with the prompt on
  stdin in its own process group, applies the idle timeout and ends it on
  interrupt; the worktree comes from `git worktree add` on the git port.
  Behaviour that follows: the session id is carried by every provider, so
  resume is a provider capability and no longer a reason to keep a CLI out
  (sousfactory/planning#1 is closed); token usage is reported for Codex as
  well as Claude; the skill audit sees every tool call with its full input;
  Codex gets `--dangerously-bypass-approvals-and-sandbox` explicitly, as
  Claude gets `--permission-mode bypassPermissions`; a run no longer
  touches the host's global git config; Ctrl-C needs no listener juggling.
  The agent log keeps the agent's prose and one line per tool call, as
  before, under the same name.

- **Worktrees live under `.sous/worktrees/<branch-with-dashes>/`**, not
  `.sandcastle/worktrees/`. A run started before this release is found
  where its branch is checked out and goes on there; `--restart` removes
  it from there too. The worktree of a branch checked out anywhere else
  (the primary checkout, say) is refused instead of adopted. `sous init`
  writes `worktrees/` into `.sous/.gitignore`.

- **Upgrading a project from 0.5.0.** Add `worktrees/` to
  `.sous/.gitignore`. Nothing else: flows, steps, prompts and settings are
  unchanged, and `idleTimeoutSeconds` means what it did. A reused clean
  worktree is no longer fast-forwarded from `origin` on open; pull the
  branch yourself when it moved elsewhere.

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
