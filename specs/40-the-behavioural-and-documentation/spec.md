# Spec: The behavioural and documentation minors of #35: old-key hints by type, init over a string tracker, parse before lookup in a home sous run, the # split only in a home, stale prose

- **Issue:** #40
- **Status:** derived

## Problem Statement

The reviews of #35 (one lookup for `sous run` and `sous watch`, the
`tracker:` block) logged minor findings that a person running sous notices:

- An old `tracker: beads` (or `local`, or a module path) is refused with
  the github block, so the hint sends a beads user to the wrong tracker.
- `sous init` over a starter whose `sous.yaml` still has a string
  `tracker:` leaves the line as it is and writes a `sous.yaml` the next
  `sous validate` refuses.
- In a home repository `sous run` builds the whole lookup before it reads
  its arguments: a usage error or `--repo` is hidden behind a broken
  entry, and `sous run web#42` fails because of another entry.
- Outside a home repository an issue id containing `#` is split as
  `name#issue` and refused, so a tracker whose ids contain `#` cannot be
  run.
- `sous validate` judges the same-location-unshared conflict over every
  listed entry with settings, `sous watch` over the entries it loads, so
  a conflict with an engine-refused entry is an error in one and not in
  the other.
- The home `sous run` collision message lists every entry on a shared
  tracker although one qualified form per tracker is enough, and the
  "not asked" suffix is appended to messages that are not about a miss.
- `sous init` reads `repo` as the last two path parts of any origin URL
  (a GitLab or nested URL becomes a wrong `owner/name` without warning),
  and its no-origin warning fires on the placeholder text anywhere in the
  file, comments included.
- The manual, the changelog, the tracker sheets, the plan prompt and
  `sous-setup` still carry wording from before #35.

## Solution

Every refusal names the fix for the user's own tracker type; `sous init`
never leaves an old string `tracker:` behind; a home `sous run` reports
argument errors first and `name#issue` depends on that entry alone; the
`#` split is a home-repository feature; `sous validate` and `sous watch`
judge the same entries; the home messages say exactly what is needed;
`sous init` only trusts a github.com `owner/name` origin; and the prose
says what the code does.

## User Stories

1. As a beads user with `tracker: beads` in `sous.yaml`, I want the refusal to show `tracker: { type: beads, shared: false, labels: sous }`, so that I copy a block for my own tracker.
2. As a local-tracker user with `tracker: local`, I want the refusal to show a `type: local` block with a `dir`, so that I know the folder key is required.
3. As a github user with `tracker: github`, I want the refusal to show the github block with `repo`, as today.
4. As a user of a tracker module with `tracker: trackers/jira.ts`, I want the refusal to show `type: trackers/jira.ts`, so that my module stays named.
5. As someone running `sous init --starter <dir>` over a starter whose `sous.yaml` has a string `tracker:`, I want init to stop and name that line before copying anything, so that I never get a `sous.yaml` that `sous validate` refuses.
6. As someone typing `sous run --bogus` or `sous run 42 --repo api` in a home repository, I want the usage error or the `--repo` message even when an entry's `sous.yaml` is broken.
7. As someone typing `sous run web#42` in a home repository, I want only web's tracker built and asked, so that a broken or engine-refused other entry does not stop it.
8. As someone outside a home repository, I want `sous run abc#7` to ask my tracker for the id `abc#7` unchanged, so that ids containing `#` work.
9. As someone outside a home repository, I want `sous run #96` to still mean issue `96`.
10. As a reader of the manual's CLI reference, I want it to say that `name#issue` applies only in a home repository and that elsewhere the id goes to the tracker as typed.
11. As a home-repository maintainer, I want `sous validate` to report a same-location-unshared conflict exactly when `sous watch` would refuse it, so that an engine-refused entry is judged the same by both.
12. As someone hitting a number held by several trackers, I want one `sous run <name>#<issue>` per tracker that holds it, not one per entry on a shared tracker.
13. As someone hitting a closed issue, an unanswered tracker, a collision or a routing skip, I want no "not asked, as nothing runs there" suffix; I want it only on the not-found message.
14. As a reader of manual chapter 21, I want the repo-label rule stated as the code applies it: an unlabelled issue of an unshared tracker runs where listed; a shared tracker's unlabelled issue is skipped with `tracker <location> is shared; add repo:<name>`.
15. As someone whose `sous watch` or `sous validate` refuses two entries on one tracker without `shared: true`, I want a troubleshooting row for that message.
16. As a reader of the changelog, I want the older Unreleased entry on the flow from labels to show `sous run <issue | name#issue> [--flow <name>] [--restart]`.
17. As someone adapting the plan prompt or a tracker sheet, I want them to say the state-label prefix is `tracker.labels` with no default, and to name the sheet `.sous/trackers/<type>.md`.
18. As someone following `sous-setup` for several repositories, I want it to say the home repository's own `tracker:` block must be valid even when the home is not listed, and never to tell me to set `tracker` to a bare name.
19. As someone running `sous init` in a checkout whose origin is a GitLab URL, a github.com URL with more than `owner/name`, or no origin, I want `repo: owner/name` written with the warning to set `tracker.repo`.
20. As someone running `sous init` with a github.com `owner/name` origin, I want `repo` filled in and no warning, even if a comment in the starter's `sous.yaml` mentions `owner/name`.

## Implementation Decisions

- **Old-key hint by type.** The string-`tracker:` refusal of the settings
  parser builds the block from the string: `github` keeps the current
  block (`repo: owner/name`), `beads` has no location key, `local` has
  `dir`, and any other string is a module path shown as `type: <path>`.
  Every block carries `shared: false, labels: sous`, as today's does. The
  `trackerOptions` and `labelPrefix` messages are unchanged. The
  `tracker is required` message (no block at all) keeps the github block.
- **`sous init` over a string tracker** refuses, as the issue permits,
  instead of converting: the starter's `sous.yaml` is checked for the old
  keys with the same refusals the settings parser gives, before anything
  is copied, and init exits naming the file and the line. Nothing is
  written.
- **Home `sous run` parses first.** The arguments are parsed before any
  tracker loads, so usage, old-form and `--repo` errors come first. A
  bare id builds the full lookup as today. `name#issue` builds the named
  entry alone (its settings, engine check and tracker); an unknown name
  or an entry the daemon would set aside is refused as today. The other
  entries take part in routing by name only, the way set-aside entries
  already do, so their settings are not read.
- **`#` split only in a home.** Parsing no longer splits `name#issue` for
  every caller: a plain `sous run` keeps the id as typed, minus one
  leading `#`, and the refusal "names an entry of repos:, and this
  repository's sous.yaml lists none" goes away. The home path splits at
  the last `#`, as today.
- **One judgement of the same-location check.** `sous validate` checks
  the entries the daemon loads: an entry without `.sous/sous.yaml`, one
  whose `engine:` the running engine does not satisfy, or one whose
  settings do not load is left out. Each of those is still reported by
  its own check.
- **Home messages.** The collision lists one `sous run <name>#<issue>`
  per tracker that holds the number open, named by the first entry on
  that tracker in `repos:` order. The "not asked" suffix goes only on
  `issue <id> is in none of the trackers asked (…)`.
- **Origin to `repo`.** `sous init` takes `owner/name` only from a
  github.com origin whose path is exactly two parts (`.git` and a
  trailing slash allowed), in the scp form (`git@github.com:o/n`) and
  the URL forms (`https://`, `http://`, `ssh://git@`, `git://`). Any other
  origin counts as none: the placeholder is written and the warning
  printed. The warning is printed when the written block's `repo:` value
  is the placeholder, not when the text appears anywhere in the file. The
  warning's wording may name a non-github origin as well as a missing
  one. `repoNameOf` (the repository's name in labels) is not changed.
- **Documentation.** Manual chapter 21's "Where an issue runs" paragraph,
  a troubleshooting row for the same-location message, the CLI reference
  line of `sous run`, the older Unreleased changelog entry's usage line,
  the three tracker sheets, the plan prompt and `sous-setup` are made to
  match the code. The Unreleased changelog entries that describe the
  changed behaviour are amended.

## Testing Decisions

- Tests check what a user sees: exit codes, `err`/`out` lines, the files
  init writes, which trackers were asked. No test touches git, a real
  tracker or an agent.
- Settings parser: one case per string type (github, beads, local, a
  module path), in the existing settings tests.
- `sous init`: a temp starter with a string `tracker:` (prior art: the
  placeholder test in the init tests) is refused and leaves `.sous/`
  absent; origin cases through the injected `exec`: a github.com
  `owner/name` in each form, a GitLab URL, a github.com URL with three
  path parts, none; a starter comment containing `owner/name` with a
  github origin gives no warning. The origin parser is tested alone in
  the repos tests.
- Home `sous run`: through `startRun` (the start tests), a broken entry
  plus a usage error, `--repo`, and `web#42`; an engine-refused or broken
  other entry does not stop `web#42`.
- Plain `sous run`: `abc#7` reaches the fake tracker as `abc#7`; `#96` as
  `96` (run tests).
- `sous validate` and `sous watch` on one fixture with two unshared
  entries on one location, one of them engine-refused: neither reports
  the conflict.
- Collision and suffix: the home run tests with entries on a shared
  tracker and an unrunnable entry.
- Prose: where `starters/default/test/prompts.test.ts` pins the sheets'
  and plan prompt's text, it follows the new wording.

## Out of Scope

- The cosmetic nits of #35 the issue excludes: line wrapping, commit
  subjects, test phrasing, the comma operator.
- Converting a starter's old keys in `sous init`; carrying old
  `trackerOptions` or `labelPrefix` values into the hint.
- `<tracker>.md` wording outside the tracker sheets and the plan prompt
  (README, manual, `PLAN-SKILL-FLOW.md`).
- Changing how a bare id is looked up in a home repository, or how
  `repoNameOf` reads the origin.

## Assumptions

- Init refuses rather than converts: the issue allows either; refusal needs no value for `dir` or a module's keys that init cannot know, and the shipped starter already has the block, so only a custom `--starter` meets it.
- Init's refusal covers all three old keys (`tracker` as a string, `trackerOptions`, `labelPrefix`), with the parser's messages: refusing only the string form would let the next `sous validate` refuse the others, which the issue rules out.
- Init's refusal exits 2 before copying, like its missing-starter refusal, so no half-initialised `.sous/` is left.
- The `owner/name` placeholder `sous init` writes without a github origin stays the one documented exception to "never writes a `sous.yaml` that `sous validate` refuses"; the changelog describes it.
- The hint's `local` block shows `dir: issues`, the folder `sous-setup` recommends; every hint block carries `shared: false, labels: sous`, as the current github one does.
- A leading `#` is still stripped outside a home repository (`sous run #96` is documented); only the `name#issue` split moves to the home path.
- `sous run web#42` builds web's entry alone and passes the other entries to routing by name only, as set-aside entries are passed today; a same-location conflict among other entries does not affect it.
- The collision names each tracker by its first entry in `repos:` order; any entry on a shared tracker asks the same tracker and routes by label, so the choice does not change where the issue runs.
- The "not asked" suffix goes on the not-found message only, not on "closed wherever it is found".
- `sous validate` leaves out entries whose settings do not load, as it does today, in addition to those without `sous.yaml` and the engine-refused ones; that matches the entries the daemon loads.
- github.com origins are recognised in the scp, `https`, `http`, `ssh://git@` and `git://` forms, with an optional `.git` and trailing slash; GitHub Enterprise hosts count as non-github.
- "The home repository's own `tracker:` block must be valid" means a block that is present must pass the tracker checks; a home whose `repos:` does not name itself may still have none, as the troubleshooting table says and the code does.
- Where a document named by the issue already states the required wording (chapter 21 already has the shared-tracker skip message; no "bare name" line was found in `sous-setup`), the implement step only checks it and brings the rest in line.
- The Unreleased changelog entries that describe the changed behaviour are amended in place rather than given new lines.

## Open questions

- None.

## Decisions

- `sous init` refuses an old key in a starter's `sous.yaml` with one `sous init: <file>:<line>: <refusal>` line per key, exit 2, before the not-empty check and before any copy; a starter `sous.yaml` that does not parse is left to `sous validate`, as before.
- The home `sous run` refuses an unknown name or a set-aside entry of `name#issue` before calling the lookup, from the home's `repos:` and the entry's `.sous/sous.yaml` and `engine:` alone; `lookupOf` takes an optional `only` name, and `HomeRunDeps.lookup` became a function so the lookup is built after parsing.
- `name#` with nothing after the `#` exits 2 with the usage line in a home repository; outside one `web#` goes to the tracker as typed, like any id containing `#`.
- The not-asked suffix test and the one-form-per-shared-tracker test were written with the change, not before it; the previous code listed every entry on a shared tracker and put the suffix on the closed message, which these tests refuse.
- The starter's prompt tests (`starters/default/test/prompts.test.ts`) were not run here: they import the built `sous-factory`, which `starter:install` links; the pinned strings were checked against the files directly and the evaluation runs the suite.
- `sous run name#issue` reads the other entries' tracker locations tolerantly (`listedTrackersOf`, no tracker built) instead of passing them to routing by name only, as the review found: by name only, routeIssue skipped its guard and a shared issue labelled for an entry on another tracker would start there and be looked up on the wrong tracker; an entry whose settings do not load or that is set aside still takes part by name only, so story 7 holds.

## Further Notes

None.
