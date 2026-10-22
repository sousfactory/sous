# Changelog

What changed for people who run sous, write steps or adapt the starter.
One section per version, newest first; the release workflow publishes the
section of the tagged version as the GitHub Release. Versions before 0.4.0
are described in their annotated tag messages (`git tag -n99 v0.3.0`).

## Unreleased

### Changed

- **The spec is read from the worktree.** `sous run` reads
  `specs/<id>-<slug>/spec.md` from the run's worktree at every start, not
  from the primary checkout, so the spec travels with the branch: an
  amendment committed on the branch while the run was blocked reaches the
  next start, and a run on another machine sees the same text. A new run
  whose checkout has no planned folder looks for one on the branch too.
  The first run forks the branch from the local base, so pull before the
  first start when the spec was pushed from elsewhere. The starter's
  implement prompt forbids edits under the spec folder.

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
