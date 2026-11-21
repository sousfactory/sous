# Spec: sous-run skill: the bridge between a session and the CLI for control, monitoring and reporting

- **Issue:** #12
- **Status:** draft

## Problem Statement

Once a project has runs, the daily loop happens in a Claude Code session: "what is running?", "run 42", "42 is blocked, what now?", "what happened on 42?". Today the session has to know the CLI, read `runs/<issue>/` by hand, and scrape `sous status <issue>`, which exists only per issue. There is no factory-wide status: nothing says whether the session sits in a single repository or a home with several entries, whether a daemon or the run viewer is running, which issues wait with `sous:ready`, and which runs are blocked. The two skills sous ships are one-off (`/sous-setup`, `/sous-plan`); nothing covers the loop.

## Solution

The CLI owns the facts and the skill owns the words. `sous status` without an issue prints a factory overview, and both forms take `--json`. A `sous-run` skill, installed by `sous init` next to `/sous-plan`, is invoked by the model when the human talks about runs: it chooses the command, reads the JSON and answers in one fixed layout, the same every time. Four intents: status, start, continue after blocked, report; plus handing an issue to the daemon on an explicit ask. It never pushes, never edits a worktree, never closes an issue.

## User Stories

1. `sous status` with no argument prints the overview; `sous status <issue>` prints the per-issue facts and timeline as today; `sous status --json` and `sous status <issue> --json` print the same facts as one JSON document; any other argument is a usage error naming `sous status [<issue>] [--json]`.
2. The overview opens with where the session is: `single repository <name>` (no `repos:`), or `home repository, <n> entries` with each entry's name, and the engine version.
3. Per entry (the one repository, or each listed entry) the overview shows the tracker as `type`, location (`owner/name`, the absolute dir, or the checkout for beads) and `shared`; a listed entry the engine sets aside (no `sous.yaml`, engine range) is shown with the daemon's reason.
4. The overview says whether a daemon runs: `daemon: running (pid <pid>, since <time>)` when `locks/watch.pid` holds a live process, `daemon: none` otherwise, a stale file named as stale.
5. The overview says whether the run viewer is up: `ui: http://127.0.0.1:<port>` when something answers on the project's `uiPort` within half a second, `ui: not running (sous ui)` otherwise. The URL is printed as a plain line so a terminal makes it clickable.
6. The overview's table has one row per issue that needs attention, in this order: running (a live `<issue>.lock`), blocked, crashed, interrupted, ready (carrying `<labels>:ready` on the tracker with no run of its own yet). Columns: entry (homes only), issue, title, state, step (the session's current step, `-` for ready), since (the state's time, as a duration). Done runs are not rows; a count line says `<n> done, see sous ui`.
7. Titles and ready rows come from the tracker. When a tracker does not answer, its rows show `-` as the title, ready rows are missing, and one line under the table says `tracker <location> did not answer; ready issues not shown`. The overview never fails on a tracker error.
8. The overview reads only this repository without `repos:`, and in a home every entry the daemon would serve, through the same lookup `sous watch` uses; the home's own runs appear only when the list names the home.
9. `--json` carries the same facts with stable keys: `mode` (`single` or `home`), `engine`, `entries[]` with `name`, `path`, `tracker { type, location, shared }`, `unrunnable` (reason or null), `runs[]` with `issue`, `title`, `state`, `step`, `since` (ISO), `branch`, `worktree`, and `ready[]` with `issue`, `title`; `daemon { running, pid, since }`; `ui { port, url, up }`; `done` (count per entry). The per-issue JSON carries the facts table's keys and the timeline's runs and spans with their timestamps and outcomes.
10. `sous status` and `--json` work offline except for the tracker parts, and never write anything.
11. A `sous-run` skill ships in the starter under `skills/sous-run/` and `sous init` installs it into `.claude/skills/sous-run` as it installs `sous-plan`; its init line names both skills. It is model-invocable (no `disable-model-invocation`) and also usable as `/sous-run <words>`.
12. Asked about the factory or a run in plain words ("what is running", "status", "how is 42 doing"), the skill runs `sous status --json` or `sous status <issue> --json` with the project's engine (`./sous` in `.sous/` when the wrapper exists, else `sous`) and answers in one fixed layout: the mode line, daemon and UI lines, the table, then the notes. It never parses the plain-text form.
13. Asked to start ("run 42"), the skill names the issue back and runs `sous run <issue>` in the same turn only when the human named the issue in that turn; in a home it runs `sous run <name>#<issue>` when the overview shows the number under more than one entry, and asks which entry otherwise if the number is unknown. `--flow` only when the human names a flow; `--restart` only when the human says the branch is wrong, after saying what will be removed.
14. Asked to hand an issue to the daemon ("let the daemon take 42", "mark 42 ready"), the skill sets `<labels>:ready` through the tracker sheet's **set ready** verb, after naming the issue back; never on its own, never another label, and it says that `sous watch` picks it up on its next pass or that no daemon is running.
15. Asked what to do with a blocked run, the skill reads the blocked comment through the tracker sheet's **read the issue** verb and `sous status <issue> --json`, says what the run needs in two sentences, and offers the two documented paths: fix in the worktree and run `sous run <issue>` again, or amend the spec or issue with `/sous-plan <issue>` and run again.
16. Asked for a report ("what happened on 42"), the skill condenses the per-issue JSON: runs with outcomes, steps with visits and iterations, agent and eval time, cost when known, where the time went, in a fixed order.
17. The skill never runs `sous run` without the issue named by the human in the same turn, never pushes, never edits files under the worktree, never closes an issue, never sets a label other than ready, never runs `sous watch`.
18. The manual's skills section (8.4) documents `sous-run` in one paragraph with the four intents and the guard rails; the CLI reference reads `sous status [<issue>] [--json]` with the overview described in two sentences; the automated-loop chapter says `sous status` shows the daemon and the ready queue; the starter README gains a line; the changelog's Unreleased Added lines name the overview, `--json` and the skill.

## Implementation Decisions

- The overview is built in `status.ts` from three readers already present: the sessions under `runs/` (`store`, `timeline`), the locks (`liveLocks`, `classifyLock`, the watch lock), and the lookup (`lookupOf`) for entries and trackers; the UI probe is an HTTP GET to `/` on `127.0.0.1:<uiPort>` with a 500 ms timeout, injected so tests use no network.
- Rendering and JSON share one model: `overviewOf(...)` returns the JSON shape, `renderOverview` prints it; the per-issue form gets `statusOf(...)` the same way, and `renderStatus` prints from it, so `--json` is one `JSON.stringify` away in both forms.
- Tracker reads are per entry, each caught: `list({ labels: [ready] })` for the ready rows and `getIssue` for titles of session rows; a failure sets the entry's note and leaves the rows.
- "Since" is the timestamp of the state: a running row's current span start, a blocked or crashed row's last `run.end`, a ready row's nothing (`-`).
- The skill is prose in `SKILL.md` and a short layout template; it calls the tracker sheet for the two verbs it uses (**read the issue**, **set ready**) so it stays tracker-neutral; `init.ts` generalises the single skill copy into a list (`sous-plan`, `sous-run`).
- `sous-setup` names the skill in its closing lines; `sous-migrate` is unchanged.

## Testing Decisions

- `status.test.ts` with temp projects: the overview over fixture sessions and lock files (running, blocked, crashed, interrupted, done count), the watch lock live and stale through an injected `isAlive`, the UI probe through an injected `probe`, the ready rows and titles through the `FakeTracker`, a tracker that throws, a home fixture with two entries and one set aside; the JSON form compared as objects; the usage error; the per-issue JSON keys against the rendered facts.
- `init.test.ts`: both skills installed and named in the init output.
- `starters/default/test`: a `skills.test.ts` asserting the skill's frontmatter (no `disable-model-invocation`), the four intents and the guard-rail sentences, as `prompts.test.ts` does for the plan prompt.
- The skill itself is checked by reading and by one manual pass in this repository after the children merge.

## Out of Scope

- Polling or watching from the skill; a wakeup belongs to the session, not the skill.
- Changes to the run viewer; `sous status` is the chat view, `sous ui` the live view.
- A `--watch` or `--interval` on `sous status`.
- Starting or stopping the daemon from the skill.

## Assumptions

- None.

## Open questions

- None.

## Decisions

- #41: `done` is a count on each entry of the JSON, beside `ready[]`, not a key of each ready item: story 9 names it a count per entry, and a ready issue has no run that could be done.
- #41: each JSON entry also carries `note` (the tracker-did-not-answer line, or null) and `daemon` carries `stale`, so a skill can say what the text says without parsing it.
- #41: an entry set aside has `tracker: null`: the daemon does not read its settings, so the overview does not either; the text shows its reason in place of the tracker.
- #41: a session that is not done, has no live lock and whose last run never ended (or that has no run recorded and is not blocked) is shown as crashed; a live lock without a session yet is a running row with `-` as step and since.
- #41: ready rows are the `<labels>:ready` issues that route to the entry by the rule `sous watch` uses and have no run folder there; titles of session rows come from `getIssue`, and a not-found answer leaves `-` without the note.
- #41: an empty table prints `no issue needs attention`, the done line appears only when something is done, and the per-issue JSON adds `workProgress` and `lastEval` to the facts so it carries everything the text form prints.
- #42: init prints one line for both skills, `init: installed the /sous-plan and /sous-run skills in <repo>/.claude/skills`, and `SKILL_SOURCE`/`SKILL_TARGET` became `SKILLS` and `SKILLS_TARGET`: one list, one folder, so a third skill is one name more.
- #42: the engine is `cd .sous && ./sous` when `.sous/sous` exists, so the wrapper's own cd and the project root agree; the per-issue answer ("how is 42 doing") also reads the overview, since its mode, daemon and UI lines come from there and the table row and worktree are the overview's.
- #42: the layout template lives inline in `SKILL.md`, not a separate file, so the skill reads as one document; `skills.test.ts` parses the front matter by line because the starter has no `yaml` dependency.
- #42: story 18's skill parts ride along with the skill (manual 8.4 paragraph and init step, starter README line, Unreleased Added line, `sous-setup` closing lines), since #41 already documented the overview and nothing else would.

## Further Notes

The slug of this spec is `sous-run-skill-the`, from the title's first four words; the title must not change before the run.
