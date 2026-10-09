# sous

A local software factory: it runs an issue through a **flow** of
**steps** in a git worktree and records every visit. A step is an agent
prompt or a TypeScript module; a flow wires steps into a graph with
conditional routes. The shell is deterministic, the agent only works in the
worktree and answers with structured JSON.

- **Engine** (`packages/core`, npm package `sous-factory`): the executor, the
  CLI and the infrastructure (git, tracker, sandbox, run record). It ships no
  steps. `packages/ui` is `sous ui`, a live run viewer
  ([README](packages/ui/README.md)), bundled into the package.
- **Starter** (`starters/github`): `sous.yaml`, `flows/`, `steps/`, `skills/`,
  `prompts/` for a GitHub-tracked repository. `npx sous init` copies it into
  a repository's `.sous/`; the project owns and adapts it from then on. Each
  step has a `README.md`; the flows describe themselves in their header
  comments.

## Quick start

Once per machine: Node 22, `gh auth login`, and the `claude` or `codex` CLI
on the `PATH`.

Once per repository, from its root:

```
npm install -D sous-factory      # or in a scratch folder: npx sous-factory init
npx sous init                    # copies the starter into .sous/, installs it,
                                 # puts /sous-plan under .claude/skills/,
                                 # and prints what is left to adapt by hand
```

`init` ends with a checklist: the check commands in
`.sous/steps/verify/eval.ts`, `sous.yaml`, the flows' models and labels,
and the `ADAPT` notes in `.sous/prompts/plan.md`. To be walked through all
of it in Claude Code, add this repository's `skills/sous-setup` to your
project (`cp -r <clone of this repo>/skills/sous-setup .claude/skills/`, or
download that folder from GitHub) and run `/sous-setup`; it also does the
install and init when `.sous/` is missing.

**1. A module step**, `steps/greet/`:

```yaml
# step.yaml
name: greet
description: Greet the issue by its title.
inputs:
  name: { description: "who to greet" }
run:
  module: ./run.ts
```

```ts
// run.ts
import type { RunFn } from "sous-factory";

export default (async (_ctx, inputs) => {
  const greeting = `Hello, ${String(inputs["name"])}!`;
  return { summary: greeting, commits: [], output: { greeting } };
}) satisfies RunFn;
```

**2. A prompt step with an eval**, `steps/poem/`:

```yaml
# step.yaml
name: poem
description: Write a two-line poem about a topic.
inputs:
  topic: { description: "what the poem is about" }
run:
  prompt: prompt.md
  output:
    type: object
    required: [lines]
    properties:
      lines: { type: array, items: { type: string } }
eval: ./eval.ts
maxIterations: 2
```

```md
<!-- prompt.md -->
Write a two-line poem about {{topic}}. Do not change any file.
```

```ts
// eval.ts
import type { EvalFn } from "sous-factory";

export default (async (_ctx, _inputs, result) => {
  const { lines } = result?.output as { lines: string[] };
  return lines.length === 2 ? { ok: true, log: "two lines" } : { ok: false, log: `expected 2 lines, got ${lines.length}` };
}) satisfies EvalFn;
```

**3. A flow**, `flows/hello.yaml`:

```yaml
entry: greet
steps:
  - id: greet
    uses: greet
    with:
      name: ${{ ctx.issue.title }}
    routes:
      - to: poem

  - id: poem
    uses: poem
    agent: { kind: claude, model: claude-opus-5-5 }
    with:
      topic: ${{ steps.greet.output.greeting }}
    routes:
      - to: done
```

**4. Run it** on any issue, by the id the tracker uses (`96` or `#96` on GitHub, a bead id in bd):

```
.sous/sous validate          # every flow and step
.sous/sous graph hello       # the flow as a Mermaid diagram
.sous/sous run hello 42      # validate, open a worktree, run
.sous/sous status 42         # session and timeline
.sous/sous ui                # the same, live in the browser
```

A failed eval sends its log back to the agent in the same session, up to
`maxIterations`; after that the run stops `blocked`, and the same `run`
command continues it.

---

## 1. Concepts

| Term | Meaning |
| --- | --- |
| Step | A folder `<stepsDir>/<name>/` with `step.yaml`: declared inputs, a prompt or a module, an optional `prepare` and `eval`. A step never names another step. |
| Flow | `<flowsDir>/<name>.yaml`: an `entry` and a list of entries, each using a step with its own `with:`, `agent` and `routes`. The same step may be used by several entries. |
| Visit | One pass through an entry. Loops are routes back to an earlier entry. |
| Envelope | What a step returns: `{ summary, commits, output, skills? }`. `output` follows the step's `run.output` schema. |
| Work item | The item on the bench (`ctx.work`): the run's issue, or a sub-issue a module put there. `steps.<id>` is scoped by it. |
| Run record | `<runsDir>/<issue id>/session.json` (control state) and `events.jsonl` (what happened). |

Core never imports the project: steps reach core through `import … from
"sous-factory"`, flows through YAML. A project's own modules (steps, a
tracker) are loaded with `tsx`, so they need no build step. Core itself is
published compiled (`npm run build`: `packages/core/dist` with types, the
UI's client and server prebuilt under `dist/ui`, the starter under
`starter/`); this repository runs core from its TypeScript source through the
`sous-source` export condition, which the tsconfigs and vitest configs set.

**From idea to merge.** Plan with a human, then run without one:

1. `/sous-plan [#id]` in Claude Code: an interactive session that clarifies
   the idea, writes `specs/<n>-<slug>/spec.md`, and for a feature files
   sub-issues with acceptance criteria and blockers. Without an id it
   creates the issue first. Issues are filed as you approve them; the spec
   is committed and pushed only after an explicit GO.
2. `.sous/sous run <flow> <n>`: the factory runs the issue through
   `<flow>`. A flow's `allowedLabels` (§3) refuses issues it is not meant
   for. Watch it with `sous status <n>` or `sous ui`.

## 2. Steps

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
  `run.module`: deterministic, runs once. No `run` but an `eval`: eval-only,
  the eval is the work. Neither is an error.
- **Prompt.** Markdown with `{{input}}`, `{{ctx.*}}` and `{{prepared.*}}`
  placeholders (§4). Every `{{input}}` must be declared and every input
  used. An unwired optional input and a
  missing prepared value render empty. `` !`cmd` `` is rejected.
- **Eval.** Judges the visit: `{ ok, log }`. A failed eval retries the agent
  in its session with the log (§5); without an eval a step always passes.
  `{ shell }` is ok iff the command exits 0, log = stdout + stderr.
- **Prepare.** Runs once per visit before the prompt is rendered and decides
  whether the agent runs: `{ agent: "run" | "skip", reason?, output }`.
  `output` fills `{{prepared.*}}` and reaches the eval and the routes as
  `prepared`. On `skip` the eval runs once without a result and the visit
  routes on it.

### 2.1 Signatures

```ts
import type { RunFn, PrepareFn, EvalFn } from "sous-factory";

type RunFn     = (ctx: Ctx, inputs: Inputs) => Promise<Envelope | void>;
type PrepareFn = (ctx: Ctx, inputs: Inputs) => Promise<{ agent: "run" | "skip"; reason?: string; output: unknown }>;
type EvalFn    = (ctx: Ctx, inputs: Inputs, result?: Envelope, prepared?: Prepared) => Promise<{ ok: boolean; log: string }>;
```

`inputs` are the resolved `with:` values. `result` is absent after a module
that returned nothing, an eval-only step and a skipped agent. A module and a
prepare may assign `ctx.work` (a new work item, a new scope), assign
`ctx.specDir`, and call `ctx.workDone(commits)`; core records them after the
call.

### 2.2 `sous-factory` exports

- `sous-factory`: the types above, `Ctx`, `Envelope<Output>`, `Prepared<Output>`,
  `EvalResult`, `Inputs`, `Issue`, `Work`, `Git`, `Tracker`, `TrackerFactory`, `Event`;
  `SousError`; `loadFlow`, `loadStep`, `validateProject`, `renderGraph`.
- `sous-factory/testing`: in-memory fakes and the harness (§10).

## 3. Flows

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

### 3.1 Entry fields

| Field | Meaning |
| --- | --- |
| `id` | Unique in the flow; the key of `steps.<id>`. |
| `uses` | A step folder name, never a path. |
| `agent` | Required for an agentic step, rejected otherwise. Step files name no model. |
| `with` | Input values. `${{ expr }}` as the whole value keeps its type; inside text it is stringified (objects as JSON). Required inputs must be present, unknown ones are an error. |
| `resume` | Expression yielding an agent session id: the first iteration continues that session. |
| `routes` | Ordered `{ to, when }`; first match wins. The last route must be unconditional (no `when`, or `else: true`), unless every `when` is `true`. Quote conditions containing `: `, `[` or `#`. |

### 3.2 `done` and `blocked`

Reserved targets. `done` ends the run. `blocked` stops it for a human: the
step stays current, the lifecycle marks the issue blocked with a comment, the worktree
is kept. An agentic step that exhausts `maxIterations` goes to `blocked`
without consulting its routes.

### 3.3 Validation

`sous validate` (and every `run`) checks `sous.yaml` and every flow: ids
unique, every target exists, every entry reachable and `done` reachable,
steps load, schemas are valid JSON Schema, placeholders match inputs,
`{{prepared.x}}` names a `prepare.output` property, `with` and `agent` fit
the step, every expression compiles, and the routes end in a fallthrough.
Every error is listed as `<file> [<id>]: <rule>: <message>`; exit code 2.

## 4. Variables

What each part of a step, and each flow expression, can use. **Prompt**
means a `{{…}}` placeholder; anything else reaches a prompt only through an
input wired in `with:`. **Modules** are `run.module` and `prepare`; both get
`(ctx, inputs)`. **Eval** gets `(ctx, inputs, result, prepared)`. **Flow**
means `with:` / `resume:` (`${{ }}`) and `when:`; these are plain JavaScript,
compiled once, not sandboxed.

| Variable | Content | Prompt | Modules | Eval | Flow |
| --- | --- | --- | --- | --- | --- |
| inputs | the entry's `with:` values | `{{name}}` | `inputs` | `inputs` | — |
| `ctx.issue` | run target `{ id, ref, title, body, labels }`; `id` is the tracker's own, `ref` how it writes it in text (`#96`) | `{{ctx.issue.id}}`, `{{ctx.issue.ref}}` | ✓ | ✓ | ✓ |
| `ctx.work` | work item `{ id, ref, title, body }` | `{{ctx.work.id}}`, `{{ctx.work.ref}}` | ✓ assignable | ✓ | ✓ |
| `ctx.worktree` | absolute worktree path | `{{ctx.worktree}}` | ✓ | ✓ | ✓ |
| `ctx.specDir` | spec folder, relative to the repository | `{{ctx.specDir}}` | ✓ assignable | ✓ | ✓ |
| `ctx.skillsDir` | absolute `skills/` path | `{{ctx.skillsDir}}` | ✓ | ✓ | ✓ |
| `ctx.flow`, `ctx.branch`, `ctx.previous` | flow name, run branch, entry visited before | — | ✓ | ✓ | ✓ |
| `ctx.iteration` | iteration of the visit (0: re-entry eval) | — | — | ✓ | `when` |
| `ctx.readFile(path)`, `ctx.repoFiles(paths)` | worktree files; `repoFiles` gives `### <path>` + content | — | ✓ | ✓ | ✓ |
| `ctx.exec(cmd, opts?)` | `{ code, stdout, stderr }` in the worktree; never throws | — | ✓ | ✓ | — |
| `ctx.workDone(commits)` | marks the work item done in the run record | — | ✓ | — | — |
| `ctx.git`, `ctx.tracker` | git and issue-tracker ports | — | ✓ | ✓ | — |
| `ctx.repoRoot`, `ctx.workProgress`, `ctx.events`, `ctx.sandbox` | checkout, progress per work item, event log, sandbox | — | ✓ | ✓ | — |
| `prepared` | `{ agent, reason?, output }` of the visit's prepare | `{{prepared.<field>}}` of `output` | returned by prepare | 4th argument | `when` |
| `result` | the visit's envelope `{ summary, commits, output }` | — | returned by run | 3rd argument | `when` |
| `res` | `{ ok, log }` of the visit's final eval | — | — | returned | `when` |
| `steps.<id>` | latest visit in this scope: `{ visits, ok, log, output, commits, session, prepared }` | — | — | — | ✓ |

Assigning `ctx.work` or `ctx.specDir`, and calling `ctx.workDone`, is
recorded only from a module. An unvisited `steps.<id>` is `undefined` (use
`?.`).

**Scope.** `steps.*` holds the visits of the current work item only, so
`steps.<id>.visits` counts the visits per work item, e.g. review rounds per
sub-issue. A module that
assigns `ctx.work` switches the scope; scopes are never deleted.

**Elsewhere.** `branch:` in `sous.yaml` sees `issue` `{ id, title }` (the id made branch-safe) and
`slug`. The environment variable `SOUS_ROOT` sets the project root (§8).

## 5. Execution

Per visit: evaluate `with:`; for a module step run it, then its eval. For a
prompt step: run `prepare` (if any); on `skip` evaluate once and route;
otherwise render the prompt, then agent → eval until the eval passes or
`maxIterations` is reached, each retry in the same agent session with the
eval log. Then record the visit and take the first matching route.

### 5.1 Agent failures

Output that does not match the schema gets one in-session correction
request. A second failure, or a failed agent process (non-zero exit, idle
timeout), is a failed iteration: it counts against `maxIterations` and is
retried also with `loop: false`.

### 5.2 Output contract

Core appends to every prompt: answer with one `<result>{ summary, commits,
output, skills }</result>` block, `output` matching the printed `run.output`
schema. Retry and correction prompts are core templates.

### 5.3 Sandbox and logs

`sous run` opens one sandbox per run: a worktree under
`.sandcastle/worktrees/` on the run's branch, reused when it exists. Every
agent call logs to `<logsDir>/<issue>/<spanId>-<scope>-<step>-<n>.log`; the
event log records the path.

### 5.4 Skills

Prompts point to skills by path (`{{ctx.skillsDir}}/tdd/SKILL.md`) or name
(`/tdd`). The agent must list in `skills` every skill it was pointed to or
used, as `followed`, `not-applicable` or `skipped` with a reason. Core
compares that with the skills the prompt reaches and the reads in the
agent's tool calls; mismatches are warnings only.

## 6. Settings: `sous.yaml`

Every key has a default; an empty or missing file is valid, unknown keys are
an error.

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

Issues come from GitHub by default. `tracker: local` reads them from
`<trackerOptions.dir>/<id>.json` (`{ id, title, body, labels, state }`,
comments appended to `<id>.comments.md`); `tracker: beads` reads them live from
bd (`sous run <flow> <bead-id>`).
Local issues list `children` and `blockedBy` ids in the file; bd children
are an epic's beads by priority, its blockers the `blocks` edges. Any other value is a
module path relative to `.sous/`, loaded like a step module: its default
export is a `TrackerFactory`, `(trackerOptions, { root, repoRoot, runsDir, labelPrefix })
=> Tracker`, and `sous validate` builds it to check the port is complete.

## 7. Run record and lifecycle

`session.json` (schema 6) holds what a run needs to continue: `current`,
`previous`, `work`, `scopes` (the `steps.<id>` records per work item),
`workProgress`, `history`, `iterations`, `blocked`. A file of another
schema is an error, not a migration.

`events.jsonl` is append-only observability: `run.start/end`,
`span.open/close` (one span per visit), `prepare.start/end`,
`iteration.agent.start/end`, `iteration.eval.start/end`, `output` and
`skills`. `sous status` and `sous ui` fold it into a timeline.

The lifecycle is what the core writes to the run's issue, under
`lifecycle: core`: it claims the issue when the run starts (GitHub:
`<prefix>:running`; bd: `--claim` as `sous:<branch>`), marks it blocked with
a comment on `blocked`, and closes it on `done`. `lifecycle: steps` turns all
of that off and leaves the tracker to steps, which reach the same calls as
`ctx.tracker.claim`, `block` and `close`. A flow may set its own `lifecycle:`
(the `bench` flow uses `steps`, so trying it on an issue changes nothing).
Everything else on the tracker, such as the `<prefix>:merged` label the
`merge` step sets through `ctx.tracker.setStateLabel`, is a step's doing.

## 8. CLI

```
sous init [--starter <dir>] [--force] # copy a starter into .sous/, npm install, add the /sous-plan skill, print the checklist
sous run <flow> <issue> [--restart]   # validate, then start or continue; <issue> may be a bead id
sous status <issue>                   # session facts and the timeline
sous graph <flow>                     # Mermaid diagram from the YAML
sous validate                         # sous.yaml, every flow and step
sous ui [--port n]                    # the run viewer
```

The starter's `.sous/sous` wrapper runs the installed `sous` from any
directory. The project root is
`SOUS_ROOT`, else the cwd when it is named `.sous`, else `<cwd>/.sous`; the
repository is its parent. Exit codes: 2 bad arguments, validation errors
or an issue the flow's `allowedLabels` refuse;
1 blocked, crashed, lock held or flow mismatch; 0 done; 130/143 interrupted.

## 9. Resume and interrupts

- Running the same command again continues the run at `session.current`.
  After `blocked` the step re-enters at its **eval** with a fresh counter,
  so a manual fix in the worktree moves the run on without an agent call.
  After a crash or Ctrl-C it re-enters the same way with the counter kept.
- A recorded `prepare` result is reused on re-entry, never run twice in
  one visit.
- Ctrl-C or SIGTERM stops the agent and any running command with it, writes
  `run.end` (`interrupted`), releases the lock and exits 130 / 143.
- `--restart` deletes run record, worktree and branch after a confirmation
  and starts at the entry.
- One run at a time: `.sous/.lock` holds pid and issue. A stale lock is
  reported and removed by hand.
- Modules should be idempotent; they run again on re-entry.

## 10. Testing steps and flows

`npm test` and `npm run typecheck` in `.sous/` cover a project; in this
repository they cover core and the UI, `npm run starter:test` the starter.
No test calls a real agent. `sous-factory/testing` provides:

- `ctxOf(options)`: a `Ctx` over fakes, for a module, prepare or eval alone.
- `walk(flow, ports)`: a whole flow through the real executor, with
  `portsOf(fakeSandbox({ agent: [...], exec: {...} }), { git, tracker })`.
- `fakeGit`, `fakeTracker`, `fakeSandbox`, `agentResult`, `envelope`, `ok`,
  `fail`: scripted ports and answers.

See `starters/github/test/` for project examples and `packages/core/test/` for core.
