---
name: sous-migrate
description: Port an existing agentic development-loop skill (one big SKILL.md, or a skill that chains sub-skills and scripts) into a sous flow of steps in .sous/. Interactive: reads the skill, maps every part of it to a step, eval, prepare, route or "not ported", shows that mapping for approval, then writes the flow and any new steps and validates. Use as /sous-migrate <skill> ("migrate my skill to sous", "port this workflow to a flow").
disable-model-invocation: true
---

Port the skill the human names into a sous flow. The original stays
untouched: the flow lives beside it, and the human compares and decides.
Ask for what you cannot read, show every file as a diff before writing it,
and write only after a yes. Never push. Never `sous run` a real issue unless
the human names one and agrees.

Read the sous manual first
(<https://github.com/sousfactory/sous/blob/main/docs/manual.md>): steps (§5),
flows (§6), variables (§7), execution (§8), lifecycle (§11), and how-tos 15,
16 and 19. Read the starter's own steps in `.sous/steps/` as worked examples.
The manual and the starter are enough: do not read the engine's source in
`node_modules/`. Use only what the manual describes; do not invent step
fields or expression variables.

## 0. Preconditions

- `.sous/sous.yaml` exists. If not, stop and point to `/sous-setup`.
- The skill to port: `$ARGUMENTS`, else ask. Accept a name
  (`.claude/skills/<name>/SKILL.md`), a path, or a command file.

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
| "check first, skip if nothing to do" | a `prepare` returning `agent: "skip"` |
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
- **The run target is the issue.** `sous run <flow> <issue>` names the
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

Fix what fails. Show the graph. Offer one run on an issue the human names,
and only then. Finish with three lines: what was ported, what was not, and
the decisions still open.

Argument received: $ARGUMENTS
