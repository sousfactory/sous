/**
 * `sous run <flow> <issue> [--restart]`: everything around the executor
 * (validation, lock, session, sandbox, run segment, signals). Re-entry after
 * `blocked` and resume after a crash need nothing here; the executor reads
 * both from the session.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { createFileEventLog } from "../adapters/eventlog.js";
import { exec } from "../adapters/exec.js";
import { worktreePathFor, type OpenSandbox } from "../adapters/sandcastle.js";
import { acceptsLabels, BLOCKED, DONE, loadFlow, type Flow } from "../config/flow.js";
import { messageOf } from "../config/schema.js";
import { loadSettings, projectDirs, SETTINGS_FILE } from "../config/settings.js";
import { listFlows, validateProject } from "../config/validate.js";
import { InterruptedError } from "../exec/errors.js";
import { runFlow, type Logger } from "../exec/executor.js";
import type { Session } from "../exec/scope.js";
import type { Issue, Work } from "../index.js";
import { createLifecycle } from "../lifecycle.js";
import type { Git } from "../ports/git.js";
import type { EventLog } from "../ports/eventlog.js";
import type { Tracker } from "../ports/tracker.js";
import type { RunOutcome } from "../session/events.js";
import { branchName, eventsFile, existingSpecDirName, runDir, sessionFile, specDirName } from "../session/paths.js";
import { filePersist, loadSession } from "../session/store.js";
import { createSession } from "../session/update.js";
import { acquireLock, describeLock, isProcessAlive, lockPath } from "./lock.js";
import { formatError } from "./validate.js";

/** `issue` is the tracker's id as typed, minus a leading `#`, so `sous run task #96` works. */
export type RunArgs = { flow: string; issue: string; restart: boolean };

export type RunDeps = {
  /** The project root (`.sous/`). */
  root: string;
  /** The repository checkout, on the base branch. */
  repoRoot: string;
  git: Git;
  tracker: Tracker;
  openSandbox: OpenSandbox;
  /** Asks the human a yes/no question; `--restart` is confirmed through it. */
  confirm: (question: string) => Promise<boolean>;
  out: (line: string) => void;
  err: (line: string) => void;
  clock?: () => Date;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  host?: string;
  /** Short sha of the repository checkout; `unknown` when it cannot be read. */
  sha?: () => Promise<string>;
  newId?: () => string;
  /** Installs `handler` for SIGINT/SIGTERM and returns the uninstaller; injectable so tests do not exit. */
  onSignal?: (handler: SignalHandler) => () => void;
  /** Returns the uninstaller. Drops the lock on any way out the run's own code does not see. */
  onExit?: (listener: () => void) => () => void;
};

export const USAGE = "usage: sous run <flow> <issue> [--restart]";

export const parseRunArgs = (args: readonly string[]): RunArgs | { error: string } => {
  const flags = args.filter((a) => a.startsWith("--"));
  const positional = args.filter((a) => !a.startsWith("--"));
  const unknown = flags.filter((f) => f !== "--restart");
  if (unknown.length > 0) return { error: `unknown option ${unknown.join(", ")}\n${USAGE}` };
  const [flow, issueArg, ...rest] = positional;
  if (flow === undefined || issueArg === undefined || rest.length > 0) return { error: USAGE };
  const issue = issueArg.replace(/^#/, "");
  if (issue === "") return { error: USAGE };
  return { flow, issue, restart: flags.includes("--restart") };
};

export const gitShortSha = (repoRoot: string) => async (): Promise<string> => {
  const result = await exec("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot });
  return result.code === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : "unknown";
};

const randomId = (): string => randomBytes(4).toString("hex");

export type StopSignal = "SIGINT" | "SIGTERM";

/** The shell convention, 128 + signal number. */
export const SIGNAL_EXIT_CODES: Record<StopSignal, number> = { SIGINT: 130, SIGTERM: 143 };

/** How long an interrupted run may take to wind down before the process exits anyway. */
export const SIGNAL_GRACE_MS = 5000;

/** Everything an interrupt has to do; the process exits once it settles, or after the grace period. */
export type SignalHandler = (signal: StopSignal) => Promise<void>;

export type ProcessSignalOptions = {
  exit?: (code: number) => void;
  graceMs?: number;
};

const STOP_SIGNALS = Object.keys(SIGNAL_EXIT_CODES) as StopSignal[];

/**
 * `handler` runs once, then the process exits (after `graceMs` at the
 * latest); a second signal exits at once.
 *
 * sous owns both signals while this is installed: every other listener,
 * present or added later, is set aside until the uninstaller puts it back.
 * Reason: sandcastle's shutdown registry, attached when the sandbox opens,
 * calls `process.exit(1)` synchronously on either signal, which ended the
 * process before the handler's first await. Moving a late listener in a
 * microtask is safe because signals arrive from the event loop, never in
 * between.
 */
export const onProcessSignal = (handler: SignalHandler, options: ProcessSignalOptions = {}): (() => void) => {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const graceMs = options.graceMs ?? SIGNAL_GRACE_MS;
  const setAside: [StopSignal, (...args: unknown[]) => void][] = [];
  const takeOver = (signal: StopSignal, other: (...args: unknown[]) => void) => {
    if (other === listener || !process.listeners(signal).includes(other)) return;
    process.off(signal, other);
    setAside.push([signal, other]);
  };
  let handling = false;
  const listener = (signal: StopSignal) => {
    const code = SIGNAL_EXIT_CODES[signal];
    if (handling) return exit(code);
    handling = true;
    let exited = false;
    const exitOnce = () => {
      if (exited) return;
      exited = true;
      clearTimeout(grace);
      exit(code);
    };
    const grace = setTimeout(exitOnce, graceMs);
    void Promise.resolve()
      .then(() => handler(signal))
      .catch(() => undefined)
      .finally(exitOnce);
  };
  const onNewListener = (event: string | symbol, other: (...args: unknown[]) => void) => {
    if (event === "SIGINT" || event === "SIGTERM") queueMicrotask(() => takeOver(event, other));
  };
  for (const signal of STOP_SIGNALS) {
    for (const other of process.listeners(signal)) takeOver(signal, other as (...args: unknown[]) => void);
    process.on(signal, listener);
  }
  process.on("newListener", onNewListener);
  return () => {
    process.off("newListener", onNewListener);
    for (const signal of STOP_SIGNALS) process.off(signal, listener);
    for (const [signal, other] of setAside.splice(0)) if (!process.listeners(signal).includes(other)) process.on(signal, other);
  };
};

const onProcessExit = (listener: () => void): (() => void) => {
  process.once("exit", listener);
  return () => process.off("exit", listener);
};

export const confirmOnStdin = (question: string): Promise<boolean> =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });

export { existingSpecDirName };

const specEntries = (specsDir: string): Promise<string[]> => readdir(specsDir).catch(() => [] as string[]);

/** Undefined for a fresh start at the flow's entry. */
const resumePoint = (session: Session, flow: Flow): { step: string; iteration: number } | undefined =>
  session.current === flow.entry && session.history.length === 0 ? undefined : { step: session.current, iteration: session.iterations[session.current] ?? 0 };

/** `ctx.work`: the run's issue itself, or the sub-issue on the bench fetched from the tracker. */
const workOf = async (tracker: Tracker, issue: Issue, work: string): Promise<Work> => {
  const { id, ref, title, body } = work === issue.id ? issue : await tracker.getIssue(work);
  return { id, ref, title, body };
};

export const runCommand = async (args: readonly string[], deps: RunDeps): Promise<number> => {
  const parsed = parseRunArgs(args);
  if ("error" in parsed) {
    deps.err(parsed.error);
    return 2;
  }
  const { root, repoRoot, git, tracker, out, err } = deps;
  const clock = deps.clock ?? (() => new Date());
  const log: Logger = { info: out, warn: err };

  // Nothing starts on a broken project.
  const report = validateProject(root);
  for (const e of report.errors) err(formatError(root, e));
  if (report.errors.length > 0) {
    err(`sous run: ${report.errors.length} validation error(s)`);
    return 2;
  }
  const settings = loadSettings(join(root, SETTINGS_FILE));
  const dirs = projectDirs(root, settings);
  const file = join(dirs.flows, `${parsed.flow}.yaml`);
  if (!existsSync(file)) {
    const known = listFlows(dirs.flows).map((f) => f.replace(/^.*\/|\.ya?ml$/g, ""));
    err(`sous run: unknown flow "${parsed.flow}" (known: ${known.length > 0 ? known.join(", ") : "none"})`);
    return 2;
  }
  const flow = loadFlow(file, { stepsDir: dirs.steps });

  const lock = await acquireLock(lockPath(root), { pid: deps.pid ?? process.pid, issue: parsed.issue }, deps.isAlive ?? isProcessAlive);
  if (!lock.ok) {
    err(`sous run: ${describeLock(lockPath(root), lock.status)}`);
    return 1;
  }
  // Aborting terminates the agent process and any command in flight.
  const abort = new AbortController();
  // Whatever ends the process, neither the lock nor the agent outlives it.
  const dropExitListener = (deps.onExit ?? onProcessExit)(() => {
    abort.abort(new InterruptedError("the sous process is exiting"));
    lock.releaseSync();
  });

  // Set once `run.start` is on the way. Closed once: the signal handler and
  // the run's own ends may both get here.
  let segment: { events: EventLog; runId: string; started: Promise<void> } | undefined;
  let ended = false;
  const endRun = async (outcome: RunOutcome, error?: string): Promise<void> => {
    if (segment === undefined || ended) return;
    ended = true;
    try {
      await segment.started;
      await segment.events.append({ type: "run.end", at: clock().toISOString(), runId: segment.runId, outcome, ...(error !== undefined ? { error } : {}) });
    } catch (error: unknown) {
      err(`sous run: could not record the ${outcome} run: ${messageOf(error)}`);
    }
  };

  // Installed for as long as the lock is held. `interruption` is set before
  // the handler's first await, so the interrupt owns the segment's end and
  // the exit code: whatever the run loop then does with the killed agent is
  // not recorded as the run's end. The abort comes before any await, so the
  // executor sees `InterruptedError`, for which it records nothing.
  let interruption: Promise<number> | undefined;
  const interrupt = async (signal: StopSignal): Promise<number> => {
    abort.abort(new InterruptedError(`the run was interrupted by ${signal}`));
    await endRun("interrupted");
    await lock.release();
    return SIGNAL_EXIT_CODES[signal];
  };
  const uninstallSignals = (deps.onSignal ?? onProcessSignal)(async (signal) => {
    interruption ??= interrupt(signal);
    await interruption;
  });

  try {
    const issue = await tracker.getIssue(parsed.issue);
    // Catches running an issue through the wrong flow, e.g. a feature through the single-issue flow.
    if (!acceptsLabels(flow, issue.labels)) {
      err(`sous run: ${issue.ref} has none of the labels flow "${flow.name}" accepts (${flow.allowedLabels?.join(", ")}); label the issue or run another flow`);
      return 2;
    }
    const dirName = existingSpecDirName(await specEntries(dirs.specs), issue.id) ?? specDirName(issue.id, issue.title);
    // Relative to the repository root: the worktree holds the same tree.
    const specDir = relative(repoRoot, join(dirs.specs, dirName));
    const branch = branchName(settings.branch, issue);
    const runs = dirs.runs;
    const run = runDir(runs, issue.id);

    // Run folder, worktree and branch may each be missing already; removing
    // what is not there is a no-op.
    if (parsed.restart) {
      const worktree = worktreePathFor(repoRoot, branch);
      if (!(await deps.confirm(`Delete the run folder ${run}, worktree ${worktree} and branch ${branch} of ${issue.ref}? [y/N] `))) {
        err("sous run: restart cancelled");
        return 1;
      }
      await rm(run, { recursive: true, force: true });
      await git.removeWorktree(repoRoot, worktree);
      if (await git.branchExists(repoRoot, branch)) await git.deleteBranch(repoRoot, branch, { force: true });
      out(`restart: removed ${run}, the worktree and branch ${branch}`);
    }

    const existing = await loadSession(sessionFile(runs, issue.id));
    if (existing !== undefined && existing.flow !== flow.name) {
      err(`sous run: ${issue.ref} was started with flow "${existing.flow}"; run that flow or pass --restart`);
      return 1;
    }
    const session = existing ?? createSession({ flow: flow.name, issue: issue.id, title: issue.title, branch, specDir, entry: flow.entry });
    if (session.current === DONE) {
      out(`${issue.ref} is already done (pass --restart to run it again)`);
      return 0;
    }

    const sandbox = await deps.openSandbox({ repoRoot, branch: session.branch, settings, signal: abort.signal });
    // An interrupt before the segment opened leaves nothing to close.
    if (interruption !== undefined) return await interruption;
    out(`${existing === undefined ? "starting" : "resuming"} ${issue.ref} at ${session.current} in ${sandbox.worktreePath}`);

    const events = createFileEventLog(eventsFile(runs, issue.id));
    const runId = (deps.newId ?? randomId)();
    const resumedFrom = resumePoint(session, flow);
    const sha = await (deps.sha ?? gitShortSha(repoRoot))();
    const started = events.append({
      type: "run.start",
      at: clock().toISOString(),
      runId,
      pid: deps.pid ?? process.pid,
      host: deps.host ?? hostname(),
      sha,
      flow: flow.name,
      ...(resumedFrom !== undefined ? { resumedFrom } : {}),
    });
    segment = { events, runId, started };
    await started;

    const lifecycle = createLifecycle({ tracker, issue: issue.id, mode: flow.lifecycle ?? settings.lifecycle });
    // Claimed on every start, so a resumed run takes the issue back from `blocked`.
    await lifecycle.claim(session.branch);
    let final: Session;
    try {
      final = await runFlow(flow, session, {
        issue: { id: issue.id, ref: issue.ref, title: issue.title, body: issue.body, labels: issue.labels },
        work: await workOf(tracker, issue, session.work),
        sandbox,
        git,
        tracker,
        events,
        persist: filePersist(sessionFile(runs, issue.id)),
        clock,
        skillsDir: dirs.skills,
        logsDir: dirs.logs,
        repoRoot,
        onTransition: (s, to) => (to === BLOCKED ? lifecycle.block(s, sandbox.worktreePath) : Promise.resolve()),
        log,
        runId,
      });
    } catch (error) {
      if (interruption !== undefined) return await interruption;
      await endRun("crashed", messageOf(error));
      throw error;
    }
    if (interruption !== undefined) return await interruption;
    if (final.current === DONE) await lifecycle.close();
    await endRun(final.blocked ? "blocked" : "done");
    out(final.blocked ? `${issue.ref} blocked in ${final.current}; see the issue comment` : `${issue.ref}: ${final.current}`);
    return final.blocked ? 1 : 0;
  } catch (error) {
    if (interruption !== undefined) return await interruption;
    throw error;
  } finally {
    uninstallSignals();
    await lock.release();
    dropExitListener();
  }
};
