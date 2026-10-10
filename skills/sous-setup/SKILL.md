---
name: sous-setup
description: Set up the sous software factory in this repository, step by step. Interactive: checks prerequisites, installs and inits sous-factory if .sous/ is missing, then adapts steps/verify/eval.ts, sous.yaml, the flows and prompts/plan.md with the human, verifies, and offers /sous-migrate for a development-loop skill the repository already has. Use as /sous-setup ("set up sous", "sous setup"); skips what is already done.
disable-model-invocation: true
---

Walk the human through the five setup steps below, in order. Before each
step, check its state and skip what is done; say in one line what you skip.
Ask for the facts you need, show every edit as a diff before writing it,
and write only after a yes. Never push. Never run `sous run` on a real
issue unless the human names one and agrees. Stop at a missing
prerequisite and say what to install.

## 1. Prerequisites

- `node --version` is 22 or newer.
- For `tracker: github` (the starter's default): `gh auth status` succeeds.
- The agent CLI the flows name (`claude` or `codex`, see `agent:` in
  `.sous/flows/*.yaml`, or the starter's default `claude`) is on the `PATH`.

## 2. Install and init

Skip when `.sous/sous.yaml` exists. Otherwise, from the repository root:

```
npm install -D sous-factory
npx sous init
```

`init` copies the starter into `.sous/`, installs it and places `/sous-plan`
under `.claude/skills/`. Read its checklist output.

## 3. Adapt, one file at a time

Read the file, propose the edit, show the diff, write on a yes.

1. `.sous/steps/verify/eval.ts`: `BASE_BRANCH` (the branch the checkout
   is on, `git rev-parse --abbrev-ref HEAD` is the usual answer) and
   `CHECKS`. Find candidates in the repository first and propose them:
   `package.json` scripts (`test`, `typecheck`, `lint`, `build`),
   `gradlew` (`./gradlew build`), `Cargo.toml` (`cargo test`),
   `Makefile` targets, `pyproject.toml` (`pytest`). One `{ command }` per
   check, `dir` for a subfolder, `when` for a folder the diff must touch.
   Remove the TODO lines once filled. An empty list means every verify
   passes with a WARN in the log; say so if the human wants to defer it.
2. `.sous/sous.yaml`: `tracker` (`github`, `beads`, `local`, or a module
   path), `baseBranch` (same as above), the `branch` template,
   `lifecycle` (`core`: runs claim, block and close the issue; `steps`:
   the project's steps do). Keep the other defaults unless asked.
3. `.sous/flows/*.yaml`: every `agent:` model (ask which Claude or Codex
   model to use; one answer for all is fine) and `allowedLabels`. For the
   GitHub tracker, offer to create the labels now:
   `gh label create type:task`, `gh label create type:bug`,
   `gh label create type:feature` (each with `--force`).
4. `.sous/prompts/plan.md`: go through every `<!-- ADAPT: ... -->` note
   top to bottom, ask what the note asks, edit the text, and delete the
   note once applied. Leave a note in place only when the human defers it.

## 4. Verify

```
cd .sous && ./sous validate && npx vitest run
```

Both must pass; fix what they report. Then offer a smoke test on an
issue the human names: `./sous run bench <issue>` (the `bench` flow has
`lifecycle: steps`, so it changes nothing on the issue).

## 5. An existing development loop

Look for a skill or command that already runs the development loop in
this repository: in `.claude/skills/*/SKILL.md`, `.claude/commands/`,
`.agents/`, `AGENTS.md` and `CLAUDE.md`, one whose description or steps
take an issue or task through implement, test, review and merge or ship
("next task", "pick up work", "implement the ticket"). Skip the
starter's own skills and `/sous-plan`. Read only the front matter and
the headings; this is a pointer, not a port.

If none is found, say so in one line. If one or more are found, name
each with its path and one line on what it does, and ask the human:

- **Port it now** with `/sous-migrate <skill>`. If `.claude/skills/sous-migrate/`
  is missing, install it first, the same way as this skill:
  `cp -r <clone of github.com/sousfactory/sous>/skills/sous-migrate .claude/skills/`.
  Then hand over; `/sous-migrate` asks its own questions.
- **Later**: print the two commands (install, then `/sous-migrate <skill>`)
  so the human has them.
- **No**: leave it.

Finish with a two-line summary of what was set and what was deferred,
including the answer here.

Argument received: $ARGUMENTS
