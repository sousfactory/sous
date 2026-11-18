---
name: sous-setup
description: Set up the sous software factory, step by step. Interactive: asks first whether sous serves one repository or several, then which tracker holds the work (GitHub or bd), checks prerequisites, installs and inits sous-factory if .sous/ is missing (for several, the engine in a home repository with repos: and a definitions-only .sous/ in each listed repository via sous init --no-install), adapts steps/verify/eval.ts, sous.yaml, the flows and prompts/plan.md with the human, verifies, and offers /sous-migrate for a development-loop skill the repository already has. Use as /sous-setup ("set up sous", "sous setup"); skips what is already done.
disable-model-invocation: true
---

Ask the question in step 0 first, then walk the human through the
procedure its answer picks, in order. Before each step, check its state
and skip what is done; say in one line what you skip. Ask for the facts
you need, show every edit as a diff before writing it, and write only
after a yes. Never push. Never run `sous run` or `./sous run` and never
set `sous:ready`: print the run command for the human instead. Stop at a
missing prerequisite and say what to install.

## 0. One repository or several

Ask this before anything is written: does sous serve **one repository**
(this checkout runs its own engine) or **several** (one home repository
holds the engine and runs the others, listed under `repos:` in its
`sous.yaml`, each with a definitions-only `.sous/`)? Recommend **one**
for a single checkout, which is most projects; it can grow into several
later with `/sous-migrate`. When `.sous/sous.yaml` already has `repos:`,
say in one line that this is a home repository and recommend **several**.

- **One**: follow "One repository", steps 1 to 5, below.
- **Several**: follow "Several repositories" after it.

# One repository

## 1. Tracker and prerequisites

First ask where the work is tracked, unless `.sous/sous.yaml` already
says so: `github` (the starter's default; issues, labels and sub-issues
on the repository), `beads` (`bd`, local-first, in `.beads/`), `local`
(issue files under `.sous/`) or a module of the project's own. The answer
decides the checks below and the edits in step 3.

- `node --version` is 22 or newer.
- `github`: `gh auth status` succeeds.
- `beads`: `bd` is on the `PATH` and `bd info` succeeds from the repository
  root (`bd init` otherwise).
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

1. `.sous/steps/verify/eval.ts`: `CHECKS`. Find candidates in the repository first and propose them:
   `package.json` scripts (`test`, `typecheck`, `lint`, `build`),
   `gradlew` (`./gradlew build`), `Cargo.toml` (`cargo test`),
   `Makefile` targets, `pyproject.toml` (`pytest`). One `{ command }` per
   check, `dir` for a subfolder, `when` for a folder the diff must touch.
   Remove the TODO lines once filled. An empty list means every verify
   passes with a WARN in the log; say so if the human wants to defer it.
2. `.sous/sous.yaml`: `tracker` (the answer from step 1), `baseBranch`
   (the branch the checkout is on, `git rev-parse --abbrev-ref HEAD` is
   the usual answer; the flows and the verify eval read it as
   `ctx.baseBranch`), the `branch` template, `lifecycle` (`core`: runs
   claim, block and close the issue; `steps`: the project's steps do).
   Keep the other defaults unless asked. The plan prompt speaks to the
   tracker through `.sous/trackers/<tracker>.md`; the starter ships
   `github.md`, `beads.md` and `local.md`.
   - `github`, `beads`, `local`: nothing to do; delete the two sheets the
     project does not use if the human wants a lean folder.
   - a module (`trackers/<name>.ts`): copy the closest shipped sheet to
     `.sous/trackers/<name>.md` and replace its commands with the module's;
     every verb under `## Verbs` must stay defined.
3. `.sous/flows/*.yaml`: every `agent:` model (ask which Claude or Codex
   model to use; one answer for all is fine) and `allowedLabels`. The
   labels are what the tracker reports for an issue:
   - `github`: offer to create them now: `gh label create type:task`,
     `gh label create type:bug`, `gh label create type:feature` (each
     with `--force`).
   - `beads`: nothing to create; the tracker derives `type:feature`
     (epic or feature), `type:bug` and `type:task` from the bead type.
   - `local` or a module: the issue files or the module list them.
4. `.sous/prompts/plan.md`: go through every `<!-- ADAPT: ... -->` note
   top to bottom, ask what the note asks, edit the text, and delete the
   note once applied. Leave a note in place only when the human defers it.

## 4. Verify

```
cd .sous && ./sous validate && npx vitest run
```

Both must pass; fix what they report. Then print the smoke test for the
human to run on an issue of their choice (a number for GitHub, a bead id
for bd): `./sous run <issue> --flow bench` (the `bench` flow has
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

# Several repositories

The home repository holds the engine and the `repos:` list; `sous watch`
and `sous run` typed there run every listed repository with that engine.
A listed repository's `.sous/` is definitions only: flows, steps,
prompts, trackers and `sous.yaml` with its `engine:` range, no `sous`
wrapper and no install. Manual chapter 1 ("One repository or several")
and how-to 21 describe the shape.

## S1. The home repository and the list

Ask which checkout is the home repository (this one unless the human
names another; a planning repository is the usual pick) and which
repositories it serves, each as `name: path`, the path relative to the
home repository (`api: ../api`). The name is what the `repo:<name>`
labels say. List the home repository itself (`planning: .`) only when its
own issues run there too. Check every path is a git checkout; stop at one
that is not and ask again.

Then the prerequisites of step 1 above, once: Node 22 or newer, the agent
CLI, and per tracker in use `gh auth status` or `bd info`.

## S2. Install the engine in the home repository, or extend it

- **No `.sous/sous.yaml` in the home repository:** from its root, as in
  step 2 above, `npm install -D sous-factory` and `npx sous init`. Read
  the checklist; the home repository's own `sous.yaml` gets the tracker
  its issues live in (step 3, item 2), since `sous run <issue>` typed
  there reads the issue's labels from it.
- **It exists:** say so in one line and extend it; nothing is installed
  again.

Add or extend `repos:` in the home repository's `.sous/sous.yaml` with the
entries from S1, diff first. Keep existing entries; a name already listed
with another path is the human's call.

## S3. A definitions-only `.sous/` in each listed repository

For each listed repository without `.sous/sous.yaml`, from the home
repository's root (the path resolves against the current directory):

```
.sous/node_modules/.bin/sous init --no-install <path>
```

It copies the starter, writes `engine:` for the home repository's engine,
places `/sous-plan` in that repository's `.claude/skills/`, and writes no
wrapper and runs no `npm install`. Its checklist ends with the `repos:`
entry; check it matches what S2 wrote. A repository that already has a
`.sous/` with its own `sous` wrapper or `node_modules` is left as it is;
offer `/sous-migrate` to move it to definitions-only.

Then offer, per repository, the **dev install for authoring**: `npm
install` in its `.sous/` gives the editor the types and lets the
project's tests run (`npx vitest run`); runs do not need it, the home
repository's engine runs them. Ask yes or no for each; the default is no.

## S4. Adapt each listed repository

For each listed repository, step 3 above, one file at a time in its
`.sous/`: `steps/verify/eval.ts`, `sous.yaml` (an `engine:` line is
already there; keep it), the flows and `prompts/plan.md`. The tracker and
labels questions are asked per repository: each can have its own.

## S5. Verify

In the home repository, `cd .sous && ./sous validate`: it checks every
listed repository's path and `engine:` range. For each listed repository,
from the home repository's root:

```
SOUS_ROOT=<path>/.sous .sous/node_modules/.bin/sous validate
```

and `npx vitest run` in its `.sous/` where the dev install was taken.
Fix what they report. Print the smoke test for the human to run, in the
home repository: `./sous run <issue> --repo <name> --flow bench`.

## S6. The daemon and the labels

Finish by naming, without running them:

- the daemon: `cd .sous && ./sous watch` in the home repository (`--once`
  for one pass);
- the labels to create, one per entry, on the tracker that holds the
  issues: `repo:<name>` for every name in `repos:` (on GitHub `gh label
  create repo:<name> --force`; beads needs none). An issue runs in the
  entry its label names; one without a `repo:*` label is skipped.

Then step 5 above for an existing development loop, in each listed
repository the human picks, and a two-line summary: the home repository,
the entries and their dev installs, and what was deferred.

Argument received: $ARGUMENTS
