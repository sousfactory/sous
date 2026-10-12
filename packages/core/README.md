# sous-factory

*Agents do the work. The graph decides what happens next.*

**A software factory for coding agents, on your machine.** `sous` runs your
software development flow with coding agents: implement, review, fix,
merge, or any step you write. The flow is a deterministic graph in YAML,
like a GitHub Actions workflow.

This package is the engine: the executor, the `sous` CLI, the trackers
(GitHub, beads, local files, or a module of your own), the sandbox, the run
record, the live run viewer (`sous ui`) and the starter that `sous init`
copies into a repository. It ships no steps of its own: the steps and flows
live in your repository's `.sous/` and are yours to edit.

## Install

Once per machine: Node 22, `gh auth login`, and `claude` or `codex` on the
`PATH`. Then, from a repository's root:

```
npm install -D sous-factory
npx sous init                 # copies the starter into .sous/, installs it, adds /sous-plan
cd .sous && ./sous validate
./sous run bench <issue>      # a smoke test; touches neither the issue nor the code
```

`init` ends with a checklist of what to adapt by hand. For a guided setup in
Claude Code, install the
[`sous-setup` skill](https://github.com/sousfactory/sous/tree/main/skills/sous-setup)
from the repository first and run `/sous-setup`; it does the install and
init too.

## Documentation

- [Homepage](https://sousfactory.com): what sous is and why.
- [README](https://github.com/sousfactory/sous#readme): quick start, how
  it works, what is in the box.
- [The manual](https://github.com/sousfactory/sous/blob/main/docs/manual.md):
  getting started, concepts and reference, the
  [CLI](https://github.com/sousfactory/sous/blob/main/docs/manual.md#12-cli),
  how-tos.
- [The starter](https://github.com/sousfactory/sous/tree/main/starters/github):
  the flows and steps `sous init` copies, with a README per step.
- [`sous-factory/testing`](https://github.com/sousfactory/sous/blob/main/docs/manual.md#20-test-steps-and-flows):
  the fakes and the harness for a project's own tests.

MIT.
