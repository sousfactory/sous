---
name: sous-run
description: Control and watch the sous software factory (.sous) from the session. Use when the human asks about the factory or a run in plain words, such as "what is running", "status", "how is 42 doing", "run 42", "let the daemon take 42", "42 is blocked, what now", "what happened on 42". Reads sous status --json, answers in one fixed layout, starts a named issue, hands an issue to the daemon on an explicit ask, explains a blocked run and condenses a report. Also usable as /sous-run <words>.
---

The bridge between this session and the sous CLI. The CLI owns the facts;
this skill owns the words. Pick the intent from what the human said, run
the command it names, and answer in its layout, the same every time.

## Before anything

- **The engine.** From the repository root: when `.sous/sous` exists, the
  engine is `cd .sous && ./sous`; otherwise it is `sous`. Every command
  below that starts with `sous` means that engine.
- **The facts.** Read them only from `sous status --json` (the factory
  overview) and `sous status <issue> --json` (one issue's facts, runs and
  spans). Never parse the plain-text form of `sous status`; it is for
  humans and may change.
- **The tracker sheet.** For an entry, read `tracker.type` and
  `tracker.labels` from the `tracker:` block of the entry's
  `.sous/sous.yaml` (in a home repository, the listed repository's own
  `.sous/sous.yaml`, at the entry's `path`). The sheet is
  `.sous/trackers/<type>.md` beside it; this skill uses two of its verbs,
  **read the issue** and **set ready**, and runs them as the sheet says.
  `<labels>` is `tracker.labels`.
- **Issue ids** are what the tracker uses: `42`, `#42` (a leading `#` is
  dropped), a bead id like `bd-a3f8`. In a home repository `<name>#<issue>`
  names an entry and an issue.

## Status

On "what is running", "status", "how is 42 doing" and the like, run
`sous status --json`; when the human named an issue, also
`sous status <issue> --json`. Answer in this layout, nothing before it.
The block below is the markdown source of the answer: write it as plain
markdown, never inside a code fence, so the table renders as a table. The
blank lines between the first three lines keep markdown from joining them
into one paragraph.

````markdown
single repository <name> · engine <engine>

daemon: <running (pid <pid>, since <time>) | none | stale lock, no daemon>

ui: <url | not running (sous ui)>

| issue | title | state | step | since |
| --- | --- | --- | --- | --- |
| <issue> | <title or -> | <state> | <step or -> | <since as a duration, or -> |

<n> done, see sous ui

<notes>
````

- **Mode line.** `mode: "single"` gives `single repository <name>` (the one
  entry's name); `mode: "home"` gives `home repository, <n> entries:
  <name>, <name>, …`. Then `· engine <engine>`.
- **Daemon line.** From `daemon`: `running` with `pid` and `since`;
  `stale: true` reads `stale lock, no daemon`; else `none`.
- **UI line.** From `ui`: the bare `url` on its own line when `up` (a
  terminal makes it clickable), else `not running (sous ui)`.
- **The table.** One row per run of every entry, then the entry's
  `ready[]` as rows with state `ready`, step `-` and since `-`. In a home,
  an `entry` column comes first. A title that starts with the entry's
  name and a colon (`<name>: …`) drops that prefix, so the row stays
  short. Sort the rows by state (running,
  blocked, crashed, interrupted, ready), then by the entries' order in
  the JSON, then by issue number; do this yourself, whatever order the
  JSON lists them in. `since` is an ISO time; print how
  long ago (`12m`, `3h`, `2d`). An empty table is the line `no issue needs
  attention`.
- **The done line.** The sum of `done` over the entries, only when it is
  more than zero.
- **Notes.** After the table and the done line, one line each, in this
  order: every entry's `note` (its tracker was not built, did not answer,
  or did not give some titles); every entry with `unrunnable` set, with its
  reason; for a named issue, its current step with visit and iteration,
  the last eval (`step`, ok or failed, `log`), the open work items of
  `workProgress`, and the `worktree` from its overview row (in `runs[]`,
  or in `ready[]` for an issue handed back after a block). Nothing else:
  no advice unless the human asked a question.

## Start

On "run 42", "start 42": only when the human named the issue in this
turn. Name the issue back first ("Starting #42."), then run it in the same
turn.

- Single repository: `sous run <issue>`.
- Home repository: read `sous status --json` first. When the number shows
  under more than one entry, run `sous run <name>#<issue>` with the entry
  the human named, and ask which entry when they named none. When the
  number shows under none, ask which entry before running anything. When
  it shows under exactly one, `sous run <name>#<issue>`.
- `--flow <flow>` only when the human names a flow.
- `--restart` only when the human says the branch is wrong, and only
  after saying what will be removed: the run record under `runs/<issue>/`,
  the worktree and the branch, with every commit on it not merged. The
  engine asks `[y/N]` on stdin before it removes anything, and a tool call
  cannot answer it interactively: run `--restart` only after the human
  confirmed in the conversation, in a foreground call that answers their
  yes on stdin (`printf 'y\n' | sous run <issue> --restart`). Read exit 1
  with `restart cancelled` as a cancelled restart, not as blocked: nothing
  was removed and nothing ran.
- A run takes long. Start it in the background when the session can, and
  answer with the issue and how to watch it (`sous status <issue>` or the
  ui line). Report its exit when it ends: 0 done, 1 blocked or crashed or
  lock held, 2 refused (say the engine's message).

## Hand-off

On an explicit ask such as "let the daemon take 42" or "mark 42 ready":
name the issue back, then set `<labels>:ready` on it through the tracker
sheet's **set ready** verb. Then read `daemon` from `sous status --json`
and say either that `sous watch` picks the issue up on its next pass, or
that no daemon is running, so nothing will pick it up until someone starts
`sous watch` or runs `sous run <issue>`. Never set ready on your own
initiative, and never set any other label.

## Blocked

On "42 is blocked, what now": read the issue's blocked comment through
the tracker sheet's **read the issue** verb (the latest comment naming
the step and its log), and `sous status <issue> --json` (`current`,
`lastEval` with its `log`, the worktree from the overview row). Read the
eval log the comment or `lastEval.log` names when the comment alone does
not say what failed.

Say what the run needs in two sentences: what stopped it, and what would
make the step pass. Then offer the two paths, and do neither unasked:

1. fix it in the worktree and run `sous run <issue>` again: the run
   re-enters the blocked step at its eval, so a fix moves it on without an
   agent call;
2. amend with `/sous-plan <issue>` and run `sous run <issue>` again, when
   the spec or the issue is what is wrong.

## Report

On "what happened on 42", "report on 42": run `sous status <issue> --json`
and condense `runs` and `spans` into these parts, in this order, each a
short list or table:

1. **Runs**: each segment's start, duration, flow and `outcome`
   (`running` when it has no end yet), `resumedFrom` when set, `error`
   when it crashed.
2. **Steps**: per step, the visits (spans), the iterations (the number
   of `iterations` entries of its spans; the re-entry eval after a block
   (`n: 0`) counts as one), and whether its last visit was ok.
3. **Time**: total agent time (the `agent` intervals of the iterations)
   and total eval time (the `eval` intervals), beside the wall time.
4. **Cost**: the sum of the runs' `costUsd` when any is known, marked a
   lower bound when `costUnknown` is above zero; `unknown` otherwise.
5. **Where the time went**: the three steps with the most wall time, with
   their share, and one sentence on the biggest one (a retry loop, a long
   agent call, a slow eval).

## Guard rails

- Never run `sous run` unless the human named the issue in the same turn.
- Never push.
- Never edit a file under a worktree.
- Never close an issue.
- Never set a label other than `<labels>:ready`.
- Never run `sous watch`.

Starting or stopping the daemon, watching a run in a loop and changing
the run viewer are not this skill's; say the command and leave it to the
human.

Argument received: $ARGUMENTS
