# sous-factory

*Issue in, merged commit out.*

A local software factory, run like a kitchen: you write the menu, `sous`
runs the line, and nothing is served that did not pass the pass. You plan
an issue with an agent in the loop; `sous` builds, reviews, fixes and
merges it without one, on your machine, in a git worktree, with the
`claude` or `codex` CLI you already have.

This package is the engine: the executor, the CLI (`sous`), the trackers
(GitHub, beads, local files, or your own module), the sandbox, the run
record, the live run viewer (`sous ui`) and the starter that `sous init`
copies into a repository. It ships no steps of its own: the steps and
flows live in your repository's `.sous/` and are yours to edit.

## Quick start

Once per machine: Node 22, `gh auth login`, and `claude` or `codex` on the
`PATH`. Then, from a repository's root:

```
npm install -D sous-factory
npx sous init                 # copies the starter into .sous/, installs it, adds /sous-plan
cd .sous && ./sous validate
./sous run bench <issue>      # a smoke test
```

`init` ends with a checklist of what to adapt by hand. For a guided setup
in Claude Code, install the `sous-setup` skill from the repository first
and run `/sous-setup`.

## Documentation

- [README](https://github.com/heerens/sous#readme): why, the concept, the
  flows, screenshots.
- [The manual](https://github.com/heerens/sous/blob/main/docs/manual.md):
  getting started, concepts and reference, how-tos.
- [`sous-factory/testing`](https://github.com/heerens/sous/blob/main/docs/manual.md#20-test-steps-and-flows):
  the fakes and the harness for a project's own tests.

MIT.
