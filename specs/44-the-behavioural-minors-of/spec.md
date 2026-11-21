# Spec: The behavioural minors of #12: ready after a hand-back, tracker build errors as notes, since without run.start, the skill's sorting and --restart prompt

- **Issue:** #44
- **Status:** derived

## Problem Statement

The reviews of #12 (the `sous-run` skill and the `sous status` overview)
logged minor findings that someone reading the overview, or the model
following the skill, notices:

- An issue handed back with `<labels>:ready` after its run blocked,
  crashed or was interrupted shows as `blocked` (or `crashed`,
  `interrupted`) in `sous status`, while `sous watch` treats it as ready
  and starts it: the two disagree on what is ready.
- A tracker that fails while the lookup builds it (a tracker module whose
  factory throws, a listed entry whose `sous.yaml` does not load) makes
  the whole overview fail, although a tracker that fails its query is
  only a note.
- One `getIssue` that fails for a reason other than not-found blanks every
  title of the entry, drops the ready rows `list` already returned, and
  sets the "did not answer" note.
- A run whose lock is live but which has not written `run.start` yet shows
  the previous run's start as `since`.
- The skill claims the JSON's rows are already ordered, never says how
  `--restart` is confirmed (the engine asks `[y/N]` on stdin), and its
  report counts "the sum of" a step's `iterations` without saying what is
  counted or whether the re-entry eval after a block counts.
- The starter's inventory test misses `skills/sous-run/` and
  `test/skills.test.ts`; the skills test does not pin that the notes come
  after the table; `status.test.ts` leaves several overview branches
  untested; `status.ts` imports `repoRootOf` without using it.
- The manual's automated-loop sentence on `sous status` names only some
  of the row order and writes the label as `sous:ready`.

## Solution

`sous status` and `sous watch` agree on what is ready; a tracker that
cannot be built, or one title it cannot fetch, costs that entry a note
and nothing more, and the overview always prints and exits 0 on a tracker
error; `since` never reports another run's start. The skill sorts the
table itself, says how a restart is confirmed and how a cancelled one
reads, and says exactly what its report counts. The starter tests and
`status.test.ts` cover what #12 added, and the manual gives the full row
order.

## User Stories

1. As someone who handed a blocked issue back with `<labels>:ready`, I want `sous status` to show it as a `ready` row, not a `blocked` one, so that it agrees with `sous watch`, which starts it.
2. As someone who handed back a crashed or interrupted issue with `<labels>:ready`, I want the same `ready` row.
3. As a reader of `sous status --json`, I want that ready row to carry the session's `branch` and `worktree`, so that I can find the work the run already did.
4. As a reader of `sous status --json`, I want a ready issue without a session to carry `branch` and `worktree` as `null`.
5. As a reader of the overview, I want a handed-back issue listed once, as ready, not also among the runs.
6. As someone whose `<labels>:ready` issue is still running under a live lock, I want it shown as `running`, as today.
7. As a home-repository maintainer whose entry's tracker module throws while it is built, I want the overview to print every other entry and that entry's note line naming the failure, and exit 0.
8. As a home-repository maintainer whose listed entry's `sous.yaml` does not load, I want the same: the other entries printed, a note line for that entry, exit 0.
9. As a single-repository user whose tracker module throws while built, I want the overview to print the daemon, the run viewer and the runs with `-` titles, and the note, and exit 0.
10. As someone whose tracker fails one `getIssue` with an error other than not-found, I want only that run's title shown as `-`, the other titles and the ready rows kept, and a note saying titles were not fetched.
11. As someone whose tracker answers not-found for a run's issue, I want that title `-` and no note, as today.
12. As someone whose run holds its lock but has not written `run.start` yet, I want `since` shown as `-`, never the previous run's start.
13. As someone whose run has written `run.start`, I want `since` from its open span, else its start, as today.
14. As a human asking the model for status, I want the table sorted by state (running, blocked, crashed, interrupted, ready), then entry, then issue, because the skill tells the model to sort it, not to trust the JSON's order.
15. As a human asking for a restart, I want the model to run `sous run <issue> --restart` only after I confirmed in the conversation, in a foreground call that answers the engine's `[y/N]` with my yes.
16. As a human whose restart was refused at the prompt, I want exit 1 with `restart cancelled` reported as a cancelled restart, not as a blocked run.
17. As a human asking for a report, I want each step's iterations given as the number of its spans' `iterations` entries, and the skill to say that the re-entry eval after a block (`n: 0`) is one of them.
18. As a maintainer of the starter, I want the inventory test to list `skills/sous-run` and `test/skills.test.ts`, so that neither drops out unnoticed.
19. As a maintainer of the skill, I want the skills test to fail when the notes stop coming after the table in the status layout.
20. As a maintainer of `sous status`, I want tests for a live lock without a session, an unreadable `watch.pid`, a `getIssue` that throws, a `getIssue` not-found, and a ready row with a blocked session.
21. As a reader of manual how-to 20, I want the sentence on `sous status` to list the rows in their full order (running, blocked, crashed, interrupted, ready) and write the label `<labels>:ready`.

## Implementation Decisions

- **Ready after a hand-back.** The ready query of an entry keeps the
  issues it already keeps and also keeps those whose session is blocked,
  crashed or interrupted; a session that is running or at `done` still
  excludes its issue from the ready list. Such an issue leaves the
  entry's `runs` and joins its `ready`. Every `ready` item gains `branch`
  and `worktree`: the session's branch and its worktree path, as a run row
  has them, or `null` without a session. Routing (`routeIssue`) applies
  to these issues as to any other ready issue.
- **Tracker build errors.** The overview builds each entry's tracker on
  its own. A failure while building (the tracker module's factory throws,
  the entry's settings do not load) becomes that entry's `note`; its runs
  are still listed with `-` titles when its settings loaded (they say
  where its runs are), and none when they did not; the other entries are
  built and queried as usual. The note names the entry and the error's
  message and says ready issues are not shown. `sous status` exits 0
  whatever a tracker does. `sous watch` and `sous run` keep refusing a
  lookup that does not build.
- **`getIssue` failures.** Each run's title is fetched on its own: not-found
  leaves the title `null` with no note; any other error leaves that title
  `null`, sets the entry's note, and the remaining titles and the ready
  rows from `list` stay. Only a failing `list` keeps today's behaviour
  (every title `null`, no ready rows, the "did not answer" note).
- **Since.** For a running row, the last run segment counts as the live
  run only when it has not ended and its `run.start` pid is the live
  lock's pid; otherwise `since` is `null` (`-`).
- **The skill.** The Status section tells the model to sort the rows by
  state (running, blocked, crashed, interrupted, ready), then by the
  entries' order in the JSON, then by issue, and drops the claim that
  `runs[]` comes ordered. The Start section says the engine asks `[y/N]`
  on stdin before a restart: the skill runs `--restart` only after the
  human confirmed in the conversation, in a foreground call that answers
  `y` on stdin, and reads exit 1 with `restart cancelled` as a cancelled
  restart. The Report section counts a step's iterations as the number of
  `iterations` entries of its spans and says the re-entry eval after a
  block (`n: 0`) counts as one.
- **Cleanup.** The unused `repoRootOf` import leaves `status.ts`.
- **Manual and changelog.** The how-to 20 sentence on `sous status` lists
  the rows as running, blocked, crashed, interrupted, then ready, writes
  `<labels>:ready`, and no longer says ready issues have no run yet. The
  Unreleased section of the changelog gets a line for the overview's
  behaviour changes, as the repository's changelog rule asks.

## Testing Decisions

- The overview is tested at `statusCommand` with temp repositories, the
  real lookup and fake trackers, as the existing "sous status: the
  overview" tests in `status.test.ts` do (`fixtureRepo`, `run`, `lock`,
  `deps`), asserting the printed table, the notes, the JSON and the exit
  code.
- New cases there: a live lock without a session (a `running` row with
  `-` step and since); a live lock over a session whose last run ended
  (since `-`); an unreadable `watch.pid` (`daemon` stale, pid null, the
  `unreadable` line); a `getIssue` that throws (that title `-`, the
  others and the ready rows kept, the note); a `getIssue` not-found
  (title `-`, no note); a ready row with a blocked session (`ready`, not
  `blocked`, with `branch` and `worktree` in the JSON); a tracker module
  whose factory throws and a listed entry whose `sous.yaml` does not load
  (the other entries printed, the note, exit 0).
- The skill is pinned in `starters/default/test/skills.test.ts` by phrase
  and order on the whitespace-flattened text, as its existing tests do:
  the sort instruction, the `[y/N]` confirmation and `restart cancelled`,
  the iteration count, and the notes after the table in the status
  layout.
- `starters/default/test/starter.test.ts` lists the two paths in
  `STARTER`; its "names only paths that exist" test covers them.

## Out of Scope

- Naming, wrapping and test-placement nits from the reviews of #12.
- Lookup-wide refusals that are not a tracker build error (an unreadable
  home `sous.yaml`, duplicate entry names, two entries on one tracker
  without `shared: true`): the overview keeps failing on them as today.
- How `sous watch` and `sous run` treat a tracker that does not build.
- The daemon's in-memory "still ready after its run exited" skip, which
  `sous status` cannot see.
- Any change to the per-issue `sous status <issue>` form.

## Assumptions

- A handed-back issue stays in `ready[]` of the JSON with two added fields (`branch`, `worktree`, `null` without a session) rather than becoming a run with state `ready`: the issue says "a ready row" that "keeps the session's branch and worktree in the JSON", and `ready[]` is where ready rows live and what the skill reads.
- Only blocked, crashed and interrupted sessions turn into ready rows; a running session stays running and a `done` session stays counted as done, as the issue names exactly those three states.
- The note for a tracker that failed while being built names the entry and the error's message and says ready issues are not shown; the issue fixes the behaviour (a note line, as a failing query does), not the wording.
- An entry whose tracker failed to build still lists its runs with `-` titles when its settings loaded, and none when they did not, because the runs folder comes from the settings; the issue only asks that it become a note and that the others print.
- In a home, an entry whose settings do not load keeps its place in the entry list with a tracker line that says the tracker was not built, so it is not mistaken for an entry set aside by the engine check.
- A `getIssue` failure other than not-found sets a note distinct from the `list` failure's (titles not fetched rather than ready issues not shown), since the ready rows are kept and the existing note would say otherwise.
- "The lock exists before the run wrote `run.start`" is detected by the last run segment having ended or having a `run.start` pid other than the live lock's pid; this also covers a previous run that crashed without `run.end`, which "never the previous run's start" requires.
- The skill confirms `--restart` by answering `y` on the engine's stdin after the human said yes in the conversation; a tool call cannot answer the prompt interactively, and the issue requires the human's confirmation first.
- The re-entry eval after a block counts as an iteration in the report, matching `sous status <issue>`, whose `(N iter)` counts every `iterations` entry; the issue only asks that the skill say which.
- The manual sentence also drops "that have no run yet", because after the first criterion a handed-back issue with a run is a ready row; leaving it would make the sentence wrong.
- The changelog's Unreleased section gets a line, as CLAUDE.md asks for a change people would notice.

## Open questions

- None.

## Decisions

- The overview builds its entries through a new `overviewLookupOf`, which sets an entry whose tracker does not build aside in an optional `Lookup.broken` (with its lister when its settings loaded); `lookupOf`, which `sous watch` and `sous run` use, still refuses, so their behaviour is unchanged.
- The build-failure note reads `tracker of <entry> not built: <message>; ready issues not shown`, the `getIssue` note `tracker <location> did not answer for some issues; their titles not shown`, and a home entry whose settings did not load shows `tracker not built` on its tracker line.
- A live lock without a session also keeps its issue out of the ready rows, as a running session does, so a `<labels>:ready` issue whose run is starting stays one running row.
- The skill answers the restart prompt with `printf 'y\n' | sous run <issue> --restart`, the concrete form of "a foreground call that answers `y` on stdin".
- The changelog line extends the Unreleased "Added" bullet of the overview, which has not shipped yet, instead of a separate "Changed" line about a behaviour no release had.
- The skills test pins the notes after the table by adding the layout's `<notes>` line to the existing layout-order test.
## Further Notes

None.
