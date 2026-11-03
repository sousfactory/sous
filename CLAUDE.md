# Repository guide

sous: a software factory for coding agents, as an npm workspace in
TypeScript. This file is an orientation map; the linked documents own the
rules and procedures.

## Sources of truth

- [Contributing](CONTRIBUTING.md): build and verify commands, how changes
  are tested, commit messages, releasing. Read it before the first commit.
- [The manual](docs/manual.md): what sous is and how a project uses it;
  the reference for steps, flows, expressions, settings, trackers.
- [Changelog](CHANGELOG.md): one section per version, the `Unreleased`
  section first; a change people would notice gets a line there.

Work is tracked as GitHub issues in a separate private repository; a
reference like `planning#10` is one of them.

## Code map

| Folder | What it is |
| --- | --- |
| `packages/core` | The engine, published as `sous-factory`: CLI (`src/cli.ts`, `src/commands/`), YAML loading (`src/config/`), the executor and `ctx` (`src/exec/`), the ports (`src/ports/`) and their adapters (`src/adapters/`: git, GitHub, beads, local issues, host exec, the sandbox and the agent providers under `agents/`), the run record (`src/session/`). Tests in `test/`, fakes in `test/fakes/` published as `sous-factory/testing`. |
| `packages/ui` | The run viewer: a Vite app in `src/`, its server in `server/`, bundled into the core package at build. |
| `starters/default` | What `sous init` copies into a project: flows, steps, prompts, templates, trackers, vendored skills, and the project's own tests. Not a workspace; it depends on the published package. |
| `skills/` | `sous-setup` and `sous-migrate`, Claude Code skills for adopting sous in a repository. |
| `docs/` | The manual and the plan-phase diagram. |

The engine never imports a project: it loads steps, flows and the tracker
from `.sous/` at run time. The public surface is `sous-factory`,
`sous-factory/read` and `sous-factory/testing`.
