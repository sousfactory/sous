/**
 * `sous watch [--once] [--interval <seconds>]`: runs the repository
 * unattended. Each pass asks the tracker for the open issues carrying
 * `<prefix>:ready` (and `<prefix>:running`, for crashed runs) and starts the
 * lowest-numbered one that qualifies as `sous run <issue> --flow <flow>`
 * of the daemon's own engine with `SOUS_ROOT` at the repository's `.sous/`,
 * the flow resolved as `sous run <issue>` resolves it, one run at a time.
 *
 * The daemon owns nothing a run owns: locks, sessions, labels and comments
 * stay the run's. Its own state is in memory (what it reported, what it
 * retried) and lasts as long as the process; one watch lock per project
 * keeps a second daemon out.
 */
import { spawn as spawnProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Exec } from "../adapters/exec.js";
import { logDir } from "../adapters/logs.js";
import { ENGINE_VERSION, engineCheckOf, engineRefusalOf } from "../config/engine.js";
import { flowLabelsOf, resolveFlow } from "../config/resolve.js";
import { messageOf, readYaml } from "../config/schema.js";
import { loadSettings, projectDirs, requiredTracker, SETTINGS_FILE } from "../config/settings.js";
import { listFlows } from "../config/validate.js";
import { byId, stateLabels, type Issue } from "../ports/tracker.js";
import { routeIssue, type Route } from "../config/repos.js";
import { lookupOf, type Lookup, type LookupEntry } from "../lookup.js";
import { repoRootOf } from "../root.js";
import { acquireLock, classifyLock, isProcessAlive, liveLocks, lockPath, locksDir, type AcquireResult } from "./lock.js";
import { onProcessSignal, SIGNAL_EXIT_CODES, SIGNAL_GRACE_MS, type SignalHandler, type StopSignal } from "./run.js";

export const USAGE = "usage: sous watch [--once] [--interval <seconds>]";

export const DEFAULT_INTERVAL_SECONDS = 60;

export type WatchArgs = { once: boolean; intervalSeconds: number };

export const parseWatchArgs = (args: readonly string[]): WatchArgs | { error: string } => {
  const parsed: WatchArgs = { once: false, intervalSeconds: DEFAULT_INTERVAL_SECONDS };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--once") parsed.once = true;
    else if (arg === "--interval") {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) return { error: `--interval takes a whole number of seconds, at least 1\n${USAGE}` };
      parsed.intervalSeconds = value;
    } else return { error: `unknown argument ${String(arg)}\n${USAGE}` };
  }
  return parsed;
};

/** How a child ended; `stderr` is what it wrote there, for the one line reporting a failure. */
export type ChildExit = { code: number | null; signal: string | null; stderr: string };

export type Child = { pid: number | undefined; exited: Promise<ChildExit>; kill: (signal: StopSignal) => void };

/** Starts `command args` in `cwd` with `env` over the daemon's own; `onOutput` gets each line the child prints on stdout. Injected so tests start no processes. */
export type Spawn = (command: string, args: readonly string[], options: { cwd: string; env?: Record<string, string>; onOutput: (line: string) => void }) => Child;

/** Node's flags that load code before the CLI, as tsx registers its loader in a checkout; each takes a value. */
const LOADER_FLAGS = new Set(["--import", "--loader", "--experimental-loader", "--require", "-r"]);

/**
 * The loader flags of `execArgv`, each with its value, whether that follows
 * as the next argument or after `=`. An allowlist: an inspector flag would
 * make every child fight for the parent's debugger port, a memory flag sized
 * for the daemon is not the run's.
 */
const loaderFlagsOf = (execArgv: readonly string[]): string[] => {
  const kept: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]!;
    const eq = arg.indexOf("=");
    if (LOADER_FLAGS.has(eq === -1 ? arg : arg.slice(0, eq))) {
      kept.push(arg);
      if (eq === -1 && i + 1 < execArgv.length) kept.push(execArgv[++i]!);
    }
  }
  return kept;
};

/** The running engine's CLI as a command line: this node, its loader flags (tsx's in a checkout) and the CLI file. */
export const engineCommandOf = (cliFile: string, execArgv: readonly string[] = process.execArgv): string[] => [process.execPath, ...loaderFlagsOf(execArgv), cliFile];

/** A repository the daemon serves: an entry of the lookup, with its tracker and where that tracker keeps its issues. */
export type WatchRepo = LookupEntry;

export type WatchDeps = {
  /** The project root (`.sous/`) the daemon is started in; its watch lock lives there. */
  root: string;
  /** The repositories served: the `repos:` entries, or the current repository alone. */
  repos: readonly WatchRepo[];
  /** The repositories come from `repos:`: lines name the repository, and a label naming no entry is reported as such. */
  listed: boolean;
  /** What starts a run: the running engine's CLI (`engineCommandOf`), whatever the repository installed. */
  engine: readonly string[];
  /** `repos:` entries the daemon cannot run (no `.sous/sous.yaml`, no `engine:` this engine satisfies): reported once, issues routed to them not run. */
  unrunnable?: readonly { name: string; reason: string }[];
  /** The running engine's version, checked against the project's own `engine:`; injectable for tests. */
  engineVersion?: string;
  spawn: Spawn;
  out: (line: string) => void;
  err: (line: string) => void;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  /** Waits between passes; the signal ends the wait early. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Installs `handler` for SIGINT/SIGTERM and returns the uninstaller; injectable so tests do not exit. */
  onSignal?: (handler: SignalHandler) => () => void;
};

/** Not a `.lock` file, so `liveLocks`, `sous status` and the UI do not list the daemon as a run. */
export const WATCH_LOCK = "watch.pid";

export const watchLockPath = (root: string): string => join(locksDir(root), WATCH_LOCK);

/** The last line a child wrote to stderr, which names why `sous run` failed. */
const lastLine = (text: string): string | undefined =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .at(-1);

/** A run's line saying it pushed the base branch: the one piece of a run's output the daemon passes on. */
const PUSHED = /\bpushed \S+ to \S+/;

export type Watcher = {
  /** One look at every tracker: reports what it skips (once) and starts at most one run per repository. */
  pass(): Promise<void>;
  /** Settles once no run the daemon started is in progress. */
  idle(): Promise<void>;
  /** Forwards `signal` to the runs in progress and waits for them to end; no run starts after it. */
  interrupt(signal: StopSignal): Promise<void>;
};

/** Says something about an issue once; a changed reason is news and said again. */
type Reporter = (key: string, line: string) => void;

/** One served repository: its candidates, its one run, what it retried. */
type RepoWatcher = {
  repo: WatchRepo;
  /** Its `<prefix>:ready` label. */
  ready: string;
  /** The open issues of its tracker that may concern the daemon: ready, or running after a crash. */
  listed(): Promise<Issue[]>;
  /** Judges the issues routed here and starts the first that qualifies, unless a run is in progress. */
  serve(issues: readonly Issue[]): Promise<void>;
  idle(): Promise<void>;
  interrupt(signal: StopSignal): Promise<void>;
};

const createRepoWatcher = (repo: WatchRepo, deps: WatchDeps, report: Reporter, stopping: () => boolean): RepoWatcher => {
  const { root, repoRoot, tracker } = repo;
  const { out } = deps;
  const isAlive = deps.isAlive ?? isProcessAlive;
  const file = join(root, SETTINGS_FILE);
  const settings = loadSettings(file);
  const dirs = projectDirs(root, settings);
  const { labels } = requiredTracker(settings, file);
  const ready = `${labels}:ready`;
  const { running, blocked } = stateLabels(labels);
  /** How a line names an issue: with its repository when several are served. */
  const name = (issue: Issue): string => (deps.listed ? `${repo.name} ${issue.ref}` : issue.ref);

  /** Issues rerun once after a crash in this daemon's lifetime. */
  const retried = new Set<string>();
  /** Issues whose rerun crashed too; this daemon leaves them to a human. */
  const gaveUp = new Set<string>();
  /** The labels an issue still carried, ready included, when the run the daemon started for it ended. */
  const leftReady = new Map<string, string>();
  let current: { issue: string; child: Child; ended: Promise<void> } | undefined;

  const skip = (issue: Issue, reason: string): void => report(`${repo.name}|${issue.id}|${reason}`, `${name(issue)} skipped: ${reason}`);

  const labelsKey = (issue: Issue): string => [...issue.labels].sort().join("\n");

  /** The flow the issue's labels resolve to, by the rule `sous run <issue>` follows, or why there is none. */
  const flowFor = (issue: Issue): { flow: string } | { reason: string } => {
    const resolved = resolveFlow(issue.labels, flowLabelsOf(dirs.flows));
    return resolved.kind === "flow" ? { flow: resolved.flow } : { reason: resolved.message };
  };

  const lockStatus = async (issue: string) => classifyLock(await readFile(lockPath(root, issue), "utf8").catch(() => undefined), isAlive);

  /** Blocks a rerun that ended still claimed: it crashed a second time. */
  const blockIfCrashed = async (issue: Issue): Promise<void> => {
    const now = await tracker.getIssue(issue.id);
    if (now.state === "closed" || !now.labels.includes(running)) return;
    const lock = await lockStatus(issue.id);
    if (lock.kind === "held") return;
    // `sous run` never takes over a stale lock: the crashed rerun's would keep the human's hand-back from starting.
    if (lock.kind === "stale") await rm(lockPath(root, issue.id), { force: true });
    const logs = relative(repoRoot, logDir(dirs.logs, issue.id));
    gaveUp.add(issue.id);
    await tracker.block(
      issue.id,
      [`sous watch reran this issue after a crash and the rerun crashed as well, so it stops here.`, "", `The run's agent logs are in \`${logs}\`; its session and events in \`${relative(repoRoot, join(dirs.runs, issue.id))}\`.`, `Fix the cause, then set \`${ready}\` to hand it back.`].join("\n"),
    );
    out(`${name(issue)}: crashed again; set ${blocked}, logs in ${logs}`);
  };

  const start = (issue: Issue, flow: string, rerun: boolean, note: string): void => {
    const [command = "sous", ...prefix] = deps.engine;
    // The resolved flow is passed on, so the run takes exactly the daemon's choice and the line names it.
    const args = [...prefix, "run", issue.id, "--flow", flow];
    const line = `sous run ${issue.id} --flow ${flow}`;
    // The repository's definitions, this engine: SOUS_ROOT names the project, never its wrapper or install.
    const child = deps.spawn(command, args, { cwd: repoRoot, env: { SOUS_ROOT: root }, onOutput: (text) => (PUSHED.test(text) ? out(`${name(issue)}: ${text.trim()}`) : undefined) });
    const how = `(pid ${child.pid}, ${deps.engine.join(" ")} in ${repoRoot})`;
    // Picked through a shared tracker: the label chose the repository, so the line says which tracker it came from.
    if (repo.shared) out(`${issue.ref}: running in ${repo.name} (${repo.location.at})`);
    out(rerun ? `${name(issue)}: ${note}rerunning ${line} after a crash ${how}` : `${name(issue)}: ${note}started ${line} ${how}`);
    let interrupted = false;
    const kill = child.kill;
    child.kill = (signal) => {
      interrupted = true;
      kill(signal);
    };
    const ended = child.exited.then(async (result) => {
      if (result.code !== 0 && !interrupted) {
        const why = lastLine(result.stderr);
        out(`${name(issue)}: ${line} exited with ${result.code ?? result.signal}${why !== undefined ? `: ${why}` : ""}`);
      }
      try {
        if (rerun && !interrupted) await blockIfCrashed(issue);
        if (!interrupted) {
          const after = await tracker.getIssue(issue.id);
          if (after.state === "open" && after.labels.includes(ready)) leftReady.set(issue.id, labelsKey(after));
        }
      } catch (error) {
        deps.err(`sous watch: ${name(issue)}: ${messageOf(error)}`);
      } finally {
        current = undefined;
      }
    });
    current = { issue: issue.id, child, ended };
  };

  /** Why `issue` may not start now, or the flow and how it starts. */
  type Verdict = { reason: string } | { flow: string; rerun: boolean; staleLock: boolean; note: string };

  const judge = async (issue: Issue): Promise<Verdict | undefined> => {
    const isReady = issue.labels.includes(ready);
    // Blocking swapped ready away, so ready on a given-up issue is a human handing it back: judge it as a new daemon would.
    if (gaveUp.has(issue.id) && isReady) {
      gaveUp.delete(issue.id);
      retried.delete(issue.id);
    }
    if (gaveUp.has(issue.id)) return { reason: `its rerun crashed as well; this sous watch leaves it to a human` };
    const lock = await lockStatus(issue.id);
    if (lock.kind === "held") return isReady ? { reason: `a run holds its lock (pid ${lock.lock.pid})` } : undefined;
    if (lock.kind === "unreadable") return { reason: `its lock ${lockPath(root, issue.id)} is unreadable; remove it` };
    // A claimed issue whose lock names a dead pid crashed here: rerun once, as a human would. Without a
    // lock the run may be another machine's, or an interrupt a human hands back with ready.
    const rerun = !isReady && issue.labels.includes(running) && lock.kind === "stale";
    if (!isReady && !rerun) return undefined;
    if (rerun && retried.has(issue.id)) return undefined;
    if (isReady && leftReady.get(issue.id) === labelsKey(issue)) return { reason: `still ${ready} after its run exited; change its labels to start it again` };
    if (isReady) {
      let open: string[];
      try {
        open = await tracker.blockers(issue.id);
      } catch (error) {
        return { reason: messageOf(error) };
      }
      if (open.length > 0) return { reason: `blocked by ${open.map((b) => (/^\d+$/.test(b) ? `#${b}` : b)).join(", ")}` };
    }
    const picked = flowFor(issue);
    if ("reason" in picked) return picked;
    const staleLock = lock.kind === "stale";
    return { flow: picked.flow, rerun, staleLock, note: staleLock ? `removed the stale lock of pid ${lock.lock.pid}; ` : "" };
  };

  const idle = async (): Promise<void> => {
    while (current !== undefined) await current.ended;
  };

  return {
    repo,
    ready,
    async listed() {
      const found = [...(await tracker.list({ labels: [ready] })), ...(await tracker.list({ labels: [running] }))];
      return [...new Map(found.map((i) => [i.id, i])).values()].sort(byId);
    },
    async serve(issues) {
      let next: { issue: Issue; flow: string; rerun: boolean; staleLock: boolean; note: string } | undefined;
      for (const issue of issues) {
        const verdict = await judge(issue);
        if (verdict === undefined) continue;
        if ("reason" in verdict) skip(issue, verdict.reason);
        else next ??= { issue, ...verdict };
      }
      // One run per repository: the daemon's own, or one a human started by hand.
      if (next === undefined || current !== undefined || (await liveLocks(root, isAlive)).length > 0) return;
      if (stopping()) return;
      if (next.rerun) retried.add(next.issue.id);
      // A crashed run's lock, rerun or handed back with ready: `sous run` never takes over a stale lock.
      if (next.staleLock) await rm(lockPath(root, next.issue.id), { force: true });
      // A stop that landed while this pass awaited anything above: a run started now would never get the signal.
      if (stopping()) return;
      start(next.issue, next.flow, next.rerun, next.note);
    },
    idle,
    async interrupt(signal) {
      current?.child.kill(signal);
      await idle();
    },
  };
};

/**
 * Where an issue listed by `seenIn`'s tracker runs, by `routeIssue`: among
 * every entry, runnable or not; without `repos:`, the one repository.
 */
const routeOf = (issue: Issue, seenIn: WatchRepo, deps: WatchDeps): Route =>
  routeIssue(issue.labels, { listedBy: seenIn, entries: [...deps.repos, ...(deps.unrunnable ?? []).map(({ name }) => ({ name }))], home: deps.listed });

export const createWatcher = (deps: WatchDeps): Watcher => {
  /** Keys once printed: an issue reachable through two trackers is reported once. */
  const reported = new Set<string>();
  const report: Reporter = (key, line) => {
    if (reported.has(key)) return;
    reported.add(key);
    deps.out(line);
  };
  /** Set by the first interrupt: from then on no run starts, wherever the pass is. */
  let stopped = false;
  const watchers = deps.repos.map((repo) => createRepoWatcher(repo, deps, report, () => stopped));
  const byName = new Map(watchers.map((w) => [w.repo.name, w]));
  const prefix = (repo: WatchRepo): string => (deps.listed ? `${repo.name}: ` : "");

  const pass = async (): Promise<void> => {
    for (const { name, reason } of deps.unrunnable ?? []) report(`unrunnable|${name}`, `${name} skipped: ${reason}`);
    const failures: string[] = [];
    const listings = new Map<string, Issue[]>();
    for (const watcher of watchers) {
      try {
        listings.set(watcher.repo.name, await watcher.listed());
      } catch (error) {
        failures.push(`${prefix(watcher.repo)}${messageOf(error)}`);
      }
    }
    // Each repository runs the issues its own tracker lists for it: that tracker is the one its run asks. An issue
    // of a shared tracker that names another entry there is that entry's, which lists it too: it runs once, there.
    const routed = new Map<string, Issue[]>(watchers.map((w) => [w.repo.name, []]));
    for (const watcher of watchers) {
      const { repo } = watcher;
      for (const issue of listings.get(repo.name) ?? []) {
        const route = routeOf(issue, repo, deps);
        if ("to" in route) {
          if (route.to === repo.name) routed.get(repo.name)?.push(issue);
        } else if (issue.labels.includes(watcher.ready)) {
          // Keyed by the tracker, not the entry: an issue two entries list is reported once.
          report(`route|${repo.location.type}|${repo.location.at}|${issue.id}|${route.reason}`, `${issue.ref} skipped: ${route.reason}`);
        }
      }
    }
    for (const [name, issues] of routed) {
      try {
        await byName.get(name)?.serve(issues);
      } catch (error) {
        failures.push(`${deps.listed ? `${name}: ` : ""}${messageOf(error)}`);
      }
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
  };

  const idle = async (): Promise<void> => {
    await Promise.all(watchers.map((w) => w.idle()));
  };

  return {
    pass,
    idle,
    async interrupt(signal) {
      stopped = true;
      await Promise.all(watchers.map((w) => w.interrupt(signal)));
    },
  };
};

/**
 * The real child: its own process group, so a Ctrl-C in the terminal reaches
 * the daemon alone and is forwarded once, to the whole group: the run, any
 * process under it and the run's agents, as a Ctrl-C reaches a foreground
 * `sous run`.
 */
export const spawnChild: Spawn = (command, args, { cwd, env: extra = {}, onOutput }) => {
  // The daemon's SOUS_ROOT names its own project; the run gets the one `extra` names, or finds its own from its cwd.
  const { SOUS_ROOT: _daemonRoot, ...inherited } = process.env;
  const child = spawnProcess(command, [...args], { cwd, env: { ...inherited, ...extra }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let pending = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onOutput(line);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const exited = new Promise<ChildExit>((resolve) => {
    child.on("error", (error) => resolve({ code: null, signal: null, stderr: `${stderr}\n${error.message}` }));
    child.on("close", (code, signal) => {
      if (pending !== "") onOutput(pending);
      resolve({ code, signal, stderr });
    });
  });
  return {
    pid: child.pid,
    exited,
    kill: (signal) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is gone: the run ended on its own.
      }
    },
  };
};

/**
 * The repositories `sous watch` in the project at `root` serves: the lookup
 * (`lookupOf`), each entry built from its own `.sous/`; a wrapper or
 * `node_modules` there is neither needed nor used.
 */
export const watchReposOf = (root: string, exec?: Exec, engineVersion: string = ENGINE_VERSION): Promise<Lookup> => lookupOf(root, exec, engineVersion);

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Why `sous watch` refuses to start on the project at `root` under the engine
 * `version`, or undefined: an `engine:` that is missing, invalid or not
 * satisfied, a home repository's own included. Read tolerantly, so the CLI
 * asks it before anything loads the settings strictly.
 */
export const watchEngineRefusal = (root: string, version: string): string | undefined => {
  const refusal = engineRefusalOf(engineCheckOf(root, version, repoRootOf(root)), version);
  return refusal === undefined ? undefined : `sous watch: ${refusal}`;
};

export const watchCommand = async (args: readonly string[], deps: WatchDeps): Promise<number> => {
  const parsed = parseWatchArgs(args);
  if ("error" in parsed) {
    deps.err(parsed.error);
    return 2;
  }
  // The project the daemon starts on; listed repositories were checked one by one and set aside.
  const refusal = watchEngineRefusal(deps.root, deps.engineVersion ?? ENGINE_VERSION);
  if (refusal !== undefined) {
    deps.err(refusal);
    return 2;
  }
  const isAlive = deps.isAlive ?? isProcessAlive;
  const path = watchLockPath(deps.root);
  const lockInfo = { pid: deps.pid ?? process.pid, issue: "watch" };
  let lock: AcquireResult = await acquireLock(path, lockInfo, isAlive);
  // A dead daemon's lock guards nothing; the next one takes over.
  if (!lock.ok && lock.status.kind === "stale") {
    await rm(path, { force: true });
    lock = await acquireLock(path, lockInfo, isAlive);
  }
  if (!lock.ok) {
    const holder = lock.status.kind === "unreadable" ? `unreadable lock ${path}; remove it if no sous watch runs` : `pid ${lock.status.lock.pid}, ${path}`;
    deps.err(`sous watch: another sous watch is live for this project (${holder})`);
    return 1;
  }
  const { release } = lock;

  let watcher: Watcher;
  try {
    watcher = createWatcher(deps);
  } catch (error) {
    await release();
    throw error;
  }
  const sleep = deps.sleep ?? pause;
  const stop = new AbortController();
  const stopped = new Promise<void>((resolve) => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
  let stopSignal: StopSignal | undefined;
  // The runs get their own grace period to record the interrupt; the daemon waits a little longer than they do.
  const uninstall = (deps.onSignal ?? ((h) => onProcessSignal(h, { graceMs: SIGNAL_GRACE_MS * 2 })))(async (signal) => {
    stopSignal ??= signal;
    stop.abort();
    await watcher.interrupt(signal);
    await release();
  });

  // A daemon outlives a failed pass (the tracker unreachable for a minute); `--once` reports it in its exit code.
  let failed = false;
  try {
    while (stopSignal === undefined) {
      try {
        await watcher.pass();
      } catch (error) {
        failed = true;
        deps.err(`sous watch: ${messageOf(error)}`);
      }
      if (parsed.once || stopSignal !== undefined) break;
      await Promise.race([sleep(parsed.intervalSeconds * 1000, stop.signal), stopped]);
    }
    await watcher.idle();
    if (stopSignal !== undefined) return SIGNAL_EXIT_CODES[stopSignal];
    return parsed.once && failed ? 1 : 0;
  } finally {
    uninstall();
    await release();
  }
};
