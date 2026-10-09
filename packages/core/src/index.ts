/**
 * `sous-factory` for step authors: the types a step module, prepare or eval is
 * written against, plus the loaders and helpers a project's own tests use.
 * Nothing outside this entry and `sous-factory/testing` is meant to be imported.
 */
import type { Git } from "./ports/git.js";
import type { Tracker } from "./ports/tracker.js";
import type { Event } from "./session/events.js";
import type { SkillReport } from "./skills.js";

export type { Git, Tracker, Event, SkillReport };

export { loadFlow, type LoadedEntry, type Flow, type FlowEntry, type FlowFile, type Route } from "./config/flow.js";
export { loadStep, type Step, type StepInput } from "./config/step.js";
export { validateProject, type ProjectReport, type ValidationError } from "./config/validate.js";
export { renderGraph } from "./commands/graph.js";
export { SousError } from "./exec/errors.js";
export { isOutput } from "./session/events.js";
export type { TrackerEnv, TrackerFactory } from "./tracker.js";
export { existingSpecDirName, specDirName } from "./session/paths.js";

/**
 * What a step hands back. An agent writes it as its final answer; a `run`
 * module may return one. `output` must match the step's `run.output` schema;
 * `commits` lists the shas the step created, oldest first.
 */
export type Envelope<Output = unknown> = { summary: string; commits: string[]; output: Output; skills?: SkillReport[] };

/** The verdict of an eval. `log` is what a retrying agent and a human see, so make it say what to fix. */
export type EvalResult = { ok: boolean; log: string };

/** What a flow expression sees as `steps.<id>`: the latest visit of that entry for the current work item. */
export type StepRecord = {
  visits: number;
  ok: boolean;
  log: string;
  output: unknown;
  commits: string[];
  /** The agent session, so a later entry can continue it with `resume:`. */
  session?: string;
  /** What the step's `prepare` returned on this visit. */
  prepared?: Prepared;
};

/** An entry not yet visited for this work item is `undefined`; read with `?.`. */
export type StepsScope = Record<string, StepRecord | undefined>;

/**
 * The tracker issue the run was started for. `id` is the tracker's own id
 * (`96` on GitHub, `proj-a.1` in bd) and names the run everywhere; `ref` is
 * how the tracker writes it in text (`#96`), for messages and commits.
 */
export type Issue = { id: string; ref: string; title: string; body: string; labels: string[] };

/** The item being worked on: the run's issue, or a sub-issue a step put on the bench. */
export type Work = { id: string; ref: string; title: string; body: string };

export type ExecResult = { code: number; stdout: string; stderr: string };

/** `cwd` defaults to the worktree root. */
export type ExecOptions = { cwd?: string; env?: Record<string, string> };

/** Progress of one work item in the run, as recorded by `ctx.workDone`. */
export type WorkRecord = { state: "open" | "done"; commits: string[] };

/**
 * Everything a step can know about and do in the run. Prompts reach a few
 * fields as `{{ctx.*}}`; modules, prepares and evals get the whole object.
 *
 * Writes (`work`, `specDir`, `workDone`) take effect only from a `run`
 * module or a `prepare`; elsewhere they are ignored or throw.
 */
export type Ctx = {
  readonly issue: Issue;
  /** Name of the running flow. */
  readonly flow: string;
  /**
   * The item being worked on. Assign another item to start working on it:
   * `steps.*` then shows that item's visits, so loops count per item.
   */
  work: Work;
  readonly branch: string;
  /** Absolute path of the worktree the run works in. */
  readonly worktree: string;
  /** The main repository checkout, for work that must happen outside the worktree, such as landing the branch. */
  readonly repoRoot: string;
  /** Spec folder, relative to the repository root. Assign it to point later steps at another folder. */
  specDir: string;
  /** Absolute path of the project's skills folder, for pointing an agent at a skill. */
  readonly skillsDir: string;
  /** The entry visited before this one; `null` at the start. */
  readonly previous: string | null;
  /** Which attempt of the visit an eval judges; 0 when a resumed run re-checks earlier work. Absent outside evals and routes. */
  readonly iteration?: number;
  readonly workProgress: Readonly<Record<string, WorkRecord>>;
  /** Records the current work item as done with its commits. */
  workDone(commits: readonly string[]): void;
  /** The given worktree files, each as `### <path>` and its content; directories are expanded. Handy as prompt input. */
  repoFiles(paths: readonly string[]): string;
  /** A worktree file; a relative path is read from the worktree root. */
  readFile(path: string): string;
  /**
   * Runs a shell command in the worktree. A failing command is a result,
   * not an exception, so check `code`; only an interrupted run throws.
   */
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  readonly git: Git;
  readonly tracker: Tracker;
  /** The run's event log so far, for steps that report on earlier visits. */
  readonly events: { readAll(): Promise<Event[]> };
  /** Close it once nothing else will run in the worktree, before removing it. */
  readonly sandbox: { close(): Promise<void> };
};

/** The entry's resolved `with:` values, keyed by input name. */
export type Inputs = Record<string, unknown>;

/**
 * Default export of a `run.module`: the step's deterministic work. Return an
 * envelope to expose `output` to evals and routes, or nothing.
 */
export type RunFn = (ctx: Ctx, inputs: Inputs) => Promise<Envelope | void>;

/**
 * What a `prepare` decides. `agent: "skip"` means the work is already done
 * or not needed: the eval runs without an agent result. `output` must match
 * the step's `prepare.output` schema; its fields fill `{{prepared.*}}` in the
 * prompt. `reason` is shown when the agent is skipped.
 */
export type Prepared<Output = unknown> = { agent: "run" | "skip"; reason?: string; output: Output };

/**
 * Default export of a `prepare` module: deterministic work before the agent,
 * once per visit, deciding whether the agent is needed at all. It may write
 * to `ctx` like a `run` module. A resumed run reuses its earlier result.
 */
export type PrepareFn<Output = unknown> = (ctx: Ctx, inputs: Inputs) => Promise<Prepared<Output>>;

/**
 * Default export of an `eval` module: judges the visit. A failure sends
 * `log` back to the agent for another attempt, or lets the flow route on it.
 * `result` is missing when there was no agent or module result to judge;
 * `prepared` is the visit's prepare result, if the step has one.
 */
export type EvalFn = (ctx: Ctx, inputs: Inputs, result?: Envelope, prepared?: Prepared) => Promise<EvalResult>;
