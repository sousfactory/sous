---
name: sous-migrate
description: Port an existing agentic development-loop skill (one big SKILL.md, or a skill that chains sub-skills and scripts) into a sous flow of steps in .sous/, and, when a home repository is found beside the checkout or named, move this repository's .sous/ from its own engine to definitions-only run by the home repository. Interactive: reads the skill, maps every part of it to a step, eval, prepare, route or "not ported", shows that mapping for approval, then writes the flow and any new steps and validates. Use as /sous-migrate <skill> ("migrate my skill to sous", "port this workflow to a flow") or /sous-migrate definitions-only ("move this repository to the home engine").
disable-model-invocation: true
---

Port the skill the human names into a sous flow. The original stays
untouched: the flow lives beside it, and the human compares and decides.
Ask for what you cannot read, show every file as a diff before writing it,
and write only after a yes. Never push. Never run `sous run` or `./sous
run` and never set `sous:ready`: print the run command for the human
instead.

Read the sous manual first
(<https://github.com/sousfactory/sous/blob/main/docs/manual.md>): steps (§5),
flows (§6), variables (§7), execution (§8), lifecycle (§11), and how-tos 15,
16 and 19. Read the starter's own steps in `.sous/steps/` as worked examples.
The manual and the starter are enough: do not read the engine's source in
`node_modules/`. Use only what the manual describes; do not invent step
fields or expression variables.

## 0. Preconditions

- `.sous/sous.yaml` exists. If not, stop and point to `/sous-setup`.
- **First step: `engine:` in `.sous/sous.yaml`.** The engine refuses a
  project without it (manual §9). When the key is missing, add
  `engine: ^<version>` among the settings at the top, before any port or
  §D: the version of the engine installed in `.sous/node_modules/sous-factory/package.json`,
  or, for a move to definitions-only (§D), the home repository's engine's.
  Show the line as a diff and write it after a yes. A present key is
  left as it is here.
- A home repository: one beside the checkout (a sibling folder whose
  `.sous/sous.yaml` has `repos:`) or one the human names. When there is
  one and this repository's `.sous/` carries its own engine (a `.sous/sous`
  wrapper or `.sous/node_modules`), offer the move to definitions-only in
  §D below before or instead of a port. Without a
  home repository, found or named, do not offer it.
- The skill to port: `$ARGUMENTS`, else ask. Accept a name
  (`.claude/skills/<name>/SKILL.md`), a path, or a command file.
  `$ARGUMENTS` of `definitions-only` asks for §D alone.

## 1. Read everything the skill reaches

Read the skill, then follow every reference it makes, transitively: other
skills it invokes, scripts it runs, docs it says to read, files it passes
state through, subagents it starts and the models it names. List them
with one line each. A reference you cannot resolve goes on the list as
unresolved; do not guess what it does.

Do not read existing `.sous/flows/` or `.sous/steps/` beyond the starter's
to decide the mapping; the port is judged against the skill alone.

## 2. Find the phases and the control flow

Write the skill down as a sequence of phases, in its own words. Then
find the control flow, which a skill usually states in prose:

- **Order and branches:** "then", "if X, go to", "skip when", "only for".
- **Loops and their bounds:** "until it passes", "fix and review again",
  "at most two attempts". A loop without a bound gets one; propose a
  number and mark it as your proposal.
- **Exits:** what ends the run successfully, what stops it for a human.
- **Values passed between phases:** ids, paths, a plan file, a report,
  a subagent's session, front matter. Note who writes and who reads each.
- **Judgement the agent makes about the flow itself** ("decide whether
  this needs a review", "if it looks risky, stop"). Each one must become
  an output field of a step and a route condition on it, or stay inside a
  step's prompt. Name each and say which.

## 3. Map every part

Sort each phase, and each rule inside it, into exactly one row:

| In the skill | In sous |
| --- | --- |
| work that needs judgement (plan, implement, review, write docs) | a prompt step; the agent and model on its flow entry |
| work that is mechanical (run commands, git, tracker calls, a script with exit codes) | a module step, or the `prepare` of the prompt step it serves |
| a self-check the agent is told to do ("make sure tests pass") | the step's `eval`, so it is checked, not trusted |
| "check first, skip if nothing to do" | a `prepare` returning `agent: "never"`, or `"on-fail"` when the eval should decide |
| order, branches, loops, bounds, exits | `routes`, `maxIterations`, a `steps.<id>.visits` cap, `done`, `blocked` |
| a value passed between phases | an output field, a `with:` expression, `resume:` for a session |
| stop on failure, resume after an interruption, a final summary of the run | the engine already does this (§6.2, §11, `sous status`); not ported, say so |
| anything else | "not ported", with the reason |

Then decide the granularity. The port has two passes; this skill writes
only the first.

**Pass 1, faithful.** At most one flow entry per top-level phase of the
skill, plus module entries for mechanical work the skill already does
outside an agent (its own scripts between phases).

- **A sub-skill is one step.** A phase that is a skill of its own stays
  that skill, whole: the step's prompt points the agent at it by path and
  adds only what a step-at-a-time run needs (the inputs, the output to
  report, what not to do because the runner does it). Do not split it,
  rewrite it or summarize it into the prompt. If several phases are run
  this way, one generic step with the skill path as an input serves them
  all.
- **A loop inside a sub-skill stays inside it.** Its own bound stays its
  bound; give the entry `maxIterations: 1` so a stop inside the skill goes
  `blocked` instead of re-running it. Only loops *between* phases become
  routes.
- **The workspace is sous's.** A run already has its worktree and branch
  (`ctx.worktree`, `ctx.branch`, §8.3), created before the first step and
  kept on `blocked`. A phase that creates its own worktree, clone or
  branch is mapped onto them, never run beside them: its setup (installs,
  copied files, ports, a claim) becomes a module or `prepare` that works
  in `ctx.worktree`, and its teardown is left to sous or done there. Say
  under decisions which parts of the skill's own workspace handling were
  replaced, and check what its scripts assume about where the worktree
  lives or which clone is "main".
- **The run target is the issue.** `sous run <issue>` names the
  issue; a phase that picks the next issue (a queue, a picker, "what's
  next") is not ported, and the skill's argument handling maps onto
  `ctx.issue`.
- **Reuse before writing.** Map to the starter's steps where they do the
  same job; read their `README.md` to check.
- **A repeated entry is a warning.** If the same sequence of entries would
  appear twice under different ids, the loop belongs inside one step:
  keep it there and say why.

**Pass 2, lean, proposed only.** List, per entry, what could move out of
the agent later: a script call into a module or a `prepare`, a quick path
into a `prepare` that skips, a self-check into an `eval`, an inner loop
into routes. Name the gain (cost, time, a check that is no longer trusted
to the agent). Do not write any of it; the human picks per entry, later.

**The lifecycle is the steps'.** Every migrated flow sets
`lifecycle: steps` (§11, how-to 19), so the engine never claims, blocks or
closes the issue: the ported phases keep doing that as the skill did.
Where the skill relied on something else to claim or close (a human, a
CI job), say so under decisions; do not add a claim or a close it did not
have.

## 4. Show the mapping, then wait

Present, before writing any file:

1. The flow as a table: entry id, step (`starter`, `new`), agent and model,
   routes, and the part of the skill it covers.
2. The mapping: every section of the skill, top to bottom, against the
   entry, eval, prepare or route it became, or **not ported** with the reason.
3. **Pass 2 candidates**: the list from §3, not applied.
4. **Decisions to confirm**: every bound you proposed, every judgement you
   turned into a route, every model that differs from what the skill
   names, where the issue is claimed and closed, every unresolved
   reference.
5. **Risks**: behaviour the port changes or loses.

Change the mapping until the human agrees. Write nothing before that.

## 5. Write

One file at a time, diff first:

- New steps under `.sous/steps/<name>/`: `step.yaml`, the prompt or module,
  `prepare.ts` and `eval.ts` where mapped, and a `README.md` in the
  starter's format.
- The flow, `.sous/flows/<name>.yaml`, named after the skill unless the
  human picks a name. Start it with a comment that holds the mapping table
  (skill phase → entry), so the flow explains its own origin.
- Tests the starter's pattern supports for new modules and the flow
  (`test/`, the `sous-factory/testing` fakes).

## 6. Verify

```
cd .sous && ./sous validate && ./sous graph <flow> && npx vitest run
```

Fix what fails. Show the graph. Print the run command for the human to
try on an issue of their choice (`./sous run <issue> --flow <flow>`, or
from the home repository after §D). Finish with three lines: what was
ported, what was not, and the decisions still open.

## D. Move to definitions-only

The repository's `.sous/` keeps its definitions (flows, steps, prompts,
trackers, `sous.yaml`) and loses its engine: the home repository's engine
runs it, from `sous watch` and `sous run` there (manual how-to 21,
"Definitions here, engine there"). Show what each step changes, diff or
file list first, and change it only after a yes.

1. **Read both sides.** The home repository's path and its engine
   version, the `version` in
   `<home>/.sous/node_modules/sous-factory/package.json`; this
   repository's own version in `.sous/node_modules/sous-factory/package.json`
   when installed, and its `engine:` in `.sous/sous.yaml`. Name a
   different minor version as a risk: the definitions may use what the
   other engine changed, which §D.6 checks.
2. **Remove the engine.** `git rm .sous/sous` (the wrapper) and remove
   `.sous/node_modules` (gitignored, so nothing to commit). Keep
   `.sous/package.json` and its lock file: they serve the editor and the
   project's tests. Keep `node_modules/` in `.sous/.gitignore` for a later
   dev install.
3. **Widen `engine:`.** The key is there since §0. With a range the home
   engine does not satisfy, propose widening it to `^<home version>` once
   §D.6 passes; leave a satisfied range as it is.
4. **Register the repository.** Add `<name>: <path from the home
   repository>` to `repos:` in the home repository's `.sous/sous.yaml`.
   The name is the one this repository's `repo:<name>` labels carry: its
   `name:` in `sous.yaml`, else its `origin` repository, else its folder.
   An entry already there with this path is kept; another path under the
   name is the human's call.
5. **Find the wrapper's users.** Search the repository for `.sous/sous`
   and `./sous` outside `.sous/` (CI workflows, scripts, `Makefile`,
   `README.md`, `AGENTS.md`, `CLAUDE.md`) and list each with the line.
   Propose an edit per hit, diff first; leave one the human declines.
6. **Verify.** From the home repository's root, `SOUS_ROOT=<path>/.sous
   .sous/node_modules/.bin/sous validate`, then `cd .sous && ./sous
   validate` there, which checks every listed repository's `engine:`.
   Fix what they report. Name the commit for the human to make in each
   repository; do not push.

Finish with the message for the repository's users, filled in, for the
human to pass on:

> `.sous/sous` is gone: this repository's runs start in `<home>`.
> Label an issue `sous:ready` for its `sous watch` (and `repo:<name>`
> when its tracker is shared, `tracker.shared: true`), or type
> `./sous run <issue>` there (`./sous run <name>#<issue>` when several
> entries' trackers hold that number). Runs, logs and worktrees stay in
> this repository's `.sous/`;
> read them with `SOUS_ROOT=<path>/.sous .sous/node_modules/.bin/sous
> status` from `<home>`'s root. To edit or test steps here, `cd .sous && npm install`, then
> `npx vitest run`; `npx sous <command>` in `.sous/` then replaces
> `./sous <command>` with this repository's own install.

Argument received: $ARGUMENTS
