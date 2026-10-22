# The sous manual

The reference for people who run, extend and adapt a sous project. The
[README](../README.md) is the short version; this is the long one.

**Part I: Getting started**
1. [Install and init](#1-install-and-init)
2. [Engine, project, UI](#2-engine-project-ui)
3. [Your first run](#3-your-first-run)

**Part II: Concepts and reference**
4. [Concepts](#4-concepts)
5. [Steps](#5-steps)
6. [Flows](#6-flows)
7. [Variables and expressions](#7-variables-and-expressions)
8. [Execution](#8-execution)
9. [Settings: `sous.yaml`](#9-settings-sousyaml)
10. [Trackers](#10-trackers)
11. [Run record, lifecycle, resume](#11-run-record-lifecycle-resume)
12. [CLI](#12-cli)

**Part III: How-tos**
13. [Change the check commands](#13-change-the-check-commands)
14. [Change the agent or model per step](#14-change-the-agent-or-model-per-step)
15. [Add a step](#15-add-a-step)
16. [Add or change a flow](#16-add-or-change-a-flow)
17. [Adapt the plan phase](#17-adapt-the-plan-phase)
18. [Use another tracker](#18-use-another-tracker)
19. [Run with `lifecycle: steps`](#19-run-with-lifecycle-steps)
20. [Test steps and flows](#20-test-steps-and-flows)
21. [Vendored skills](#21-vendored-skills)
22. [Troubleshooting](#22-troubleshooting)

---

# Part I: Getting started

## 1. Install and init

### Prerequisites

Once per machine:

- Node 22 or newer.
- For the GitHub tracker (the starter's default): the `gh` CLI, logged in
  (`gh auth status`).
- The agent CLI the flows name on the `PATH`: `claude` (the starter's
  default) or `codex`. The sandbox runs them as subprocesses.

### The guided route

Install the setup skill into the repository, then run it in Claude Code:

```
cp -r <clone of github.com/sousfactory/sous>/skills/sous-setup .claude/skills/
```

`/sous-setup` checks the prerequisites, runs the install and init below
when `.sous/` is missing, then goes through the files that need adapting
one at a time, shows every edit as a diff, and runs `validate` and the
tests. Last, it looks for a development-loop skill the repository already
has and offers to port it with `/sous-migrate` now or later. It skips what is already done, so it is safe to run again
later. The skill is not part of the package, since it runs *before* the
project exists.

**Porting an existing workflow.** If the repository already has a
development-loop skill (one big `SKILL.md`, or one that chains sub-skills
and scripts), `skills/sous-migrate` ports it into a flow beside it:
install it the same way and run `/sous-migrate <skill>` after setup. It
maps every part of the skill to a step, eval, prepare, route or "not
ported", shows that mapping for a yes before writing anything, keeps
sub-skills whole as one step each, and lists the moves that would take
more out of the agent as suggestions only.

### By hand

From the repository root:

```
npm install -D sous-factory
npx sous init
```

`sous init`:

1. copies the starter bundled with the package into `.sous/` (refuses a
   non-empty `.sous/` unless `--force`);
2. writes `.sous/.gitignore` with `logs/`, `runs/` and `node_modules/`;
3. copies `.sous/skills/sous-plan` to `.claude/skills/sous-plan`, so
   `/sous-plan` is available in Claude Code;
4. runs `npm install` in `.sous/`;
5. prints the checklist.

`--starter <dir>` copies another folder instead of the bundled starter.

What the repository looks like afterwards:

```
your-project/
├── .claude/skills/sous-plan/     # the planning skill, copied by init from .sous/skills/sous-plan
├── specs/<id>-<slug>/spec.md     # written by /sous-plan; the specsDir setting, ../specs from .sous
├── .sandcastle/worktrees/        # the run's worktree, created by the sandbox at the first run
└── .sous/
    ├── .gitignore                # written by init: logs/, runs/, node_modules/
    ├── sous.yaml                 # settings: tracker, baseBranch, branch, lifecycle, dirs
    ├── sous                      # wrapper: cd here and `npx sous "$@"`
    ├── package.json              # depends on sous-factory; typecheck and test scripts
    ├── node_modules/             # the engine, installed by init  (gitignored)
    ├── tsconfig.json             # for the steps and tests
    ├── vitest.config.ts
    ├── flows/
    │   ├── task.yaml             # one issue: init → implement → review ⇄ fix → sync → review-full → merge
    │   ├── feature.yaml          # an issue with sub-issues: the same, per sub-issue, then as a whole
    │   └── bench.yaml            # smoke test: hello-world → tell-a-joke; writes nothing
    ├── steps/
    │   ├── _shared.ts            # helpers the steps share; not a step
    │   ├── init/                 # each step: step.yaml, README.md, and run.ts (module)
    │   ├── next-work/            #   or prompt.md (+ eval.ts, prepare.ts) for an agentic step
    │   ├── close-work/
    │   ├── implement/
    │   ├── review/               # with findings.ts, the review helpers
    │   ├── fix/
    │   ├── verify/               # eval.ts: BASE_BRANCH and CHECKS, the project's commands
    │   ├── sync-resolve/
    │   ├── merge/
    │   ├── hello-world/
    │   └── tell-a-joke/
    ├── skills/                   # vendored skills (VENDORED.md names source and license) and sous-plan/
    ├── prompts/plan.md           # the procedure /sous-plan follows; ADAPT notes mark what to change
    │   └── plan.beads.md         # the same for tracker: beads; keep the one your tracker needs
    ├── test/                     # the project's step and flow tests, over sous-factory/testing
    ├── logs/<id>/                # one agent log per iteration             (gitignored)
    ├── runs/<id>/                # session.json and events.jsonl per issue (gitignored)
    └── locks/<id>.lock           # pid and issue of a running sous run; removed when it ends (gitignored)
        locks/repo.mutex          # held by the run working on the shared checkout (merge), seconds at a time
```

The settings `*Dir` keys move these folders; the defaults are what the
tree shows.

### The checklist, item by item

```
init: still to do by hand:
  1. .sous/steps/verify/eval.ts: set BASE_BRANCH and fill CHECKS
  2. .sous/sous.yaml: tracker, baseBranch, branch template, lifecycle
  3. .sous/flows/*.yaml: agent models and allowedLabels; create the labels on the tracker
  4. .sous/prompts/plan.md: follow its ADAPT notes (tracker beads: move plan.beads.md over it first)
  5. cd .sous && ./sous validate && npx vitest run; then ./sous run bench <issue>
```

1. **`steps/verify/eval.ts`.** `CHECKS` is the list of commands that
   decide whether an implementation passes; `BASE_BRANCH` is what the diff
   is taken against. Until `CHECKS` is filled, every verify passes and
   writes `WARN: no checks configured` into its log, so the gap is visible
   in `sous status` and the UI. See [how-to 13](#13-change-the-check-commands).
2. **`sous.yaml`.** `tracker` (`github` by default, `beads` for bd),
   `baseBranch`, the `branch` template for run branches, `lifecycle`
   (whether the run itself claims and closes the issue). See
   [chapter 9](#9-settings-sousyaml).
3. **Flows.** Every agentic entry names an `agent: { kind, model }`; pick
   the models you have access to. `allowedLabels` decides which issues a
   flow accepts: `type:task` and `type:bug` for `task`, `type:feature` for
   `feature`. On GitHub, create those labels (`gh label create type:task`,
   and so on); bd needs none, the tracker derives them from the bead type.
4. **`prompts/plan.md`.** The plan prompt carries `<!-- ADAPT: … -->`
   notes naming what is repository-specific: rule files, the spec folder,
   the labels. Apply each and delete the note. The starter's `plan.md`
   speaks `gh`; with `tracker: beads`, move `prompts/plan.beads.md` over it
   first and delete the other one otherwise.
5. **Verify.** `./sous validate` checks every flow and step; the tests
   walk the flows over fakes; `bench` is a flow that runs one module step
   and one agent step without touching the issue or the code.

## 2. Engine, project, UI

| Part | Contents | Lives in |
| --- | --- | --- |
| Engine | executor, CLI, trackers, sandbox, run record, `sous-factory/testing` | the npm package `sous-factory` |
| Project | `sous.yaml`, `flows/`, `steps/`, `skills/`, `prompts/`, tests | `.sous/` in your repository |
| UI | `sous ui`, the run viewer | bundled into the package under `dist/ui/` |

The engine never imports the project. It reads `sous.yaml`, loads the
flows from YAML and your steps and tracker module through `tsx`, so a
project needs no build step. Steps reach the engine through
`import … from "sous-factory"`.

**The starter is optional.** `sous init` copies `starters/default`: three
flows (`task`, `feature`, `bench`), eleven steps, the vendored skills, the
plan prompts and the tests. It is a working factory for a repository
tracked on GitHub or in bd, and the recommended beginning. Nothing in the engine depends on
it:

- Keep the delivery flows and change the steps they use: `implement`,
  `review`, `fix` are prompts and an eval each; `verify` is a list of
  commands.
- Drop what you do not need. `bench` and its two steps are a smoke test;
  `next-work` and `close-work` only serve `feature`.
- Write your own flows from your own steps. A flow needs an `entry` and
  steps that route to `done`; `init` and `merge` are starter steps, not
  engine features.

**Upgrading the engine** is `npm update sous-factory` in `.sous/`. Your
`.sous/` files are not touched; a new starter version changes nothing in
a project that already has one. Diff `node_modules/sous-factory/starter/`
against your `.sous/` when you want to pick up starter changes.

## 3. Your first run

```
cd .sous
./sous validate                 # every flow, every step, sous.yaml
./sous run bench <issue id>     # hello-world (a module), tell-a-joke (an agent)
./sous status <issue id>
```

`bench` has `lifecycle: steps`, so it reads the issue and writes nothing
to the tracker; it commits nothing either. Its agent step runs once and
costs one short model call.

Then a real task. Label an issue `type:task`, and:

```
./sous run task <issue id>
```

What happens, in order: the issue is claimed (`sous:running` on GitHub), a
worktree is opened on `feature/<id>-<slug>`, the spec is read from
`specs/<id>-*/spec.md` in that worktree (the issue itself serves as the
spec when `/sous-plan` did not write one), `init` checks the issue is
open, `implement` builds and commits, `review` judges the diff, `fix` addresses
findings, `sync` brings the base branch in, `review-full` judges the whole
branch, `merge` squashes it onto the base branch, and the issue is closed.
If the base branch moved after the last `sync` (another run merged in the
meantime), `merge` lands nothing and the flow goes back to `sync`
(`resync: ${{ true }}` on the `merge` entry, with a route on `result.output.stale`).

Watch it in a second terminal with `./sous status <id>` or in the browser
with `./sous ui`. The UI lists every run, draws the flow with the visited
steps coloured, and opens any step's visits, agent log and output.

**When a run stops `blocked`**, the issue gets a comment with the step,
the eval's last log and the worktree path. Open the worktree, fix what the
log says, and run the same `./sous run task <id>` again: the run re-enters
the step at its eval, so a manual fix moves it on without an agent call.
`--restart` throws the run record, worktree and branch away and starts
over.

---

# Part II: Concepts and reference

## 4. Concepts

| Term | Meaning |
| --- | --- |
| Step | A folder `<stepsDir>/<name>/` with `step.yaml`: declared inputs, a prompt or a module, an optional `prepare` and `eval`. A step never names another step. |
| Flow | `<flowsDir>/<name>.yaml`: an `entry` and a list of entries, each using a step with its own `with:`, `agent` and `routes`. The same step may be used by several entries. |
| Visit | One pass through an entry. Loops are routes back to an earlier entry. |
| Envelope | What a step returns: `{ summary, commits, output, skills? }`. `output` follows the step's `run.output` schema. |
| Work item | The item on the bench (`ctx.work`): the run's issue, or a sub-issue a module put there. `steps.<id>` is scoped by it. |
| Run record | `<runsDir>/<issue id>/session.json` (control state) and `events.jsonl` (what happened). |

**The GitHub Actions analogy.** A flow is a workflow, a step an action, a
visit a job run; `with:` wires inputs the same way, and the project owns
its flows while the engine owns none. The analogy stops at three places.
Routes carry conditions and may point backwards, so a flow is a graph
with loops, not a list. An eval judges each visit and a failed eval
retries the agent in the same session before the routes are consulted.
And a run has a work item: a module may put a sub-issue on the bench, and
`steps.*` then counts visits per item, which is how review rounds are
capped per sub-issue.

**From idea to merge.** Plan with a human, then run without one:

1. `/sous-plan [#id]` in Claude Code: an interactive session that
   clarifies the idea, writes `specs/<id>-<slug>/spec.md`, and for a
   feature files sub-issues with acceptance criteria and blockers. Without
   an id it creates the issue first. Issues are filed as you approve them;
   the spec is committed only after an explicit GO.
2. `./sous run <flow> <id>`: the factory runs the issue through `<flow>`.
   A flow's `allowedLabels` refuses issues it is not meant for.

## 5. Steps

```yaml
name: <step>                       # required; the folder name
description: …
inputs:                            # names the prompt or module may use
  topic: { required: true, description: "…" }   # required defaults to true
  checks: { prompt: false, description: "…" }   # read by prepare or eval only; no placeholder needed
prepare:                           # optional, prompt steps only
  module: ./prepare.ts
  output: { type: object, … }      # JSON Schema of prepare's output
run:
  prompt: prompt.md                # an agentic step …
  output: { type: object, … }      # … with the JSON Schema of `output`
  # or: module: ./run.ts           # a deterministic step; output schema optional
eval: ./eval.ts                    # or { shell: "npm test" }; optional
maxIterations: 3                   # agentic default 3
loop: true                         # false: a failed eval routes instead of retrying
```

- **Kinds.** `run.prompt`: agentic, the flow entry must name an `agent`.
  `run.module`: deterministic, runs once. No `run` but an `eval`:
  eval-only, the eval is the work. Neither is an error.
- **Prompt.** Markdown with `{{input}}`, `{{ctx.*}}` and `{{prepared.*}}`
  placeholders ([chapter 7](#7-variables-and-expressions)). Every
  `{{input}}` must be declared and every input used, unless the input
  says `prompt: false`. An unwired optional input and a missing prepared
  value render empty. `` !`cmd` `` is rejected.
- **Eval.** Judges the visit: `{ ok, log }`. A failed eval retries the
  agent in its session with the log ([chapter 8](#8-execution)); without
  an eval a step always passes. `{ shell }` is ok iff the command exits
  0, log = stdout + stderr.
- **Prepare.** Runs once per visit before the prompt is rendered and
  decides when the agent runs: `{ agent: "always" | "on-fail" | "never",
  reason?, output }`. `output` fills `{{prepared.*}}` and reaches the eval
  and the routes as `prepared`. `always`: the agent starts now. `on-fail`:
  the eval runs first, as iteration 0, and the agent starts only if it
  fails, with the eval log appended to its prompt. `never`: the eval runs
  once without a result and the visit routes on it; for a step whose eval
  cannot fail after this prepare and that has no prompt for a repair.

### 5.1 Signatures

```ts
import type { RunFn, PrepareFn, EvalFn } from "sous-factory";

type RunFn     = (ctx: Ctx, inputs: Inputs) => Promise<Envelope | void>;
type PrepareFn = (ctx: Ctx, inputs: Inputs) => Promise<{ agent: "always" | "on-fail" | "never"; reason?: string; output: unknown }>;
type EvalFn    = (ctx: Ctx, inputs: Inputs, result?: Envelope, prepared?: Prepared) => Promise<{ ok: boolean; log: string }>;
```

`inputs` are the resolved `with:` values. `result` is absent after a
module that returned nothing, an eval-only step, and in an eval that runs
before any agent. A
module and a prepare may assign `ctx.work` (a new work item, a new scope),
assign `ctx.specDir`, and call `ctx.workDone(commits)`; the engine records
them after the call.

### 5.2 `sous-factory` exports

- `sous-factory`: the types above, `Ctx`, `Envelope<Output>`,
  `Prepared<Output>`, `EvalResult`, `Inputs`, `Issue`, `Work`, `Git`,
  `Tracker`, `TrackerFactory`, `TrackerEnv`, `Event`; `SousError`;
  `loadFlow`, `loadStep`, `validateProject`, `renderGraph`.
- `sous-factory/testing`: in-memory fakes and the harness
  ([how-to 20](#20-test-steps-and-flows)).

## 6. Flows

```yaml
allowedLabels: [type:task, type:bug]          # optional: issues without one of these are refused
lifecycle: steps                             # optional: overrides the setting; this flow then never claims or closes an issue
entry: draft
steps:
  - id: draft
    uses: write-draft                         # a step name under stepsDir
    agent: { kind: claude, model: claude-opus-5-5 }   # or { kind: codex, model: … }
    resume: ${{ steps.draft?.session }}       # optional: an agent session to continue
    with:
      topic: ${{ ctx.work.ref + " " + ctx.work.title }}
    maxIterations: 2                          # optional override; also loop
    routes:
      - to: check
        when: res.ok
      - to: blocked
        else: true
```

`<flowsDir>/<flow>.yaml` is run as `sous run <flow> <issue>`. With
`allowedLabels`, `sous run` refuses an issue that carries none of them
(exit 2), so an issue cannot go through a flow meant for another kind of
issue. Without it, any issue is accepted.

### 6.1 Entry fields

| Field | Meaning |
| --- | --- |
| `id` | Unique in the flow; the key of `steps.<id>`. |
| `uses` | A step folder name, never a path. |
| `agent` | Required for an agentic step, rejected otherwise. Step files name no model. |
| `with` | Input values. `${{ expr }}` as the whole value keeps its type; inside text it is stringified (objects as JSON). Required inputs must be present, unknown ones are an error. |
| `resume` | Expression yielding an agent session id: the first iteration continues that session. |
| `routes` | Ordered `{ to, when }`; first match wins. The last route must be unconditional (no `when`, or `else: true`), unless every `when` is `true`. Quote conditions containing `: `, `[` or `#`. |

### 6.2 `done` and `blocked`

Reserved targets. `done` ends the run. `blocked` stops it for a human:
the step stays current, the lifecycle marks the issue blocked with a
comment, the worktree is kept. An agentic step that exhausts
`maxIterations` goes to `blocked` without consulting its routes.

### 6.3 Validation

`sous validate` (and every `run`) checks `sous.yaml` and every flow: ids
unique, every target exists, every entry reachable and `done` reachable,
steps load, schemas are valid JSON Schema, placeholders match inputs,
`{{prepared.x}}` names a `prepare.output` property, `with` and `agent`
fit the step, every expression compiles, the routes end in a fallthrough,
and a tracker module builds. Every error is listed as `<file> [<id>]:
<rule>: <message>`; exit code 2.

## 7. Variables and expressions

What each part of a step, and each flow expression, can use. **Prompt**
means a `{{…}}` placeholder; anything else reaches a prompt only through
an input wired in `with:`. **Modules** are `run.module` and `prepare`;
both get `(ctx, inputs)`. **Eval** gets `(ctx, inputs, result, prepared)`.
**Flow** means `with:` / `resume:` (`${{ }}`) and `when:`; these are plain
JavaScript, compiled once, not sandboxed.

| Variable | Content | Prompt | Modules | Eval | Flow |
| --- | --- | --- | --- | --- | --- |
| inputs | the entry's `with:` values | `{{name}}` | `inputs` | `inputs` | — |
| `ctx.issue` | run target `{ id, ref, title, body, labels }`; `id` is the tracker's own, `ref` how it writes it in text (`#96`) | `{{ctx.issue.id}}`, `{{ctx.issue.ref}}` | ✓ | ✓ | ✓ |
| `ctx.work` | work item `{ id, ref, title, body }` | `{{ctx.work.id}}`, `{{ctx.work.ref}}` | ✓ assignable | ✓ | ✓ |
| `ctx.worktree` | absolute worktree path | `{{ctx.worktree}}` | ✓ | ✓ | ✓ |
| `ctx.spec` | the spec as markdown: `spec.md` from the spec folder in the worktree, read at every `sous run` start, else the issue's title and body | `{{ctx.spec}}` | ✓ | ✓ | ✓ |
| `ctx.specDir` | spec folder, relative to the repository | `{{ctx.specDir}}` | ✓ assignable | ✓ | ✓ |
| `ctx.skillsDir` | absolute `skills/` path | `{{ctx.skillsDir}}` | ✓ | ✓ | ✓ |
| `ctx.flow`, `ctx.branch`, `ctx.previous` | flow name, run branch, entry visited before | — | ✓ | ✓ | ✓ |
| `ctx.iteration` | iteration of the visit (0: re-entry eval) | — | — | ✓ | `when` |
| `ctx.readFile(path)`, `ctx.repoFiles(paths)` | worktree files; `repoFiles` gives `### <path>` + content | — | ✓ | ✓ | ✓ |
| `ctx.exec(cmd, opts?)` | `{ code, stdout, stderr }` in the worktree; never throws | — | ✓ | ✓ | — |
| `ctx.workDone(commits)` | marks the work item done in the run record | — | ✓ | — | — |
| `ctx.git`, `ctx.tracker` | git and issue-tracker ports | — | ✓ | ✓ | — |
| `ctx.repoRoot`, `ctx.workProgress`, `ctx.events`, `ctx.sandbox` | checkout, progress per work item, event log, sandbox | — | ✓ | ✓ | — |
| `ctx.repoLock(fn)` | runs `fn` as the only run on the repository checkout; a check and the change it guards belong in one call | — | ✓ | ✓ | — |
| `prepared` | `{ agent, reason?, output }` of the visit's prepare | `{{prepared.<field>}}` of `output` | returned by prepare | 4th argument | `when` |
| `result` | the visit's envelope `{ summary, commits, output }` | — | returned by run | 3rd argument | `when` |
| `res` | `{ ok, log }` of the visit's final eval | — | — | returned | `when` |
| `steps.<id>` | latest visit in this scope: `{ visits, ok, log, output, commits, session, prepared }` | — | — | — | ✓ |

Assigning `ctx.work` or `ctx.specDir`, and calling `ctx.workDone`, is
recorded only from a module. An unvisited `steps.<id>` is `undefined`
(use `?.`).

**Scope.** `steps.*` holds the visits of the current work item only, so
`steps.<id>.visits` counts the visits per work item, e.g. review rounds
per sub-issue. A module that assigns `ctx.work` switches the scope; scopes
are never deleted.

**Elsewhere.** `branch:` in `sous.yaml` sees `issue` `{ id, title }` (the
id made branch-safe) and `slug`. The environment variable `SOUS_ROOT` sets
the project root ([chapter 12](#12-cli)).

## 8. Execution

Per visit: evaluate `with:`; for a module step run it, then its eval. For
a prompt step: run `prepare` (if any); on `never` evaluate once and route;
on `on-fail` evaluate first and route if it passes; otherwise render the
prompt, then agent → eval until the eval passes or `maxIterations` is
reached, each retry in the same agent session with the eval log. An agent
started after a failed eval without a session to resume gets the eval log
appended to its prompt. Then record the visit and take the first matching
route.

### 8.1 Agent failures

Output that does not match the schema gets one in-session correction
request. A second failure, or a failed agent process (non-zero exit, idle
timeout), is a failed iteration: it counts against `maxIterations` and is
retried also with `loop: false`.

### 8.2 Output contract

The engine appends to every prompt: answer with one `<result>{ summary,
commits, output, skills }</result>` block, `output` matching the printed
`run.output` schema. Retry and correction prompts are engine templates.

### 8.3 Sandbox and logs

`sous run` opens one sandbox per run: a worktree under
`.sandcastle/worktrees/` on the run's branch, reused when it exists. Every
agent call logs to `<logsDir>/<issue>/<spanId>-<scope>-<step>-<n>.log`;
the event log records the path.

### 8.4 Skills

Prompts point to skills by path (`{{ctx.skillsDir}}/tdd/SKILL.md`) or name
(`/tdd`). The agent must list in `skills` every skill it was pointed to or
used, as `followed`, `not-applicable` or `skipped` with a reason. The
engine compares that with the skills the prompt reaches and the reads in
the agent's tool calls; mismatches are warnings only.

## 9. Settings: `sous.yaml`

Every key has a default; an empty or missing file is valid, unknown keys
are an error.

```yaml
baseBranch: main
branch: feature/${{ issue.id }}-${{ slug }}       # JS over issue { id, title } and slug
labelPrefix: sous                                 # sous:running / sous:blocked by the run, sous:merged by the merge step
lifecycle: core                                   # core: the run claims, blocks and closes its issue; steps: steps do all writes
idleTimeoutSeconds: 1800                          # agent idle timeout
tracker: github                                   # github, beads, local, or the path of a project module
trackerOptions: {}                                # handed to the tracker; local takes { dir }
specsDir: ../specs                                # spec folders: <specsDir>/<issue>-<slug>/
flowsDir: flows
stepsDir: steps
skillsDir: skills
logsDir: logs                                     # gitignored
runsDir: runs                                     # gitignored
```

Folders are relative to `.sous/`. Models, caps and commands live in flows
and steps, not here.

## 10. Trackers

The tracker is where issues come from and where the run's state goes. The
engine talks to it through one port, `Tracker`, which steps reach as
`ctx.tracker`:

| Method | Meaning |
| --- | --- |
| `getIssue(id)` | `{ id, ref, title, body, labels, state }`. `id` is the tracker's own id; `ref` is how it writes it in text. |
| `children(parent)` | Ids of the native children, open and closed, in the order work should pick them. |
| `parent(id)` | Id of the native parent, or `undefined`. |
| `blockers(id)` | Ids of the issues still open that must close before `id` may start. |
| `claim(id, { branch })` | The run on `branch` works on the issue; idempotent for the same run. |
| `block(id, comment)` | The run stopped and needs a human. |
| `close(id, comment?)` | Close the issue. |
| `setStateLabel(id, label)` | Add `label` and remove every other label with the same `<prefix>:`. |
| `comment(id, body)` | A comment. |
| `isClosed(id)` | Whether the issue is closed. |

`claim`, `block` and `close` are the run's lifecycle
([chapter 11](#11-run-record-lifecycle-resume)); `setStateLabel` and
`comment` are what steps use for everything else, such as the
`sous:merged` label the `merge` step sets.

### Built-in trackers

**`github`** (default). Issues are read with `gh issue view`, children are
native sub-issues ordered by number, blockers are the issue numbers under
a `## Blocked by` heading in the body (as `/sous-plan` writes them).
`claim` sets `<labelPrefix>:running`, `block` sets `<labelPrefix>:blocked`
and comments, `close` closes. Labels are created on first use. `#96` and
`96` name the same issue.

**`beads`** (`bd`). `sous run <flow> <bead-id>`. Issues are read live with
`bd show --json`; an epic's beads are its children, by priority then age;
`blocks` edges are the blockers; bd's own labels are kept and a
`type:<issue_type>` label is added so `allowedLabels` match without
labelling by hand. `claim` is `bd update --claim` under an actor that names
the run's branch, so two runs never take the same bead; `close` is `bd
close`; comments go to `<runsDir>/<id>/comments.md`, since bd has none.

**`local`**. Issues as files for a repository whose tracker sous must not
touch: `trackerOptions: { dir: issues }`, one `<id>.json` per issue with
`{ id, title, body, labels, state }` and optional `children` and
`blockedBy` id lists; comments are appended to `<id>.comments.md`.
Nothing leaves the machine.

### Writing a tracker module

Any other `tracker:` value is a path relative to `.sous/`, loaded like a
step module. Its default export is a `TrackerFactory`:

```ts
// .sous/trackers/jira.ts
import type { Tracker, TrackerFactory } from "sous-factory";

const factory: TrackerFactory = (options, env) => {
  // options: `trackerOptions` from sous.yaml; env: { root, repoRoot, runsDir, labelPrefix }
  const project = String(options["project"] ?? "");
  const tracker: Tracker = {
    getIssue: async (id) => { /* GET /issue/<id> */ return { id, ref: id, title: "…", body: "…", labels: ["type:task"], state: "open" }; },
    children: async () => [],
    parent: async () => undefined,
    blockers: async () => [],
    claim: async () => undefined,
    block: async (id, comment) => { /* transition + comment */ },
    close: async (id) => { /* transition */ },
    setStateLabel: async () => undefined,
    comment: async (id, body) => { /* POST /issue/<id>/comment */ },
    isClosed: async (id) => false,
  };
  return tracker;
};

export default factory;
```

```yaml
# sous.yaml
tracker: trackers/jira.ts
trackerOptions: { project: CA }
```

`sous validate` builds the module and lists any port method it lacks.
The only parsing the engine does on issue text is none at all: what a
body means is the adapter's business, which is why the GitHub adapter
owns the `## Blocked by` rule.

## 11. Run record, lifecycle, resume

### Run record

`session.json` (schema 8) holds what a run needs to continue: `current`,
`previous`, `work`, `scopes` (the `steps.<id>` records per work item),
`workProgress`, `history`, `iterations`, `blocked`, `closed` (the
lifecycle has closed the issue of a finished run). A file of another
schema is an error, not a migration. Every checkpoint is written beside
the file and renamed into place, with the previous one kept as
`session.json.bak`, so a crash mid-write never leaves a run that cannot
continue.

`events.jsonl` is append-only observability: `run.start/end`,
`span.open/close` (one span per visit), `prepare.start/end`,
`iteration.agent.start/end`, `iteration.eval.start/end`, `output` and
`skills`. `sous status` and `sous ui` fold it into a timeline.

### Lifecycle

The lifecycle is what the engine writes to the run's issue, under
`lifecycle: core`: it claims the issue when the run starts (GitHub:
`<prefix>:running`; bd: `--claim`), marks it blocked with a comment on
`blocked`, and closes it on `done`. `lifecycle: steps` turns all of that
off and leaves the tracker to steps, which reach the same calls as
`ctx.tracker.claim`, `block` and `close`. A flow may set its own
`lifecycle:` (the `bench` flow uses `steps`, so trying it on an issue
changes nothing). Everything else on the tracker, such as the
`<prefix>:merged` label the `merge` step sets through
`ctx.tracker.setStateLabel`, is a step's doing.

### Resume and interrupts

- Running the same command again continues the run at `session.current`.
  After `blocked` the step re-enters at its **eval** with a fresh counter,
  so a manual fix in the worktree moves the run on without an agent call.
  If that eval still fails, the visit starts over as a **new attempt**:
  `prepare` runs again, the prompt is rendered again from the current
  inputs (edited spec, edited issue body), and it goes to a fresh agent
  session with `resume:` honoured as on a first visit. The old session and
  its eval log are not reused; what that session believed is what blocked
  the run. `visits` is not counted again.
  After a crash or Ctrl-C the step re-enters with the counter kept and
  continues the same attempt: eval first, then the recorded session gets
  the retry prompt.
  A prompt step without an eval passes that check only when its result
  was recorded; with neither, the agent runs again. Only a result the
  agent actually answered in this visit counts: a failed iteration records
  none, and a new visit starts without the previous visit's.
- `ctx.spec` and `ctx.work` are read again at every start, from the
  worktree and the tracker, so a spec edited on the branch or an edited
  issue reaches the next run without a restart.
- A run that reached `done` but could not close its issue (the tracker
  was down) closes it on the next `sous run` of the issue, without
  redoing any work.
- A recorded `prepare` result is reused after a crash, never run twice in
  one attempt. Re-entry after `blocked` forgets it and prepares again.
- Ctrl-C or SIGTERM stops the agent and any running command with it,
  writes `run.end` (`interrupted`), releases the lock and exits 130 / 143.
- `--restart` deletes run record, worktree and branch after a
  confirmation and starts at the entry.
- One run per issue at a time: `.sous/locks/<id>.lock` holds pid and
  issue. Runs on different issues go in parallel, each in its own worktree
  and branch; start each with its own `sous run`. A stale lock is reported
  and removed by hand. Parallel runs share the base-branch checkout that
  `merge` squashes into. In `task` and `feature`, a `merge` that finds
  base commits its branch lacks lands nothing and routes back to `sync`
  (`resync: ${{ true }}`; blocked after three such visits), so only
  synced, checked and reviewed code lands. The check and the squash run
  under `ctx.repoLock` (`.sous/locks/repo.mutex`), so two merges never
  interleave: the second waits, then sees the base move and routes back
  to `sync`. A stale `repo.mutex` from a crashed run is taken over.
- Modules should be idempotent; they run again on re-entry.

## 12. CLI

```
sous init [--starter <dir>] [--force] # copy a starter into .sous/, npm install, add the /sous-plan skill, print the checklist
sous run <flow> <issue> [--restart]   # validate, then start or continue; <issue> is the tracker's id (96, #96, a bead id)
sous status <issue>                   # session facts and the timeline
sous graph <flow>                     # Mermaid diagram from the YAML
sous validate                         # sous.yaml, every flow and step, the tracker module
sous ui [--port n]                    # the run viewer on 127.0.0.1:4680
```

The starter's `.sous/sous` wrapper runs the installed `sous` from any
directory. The project root is `SOUS_ROOT`, else the cwd when it is named
`.sous`, else `<cwd>/.sous`; the repository is its parent. Exit codes: 2
bad arguments, validation errors or an issue the flow's `allowedLabels`
refuse; 1 blocked, crashed, lock held or flow mismatch; 0 done; 130/143
interrupted.

---

# Part III: How-tos

Each recipe names the files to touch, shows the change, and ends with how
to check it. All paths are under `.sous/`.

## 13. Change the check commands

**When:** after `init`, and whenever the build changes.

**Files:** `steps/verify/eval.ts`.

```ts
export const BASE_BRANCH = "main";

export const CHECKS: readonly Check[] = [
  { command: "npm test" },
  { command: "npx tsc --noEmit", dir: "web", when: "web" },
  { command: "./gradlew build", dir: "infra", when: "infra" },
];
```

A check runs in the worktree root, or in `dir`. A check with `when` runs
only when `git diff --name-only <BASE_BRANCH>...HEAD` touches that folder,
so unrelated runs stay fast. Checks run in order and stop at the first
failure; the eval's log is a transcript (`$ cmd (exit n)` and the
output), which is what the agent gets back on a retry.

`implement`, `fix` and `sync-resolve` all use this eval (`eval:
../verify/eval.ts` in their `step.yaml`), so one list serves all three.

**Check:** `./sous validate`; `npx vitest run test/verify.test.ts`. The
starter's flow tests copy the steps with `npm test` filled in
(`test/checked-steps.ts`), so they keep passing whatever you put here.

## 14. Change the agent or model per step

**When:** a cheaper model for the smoke test, a different vendor for the
reviewer, a new model name.

**Files:** `flows/*.yaml`. Steps never name a model; the flow entry does.

```yaml
  - id: review
    uses: review
    agent: { kind: codex, model: gpt-5.5 }      # was claude; the reviewer is now a second opinion
```

`kind` is `claude` or `codex`; the CLI of that name must be on the
`PATH`. Mixing vendors per entry is the point: the step that implemented
and the step that reviews need not share a model. `maxIterations` and
`loop` can be overridden per entry too.

**Check:** `./sous validate`, then `./sous run bench <issue>` with the
model you changed.

## 15. Add a step

**When:** a new kind of work in a flow.

### A module step

`steps/changelog/step.yaml`:

```yaml
name: changelog
description: Append the work item to CHANGELOG.md and commit.
inputs:
  entry: { required: true, description: "one line for the changelog" }
run:
  module: ./run.ts
  output:
    type: object
    required: [sha]
    properties:
      sha: { type: string }
```

`steps/changelog/run.ts`:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunFn } from "sous-factory";

export default (async (ctx, inputs) => {
  const file = join(ctx.worktree, "CHANGELOG.md");
  writeFileSync(file, `- ${String(inputs["entry"])}\n${readFileSync(file, "utf8")}`);
  await ctx.git.add(ctx.worktree, ["CHANGELOG.md"]);
  const sha = await ctx.git.commit(ctx.worktree, `docs: changelog for ${ctx.work.ref}`);
  return { summary: `changelog: added ${ctx.work.ref}`, commits: [sha], output: { sha } };
}) satisfies RunFn;
```

A module gets the whole `ctx` ([chapter 7](#7-variables-and-expressions)):
the worktree, `ctx.git`, `ctx.tracker`, `ctx.exec`. It runs once per visit
and should be idempotent, since a resumed run calls it again.

### A prompt step with an eval

The starter's `tell-a-joke` is the smallest example: `prompt.md` with
`{{topic}}`, a `run.output` schema the agent must answer in, and
`eval.ts` checking what a schema cannot. The prompt names the task, the
rules (`do not touch GitHub`, `never push`) and the skill to follow by
path, `{{ctx.skillsDir}}/<skill>/SKILL.md`; the output contract is added
by the engine, so the prompt does not repeat it.

```ts
// eval.ts
import type { Envelope, EvalFn } from "sous-factory";

export default (async (_ctx, _inputs, result) => {
  if (result === undefined) return { ok: false, log: "no answer" };
  const { lines } = (result as Envelope<{ lines: string[] }>).output;
  return lines.length === 2 ? { ok: true, log: "two lines" } : { ok: false, log: `expected 2 lines, got ${lines.length}` };
}) satisfies EvalFn;
```

The log is what the agent reads on a retry: say what to fix.

### A prepare that decides when the agent runs

`sync-resolve` shows the pattern: `prepare.ts` merges the base branch
itself and returns `{ agent: "always", output }` on a conflict, `{ agent:
"on-fail", reason, output }` after a merge that moved HEAD, so the eval runs
the checks first and the agent repairs only when they fail, and `{ agent:
"never", reason, output }` when nothing came in. The eval reads
`prepared.output` to know what to check. Declare `prepare.output` in `step.yaml`;
its properties are `{{prepared.*}}` in the prompt and `prepared.output.*`
in the routes.

**Check:** a step folder needs `step.yaml` plus a `README.md` in the
starter's format (one table, one paragraph; `test/prompts.test.ts` pins
that). `./sous validate` loads every step a flow uses. Test the module
alone with `ctxOf` ([how-to 20](#20-test-steps-and-flows)).

## 16. Add or change a flow

**When:** a new kind of run, or a different order of the same steps.

### A `hotfix` flow from `task`

Copy `flows/task.yaml` to `flows/hotfix.yaml`, keep `init → implement →
review ⇄ fix → merge`, and drop `sync`/`review-full`:

```yaml
allowedLabels: [type:hotfix]
entry: init
steps:
  - id: init
    uses: init
    routes:
      - to: implement
  - id: implement
    uses: implement
    agent: { kind: claude, model: claude-opus-5-5 }
    with:
      task: ${{ ctx.work.ref + " " + ctx.work.title + "\n\n" + ctx.work.body }}
    routes:
      - to: review
  - id: review
    uses: review
    agent: { kind: claude, model: claude-opus-5-5 }
    with:
      diffRange: ${{ steps.implement.commits[0] + "^..HEAD" }}
      criteria:  ${{ ctx.work.body }}
    routes:
      - to: merge
        when: res.ok
      - to: blocked
        when: steps.review.visits >= 3
      - to: fix
        else: true
  - id: fix
    uses: fix
    agent: { kind: claude, model: claude-opus-5-5 }
    resume: ${{ steps.fix.session ?? steps.implement.session }}
    with:
      input:     ${{ steps.review.log }}
      inputKind: review
      diffRange: ${{ steps.implement.commits[0] + "^..HEAD" }}
    routes:
      - to: review
  - id: merge
    uses: merge
    with:
      baseBranch: main
      mergedLabel: sous:merged
    routes:
      - to: done
```

`sous run hotfix <id>` runs it; `sous graph hotfix` draws it.

### A step between review and merge

Add an entry and point the previous one's route at it:

```yaml
  - id: review
    routes:
      - to: changelog          # was merge
        when: res.ok
      …
  - id: changelog
    uses: changelog
    with:
      entry: ${{ ctx.work.ref + " " + ctx.work.title }}
    routes:
      - to: merge
```

### Capping a loop

A loop is a route back; `steps.<id>.visits` counts the visits of that
entry for the current work item, so a cap is a route with a condition
placed before the loop's route:

```yaml
      - to: blocked
        when: steps.review.visits >= 3
      - to: fix
        else: true
```

**Check:** `./sous validate` reports an unreachable entry, a missing
target, a route list without a fallthrough and an input not wired.
`test/flows.test.ts` walks the delivery flows over fakes; add a scenario
for a new flow the same way.

## 17. Adapt the plan phase

**When:** after `init`, and when the repository's rules or layout change.

**Files:** `prompts/plan.md` (the procedure `/sous-plan` follows; the
starter ships it for GitHub and, as `prompts/plan.beads.md`, for bd),
`skills/sous-plan/SKILL.md` and its installed copy
`.claude/skills/sous-plan/SKILL.md` (which only starts the prompt).

The prompt carries `<!-- ADAPT: … -->` notes at every repository-specific
point: the rule files to read, the `specs/` folder (the `specsDir`
setting), the type labels and what they mean for the landing commit, the
sub-issue format (`## Blocked by` is what the GitHub tracker reads as
blockers). Apply each and delete the note; `test/prompts.test.ts` only
requires the file to exist and to name the vendored skills it sends the
session to.

The spec format lives in the prompt alone. The plan session is the only
writer of `spec.md`; a run reads it from its worktree at every start into
`ctx.spec`, committed or not, and never writes one. The first run forks
the branch from the local base, so a spec pushed from another machine
reaches it only after a pull. When the plan phase wrote none, `ctx.spec`
is the issue's title and body. `review-full` judges against `ctx.spec`,
so a spec written in any format the prompt asks for reaches the reviewer
unchanged. To change a spec of a blocked run, edit it in the worktree (or
run `/sous-plan` again, which amends it there) and run the issue again.

**Check:** `npx vitest run test/prompts.test.ts`; then plan one small
issue with `/sous-plan` and read the spec it writes.

## 18. Use another tracker

**When:** issues live in bd, in files, or in a tracker the engine does
not ship.

**Files:** `sous.yaml`; for a module, a file under `.sous/`.

```yaml
tracker: beads                      # bd; run as sous run <flow> <bead-id>
```

With bd, the plan phase speaks `bd` too: move the starter's
`prompts/plan.beads.md` over `prompts/plan.md`. It creates a feature as an
epic with child beads, puts acceptance criteria into bd's own field, and
wires blockers as `blocks` dependencies instead of a `## Blocked by`
section.

```yaml
tracker: local                      # files under .sous/issues/
trackerOptions: { dir: issues }
```

```yaml
tracker: trackers/jira.ts           # a module of your own, see chapter 10
trackerOptions: { project: CA }
```

What changes with the tracker: how `ref` is written (`#96` on GitHub, the
bead id in bd), where children and blockers come from, what `claim`
means, and whether comments exist. What does not change: the flows and
steps, since they only use `ctx.tracker` and `ctx.issue`/`ctx.work`. The
`type:*` labels that `allowedLabels` match must exist on the tracker: bd
derives them from its issue type, local files list them, a module returns
whatever it decides.

**Check:** `./sous validate` builds a module tracker and names any
missing method; `./sous run bench <id>` reads an issue through it without
writing.

## 19. Run with `lifecycle: steps`

**When:** the tracker's workflow is the project's own, for example a bead
claimed and closed by your `ship` step rather than by the run.

**Files:** `sous.yaml` (`lifecycle: steps`), or one flow's `lifecycle:`;
the steps that then do the writes.

With `lifecycle: steps` the engine reads the tracker and writes nothing:
no claim at the start, no blocked comment, no close on `done`. Steps have
the same calls:

```ts
await ctx.tracker.claim(ctx.issue.id, { branch: ctx.branch });   // at the start of a workspace step
await ctx.tracker.close(ctx.issue.id, `Shipped in ${sha}`);       // in a ship step, once landed
```

The starter's `merge` step never closes the issue; under `lifecycle:
core` the run does, under `steps` a step of yours must. `close-work`
closes sub-issues itself in both modes, since that is a step's business
either way.

**Check:** the lifecycle tests in `test/flows.test.ts` assert what the
tracker saw after a walk; `fakeTracker().claims` and `.comments` show the
writes.

## 20. Test steps and flows

**When:** every change to a step or flow. No test calls a real agent.

**Files:** `test/**`; `npm test` and `npm run typecheck` in `.sous/`.

`sous-factory/testing` provides:

- `ctxOf(options)`: a `Ctx` over fakes, for a module, prepare or eval
  alone. Options: `issue`, `work`, `tracker`, `git`, `sandbox`,
  `worktree`, `workProgress`. The result exposes the fakes (`f.tracker`,
  `f.git`, `f.sandbox`) and `f.done`, every `ctx.workDone` call.
- `walk(flow, ports)`: a whole flow through the real executor, with
  `portsOf(fakeSandbox({ agent: [...], exec: {...} }), { git, tracker })`.
- `fakeGit`, `fakeTracker` (+ `issue`), `fakeSandbox`, `agentResult`,
  `envelope`, `ok`, `fail`: scripted ports and answers.

A module alone (from `test/steps/close-work.test.ts`):

```ts
import { ctxOf, fakeTracker, issue } from "sous-factory/testing";
import closeWork from "../../steps/close-work/run.js";

const f = ctxOf({ tracker: fakeTracker({ issues: [issue({ id: "14" })] }), work: { id: "14", ref: "#14", title: "Work 14", body: "" } });
await closeWork(f.ctx, { commits: ["a", "b"] });
expect(f.tracker.issues.get("14")?.state).toBe("closed");
expect(f.done).toEqual([{ work: "14", commits: ["a", "b"] }]);
```

An eval alone (from `test/bench.test.ts`): call it with a hand-written
envelope, `jokeEval(ctx, { topic: "t" }, { summary, commits: [], output })`.

A flow: `loadFlow(file, { stepsDir })`, then `walk(flow, ports)` with the
agent answers scripted in order (`agentResult(session, envelope)`) and
`exec` answers per command (`{ "npm test": ok("…") }`). The returned
session's `history` is the step sequence; `ports.tracker.comments`,
`ports.git.committed` and `ports.sandbox.execs` show the side effects.
`test/flows.test.ts` is the template.

## 21. Vendored skills

**When:** updating the skills the prompts point at, or replacing them.

**Files:** `skills/` (everything but `sous-plan/` is vendored from
[mattpocock/skills](https://github.com/mattpocock/skills), MIT),
`skills/VENDORED.md` (source commit and the table of who uses what).

The prompts reach a skill by path, `{{ctx.skillsDir}}/<skill>/SKILL.md`,
and `test/prompts.test.ts` pins which prompt points at which skill and
which files `plan.md` sends the session to. To update: copy the upstream
folders over the vendored ones verbatim, note the commit in
`VENDORED.md`. To replace one: write the skill in its folder, keep the
file name `SKILL.md`, and adjust the prompt's overrides where it says
what to skip or change in the skill.

**Check:** `npx vitest run test/prompts.test.ts`.

## 22. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `sous run: #12 has none of the labels flow "task" accepts` | The flow's `allowedLabels` refuse the issue. Label it, or run the flow it is meant for. |
| `validate: … input "x" has no placeholder in the prompt` | Every declared input must be used; add `{{x}}` to the prompt or mark the input `prompt: false` when prepare or eval reads it. |
| `validate: route to "…" names no step id` / `the last route must be an else` | Routes need an existing target and a fallthrough; see [chapter 6](#6-flows). |
| `tracker: … the tracker lacks children, parent` | The tracker module's default export is missing port methods; [chapter 10](#10-trackers) lists them. |
| The run stops `blocked` right after `implement` | The verify checks failed three times; the issue comment carries the last log. Fix the worktree by hand and run the same command; it re-enters at the eval. |
| The run stops `blocked` at `review` and you disagree with a finding | Edit the spec in the worktree (`specs/<id>-*/spec.md` on the branch) or the issue body, then run the same command. Both are read again at start, the recorded findings fail the eval, and a fresh reviewer judges against the edited text; the old reviewer session is not resumed. |
| `WARN: no checks configured` in every eval log | `CHECKS` in `steps/verify/eval.ts` is empty; [how-to 13](#13-change-the-check-commands). |
| `another sous run holds .sous/locks/<id>.lock` | That issue is already running. If the pid is dead, the message says `stale`: delete the file. |
| `session.json: /schemaVersion must be equal to constant` | A run folder from an older engine. Delete `runs/<id>/` (and the worktree) or `--restart`. |
| `sous run: #12 was started with flow "feature"; run that flow or pass --restart` | A run record exists for another flow; continue that flow or restart. |
| The UI shows a step as "Crashed (no end recorded)" | The process died without writing `run.end`. Run the same command; it re-enters at the open step. |
| The agent's answer "did not match the schema" twice | The `run.output` schema and the prompt disagree, or the model cannot produce it; compare the printed contract in the agent log with the schema. |
