# sous-factory

*Issue in, merged commit out.*

A local software factory, run like a kitchen: you write the menu, `sous`
runs the line, and nothing is served that did not pass the pass. The name
is the sous-chef, the one who actually runs service. You plan an issue with
an agent in the loop; `sous` builds, reviews, fixes and merges it without
one. It runs on your machine, in a git worktree, with the `claude` or
`codex` CLI you already have.

This package is the engine: the executor, the `sous` CLI, the trackers
(GitHub, beads, local files, or a module of your own), the sandbox, the run
record, the live run viewer (`sous ui`) and the starter that `sous init`
copies into a repository. It ships no steps of its own: the steps and flows
live in your repository's `.sous/` and are yours to edit.

## Why

- **Like GitHub Actions, but for agents and local.** Flows are YAML, steps
  are reusable units, routes make a graph; your flows are yours.
- **Deterministic shell, agentic core.** The agent works only in a worktree
  and answers with one JSON envelope; the executor renders, evaluates and
  routes. It never asks the agent what happens next.
- **Evals judge the work, not the agent's word.** A failed eval retries in
  the same session; after the cap the run stops `blocked` instead of
  guessing, and the same command continues it once you fixed things.
- **Tracker-agnostic.** GitHub out of the box, `bd` and local files built
  in, or a tracker module of your own.

## Install

Once per machine: Node 22, `gh auth login`, and `claude` or `codex` on the
`PATH`. Then, from a repository's root:

```
npm install -D sous-factory
npx sous init                 # copies the starter into .sous/, installs it, adds /sous-plan
cd .sous && ./sous validate
./sous run bench <issue>      # a smoke test; touches neither the issue nor the code
```

`init` ends with a checklist of what to adapt by hand: the check commands
in `steps/verify/eval.ts`, `sous.yaml`, the flows' models and labels, the
`ADAPT` notes in `prompts/plan.md`. For a guided setup in Claude Code,
install the
[`sous-setup` skill](https://github.com/sousfactory/sous/tree/main/skills/sous-setup)
from the repository first and run `/sous-setup`; it does the install and
init too.

## CLI

```
sous init [--starter <dir>] [--force] # copy a starter into .sous/, npm install, add /sous-plan, print the checklist
sous run <flow> <issue> [--restart]   # validate, then start or continue; <issue> is the tracker's id (96, #96, a bead id)
sous status <issue>                   # session facts and the timeline
sous graph <flow>                     # Mermaid diagram from the YAML
sous validate                         # sous.yaml, every flow and step, the tracker module
sous ui [--port n]                    # the run viewer on 127.0.0.1:4680
```

## Documentation

- [README](https://github.com/sousfactory/sous#readme): the concept, the
  flows, screenshots.
- [The manual](https://github.com/sousfactory/sous/blob/main/docs/manual.md):
  getting started, concepts and reference, how-tos.
- [The starter](https://github.com/sousfactory/sous/tree/main/starters/github):
  the flows and steps `sous init` copies, with a README per step.
- [`sous-factory/testing`](https://github.com/sousfactory/sous/blob/main/docs/manual.md#20-test-steps-and-flows):
  the fakes and the harness for a project's own tests.

MIT.
