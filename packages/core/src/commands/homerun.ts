/**
 * `sous run <issue> [--repo <name>]` typed in a home repository (one with
 * `repos:`): the issue's `repo:<name>` label, or `--repo`, names the entry,
 * by the rule `sous watch` routes with, and the run is started there as the
 * daemon starts it: this engine's CLI with `SOUS_ROOT` at the entry's
 * `.sous/`, in its checkout. Lock, run record, logs and worktree are the
 * entry's, so its own `sous status` finds the run. An entry that is the
 * home repository itself (`planning: .`) runs in this process: a child with
 * the same `SOUS_ROOT` would route again and start itself without end.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENGINE_VERSION, engineCheckOf, engineRefusalOf } from "../config/engine.js";
import { repoEntries, routeIssue, type Route } from "../config/repos.js";
import { loadSettings, SETTINGS_FILE } from "../config/settings.js";
import type { Tracker } from "../ports/tracker.js";
import { PROJECT_DIR } from "../root.js";
import { parseRunArgs, SIGNAL_EXIT_CODES, type StopSignal } from "./run.js";

/** Runs `command args` in `cwd` with `env` over this process's own, the terminal shared; resolves with its exit code. Injected so tests start no processes. */
export type RunChild = (command: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }) => Promise<number>;

export type HomeRunDeps = {
  /** The home repository's project root (`.sous/`), the one with `repos:`. */
  root: string;
  /** The home repository's tracker, asked for the issue's labels. */
  tracker: Tracker;
  /** The running engine's CLI as a command line (`engineCommandOf`). */
  engine: readonly string[];
  /** The running engine's version, checked against the entry's `engine:` as the daemon checks it; injectable for tests. */
  engineVersion?: string;
  runChild: RunChild;
  /** `sous run` in this repository, for an issue routed to the home repository itself; gets the arguments without `--repo`. */
  runHere: (args: readonly string[]) => Promise<number>;
  out: (line: string) => void;
  err: (line: string) => void;
};

/** Whether the project at `root` is a home repository, whose `sous run` routes to an entry. */
export const isHomeRepository = (root: string): boolean => repoEntries(root, loadSettings(join(root, SETTINGS_FILE))) !== undefined;

export const homeRunCommand = async (args: readonly string[], deps: HomeRunDeps): Promise<number> => {
  const parsed = parseRunArgs(args);
  if ("error" in parsed) {
    deps.err(parsed.error);
    return 2;
  }
  const entries = repoEntries(deps.root, loadSettings(join(deps.root, SETTINGS_FILE))) ?? [];
  const scope = { entries: entries.map((e) => e.name) };
  // A named entry needs no issue: an unknown one is refused before the tracker is asked.
  let route: Route;
  let label: string;
  if (parsed.repo !== undefined) {
    route = routeIssue([], scope, parsed.repo);
    label = `#${parsed.issue}`;
  } else {
    const issue = await deps.tracker.getIssue(parsed.issue);
    route = routeIssue(issue.labels, scope);
    label = issue.ref;
  }
  if ("reason" in route) {
    deps.err(parsed.repo !== undefined ? `sous run: ${route.reason}` : `sous run: ${label}: ${route.reason}`);
    return 2;
  }
  const { name, path } = entries.find((e) => e.name === route.to)!;
  const root = join(path, PROJECT_DIR);
  if (!existsSync(join(root, SETTINGS_FILE))) {
    deps.err(`sous run: ${name}: ${path} holds no ${PROJECT_DIR}/${SETTINGS_FILE}`);
    return 2;
  }
  // What the daemon would set aside is refused here, in its words: the two agree on what runs.
  const version = deps.engineVersion ?? ENGINE_VERSION;
  const refusal = engineRefusalOf(engineCheckOf(root, version, path), version);
  if (refusal !== undefined) {
    deps.err(`sous run: ${name}: ${refusal}`);
    return 2;
  }
  const own = [parsed.issue, ...(parsed.flow !== undefined ? ["--flow", parsed.flow] : []), ...(parsed.restart ? ["--restart"] : [])];
  if (resolve(root) === resolve(deps.root)) return deps.runHere(own);
  const [command = "sous", ...prefix] = deps.engine;
  const runArgs = ["run", ...own];
  deps.out(`${label}: running in ${name}: ${[...deps.engine, ...runArgs].join(" ")} in ${path}`);
  return deps.runChild(command, [...prefix, ...runArgs], { cwd: path, env: { SOUS_ROOT: root } });
};

/**
 * The real child: in this process's group and on its terminal, so a Ctrl-C
 * reaches the run once, from the terminal, as it reaches a `sous run` typed
 * in the repository, and `--restart` can ask its question. This process
 * waits for it: a SIGINT is the run's to handle, a SIGTERM sent here alone is
 * passed on.
 */
export const runChildInTerminal: RunChild = (command, args, { cwd, env }) =>
  new Promise((resolve) => {
    const { SOUS_ROOT: _homeRoot, ...inherited } = process.env;
    const child = spawn(command, [...args], { cwd, env: { ...inherited, ...env }, stdio: "inherit" });
    const ignore = (): void => undefined;
    const forward = (signal: StopSignal): void => void child.kill(signal);
    process.on("SIGINT", ignore);
    process.on("SIGTERM", forward);
    const done = (code: number): void => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", forward);
      resolve(code);
    };
    child.on("error", (error) => {
      process.stderr.write(`sous run: ${error.message}\n`);
      done(1);
    });
    child.on("close", (code, signal) => done(code ?? (signal !== null && signal in SIGNAL_EXIT_CODES ? SIGNAL_EXIT_CODES[signal as StopSignal] : 1)));
  });
