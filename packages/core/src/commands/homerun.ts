/**
 * `sous run <issue | name#issue>` typed in a home repository (one with
 * `repos:`): the lookup `sous watch` runs on, without the ready filter. A
 * bare id is asked of every distinct tracker of the entries (by type and
 * location); `name#id` is asked of that entry's tracker alone. Where the one
 * issue found runs is `routeIssue`'s rule over the entry whose tracker
 * listed it, and the run is started there as the daemon starts it: this
 * engine's CLI with `SOUS_ROOT` at the entry's `.sous/`, in its checkout.
 * Lock, run record, logs and worktree are the entry's, so its own
 * `sous status` finds the run. An entry that is the home repository itself
 * (`planning: .`) runs in this process: a child with the same `SOUS_ROOT`
 * would route again and start itself without end.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENGINE_VERSION, engineCheckOf, engineRefusalOf } from "../config/engine.js";
import { repoEntries, routeIssue, type TrackerLocation } from "../config/repos.js";
import { loadSettings, SETTINGS_FILE } from "../config/settings.js";
import type { Lookup, LookupEntry } from "../lookup.js";
import { isIssueNotFound, type Issue } from "../ports/tracker.js";
import { messageOf } from "../config/schema.js";
import { PROJECT_DIR } from "../root.js";
import { parseRunArgs, SIGNAL_EXIT_CODES, type StopSignal } from "./run.js";

/** Runs `command args` in `cwd` with `env` over this process's own, the terminal shared; resolves with its exit code. Injected so tests start no processes. */
export type RunChild = (command: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }) => Promise<number>;

export type HomeRunDeps = {
  /** The home repository's project root (`.sous/`), the one with `repos:`. */
  root: string;
  /** The entries and their trackers (`lookupOf`), as `sous watch` serves them. */
  lookup: Lookup;
  /** The running engine's CLI as a command line (`engineCommandOf`). */
  engine: readonly string[];
  /** The running engine's version, checked against the entry's `engine:` as the daemon checks it; injectable for tests. */
  engineVersion?: string;
  runChild: RunChild;
  /** `sous run` in this repository, for an issue routed to the home repository itself; gets the bare id and the options. */
  runHere: (args: readonly string[]) => Promise<number>;
  out: (line: string) => void;
  err: (line: string) => void;
};

/** Whether the project at `root` is a home repository, whose `sous run` routes to an entry. */
export const isHomeRepository = (root: string): boolean => repoEntries(root, loadSettings(join(root, SETTINGS_FILE))) !== undefined;

const trackerName = (location: TrackerLocation): string => `${location.type} ${location.at}`;

const keyOf = (location: TrackerLocation): string => `${location.type}\n${location.at}`;

/** Why a tracker that did not answer for an id stops the lookup: without its answer the issue may be elsewhere than found. */
class Unanswered extends Error {}

/**
 * The issue as one tracker answered, `undefined` when it says it holds none
 * (`isIssueNotFound`). Any other failure is not a miss: counted as one, a
 * tracker down would let another tracker's issue of the same number run.
 */
const ask = async (entry: LookupEntry, id: string): Promise<Issue | undefined> => {
  try {
    return await entry.tracker.getIssue(id);
  } catch (error) {
    if (isIssueNotFound(error)) return undefined;
    throw new Unanswered(`issue ${id}: the tracker ${trackerName(entry.location)} did not answer: ${messageOf(error)}`);
  }
};

/** The issue and the entry whose tracker listed it, or the message `sous run` exits 2 with. */
type Found = { issue: Issue; listedBy: LookupEntry } | { error: string };

/** `name#id`: the entry's tracker alone. */
const findIn = async (entry: LookupEntry, id: string): Promise<Found> => {
  const issue = await ask(entry, id);
  if (issue === undefined) return { error: `${entry.name}#${id} is not in the tracker of ${entry.name} (${trackerName(entry.location)})` };
  if (issue.state === "closed") return { error: `${entry.name}#${id} is closed in the tracker of ${entry.name} (${trackerName(entry.location)})` };
  return { issue, listedBy: entry };
};

/** A bare id: every distinct tracker, once; found open in exactly one, that one listed it. */
const findAcross = async (repos: readonly LookupEntry[], id: string): Promise<Found> => {
  const trackers = new Map<string, LookupEntry[]>();
  for (const repo of repos) trackers.set(keyOf(repo.location), [...(trackers.get(keyOf(repo.location)) ?? []), repo]);
  const asked = [...trackers.values()].map((on) => trackerName(on[0]!.location)).join(", ");
  const open: { issue: Issue; on: LookupEntry[] }[] = [];
  let closed = false;
  for (const on of trackers.values()) {
    const issue = await ask(on[0]!, id);
    if (issue === undefined) continue;
    if (issue.state === "closed") closed = true;
    else open.push({ issue, on });
  }
  if (open.length === 0) return { error: closed ? `issue ${id} is closed wherever it is found (asked: ${asked})` : `issue ${id} is in none of the trackers asked (${asked})` };
  if (open.length > 1) {
    const named = open.flatMap(({ on }) => on.map((e) => `sous run ${e.name}#${id}`));
    return { error: `issue ${id} is in several trackers; name the entry: ${named.join(", ")}` };
  }
  const [{ issue, on }] = open as [{ issue: Issue; on: LookupEntry[] }];
  return { issue, listedBy: on[0]! };
};

/** Why nothing starts in entry `name` at `path`, in the daemon's words, or `undefined` when a run may. */
const unrunnableReason = (name: string, path: string, version: string): string | undefined => {
  const root = join(path, PROJECT_DIR);
  if (!existsSync(join(root, SETTINGS_FILE))) return `${name}: ${path} holds no ${PROJECT_DIR}/${SETTINGS_FILE}`;
  const refusal = engineRefusalOf(engineCheckOf(root, version, path), version);
  return refusal === undefined ? undefined : `${name}: ${refusal}`;
};

export const homeRunCommand = async (args: readonly string[], deps: HomeRunDeps): Promise<number> => {
  const parsed = parseRunArgs(args);
  if ("error" in parsed) {
    deps.err(parsed.error);
    return 2;
  }
  const fail = (message: string): number => {
    deps.err(`sous run: ${message}`);
    return 2;
  };
  const { repos, unrunnable } = deps.lookup;
  const version = deps.engineVersion ?? ENGINE_VERSION;
  const entries = repoEntries(deps.root, loadSettings(join(deps.root, SETTINGS_FILE))) ?? [];
  const pathOf = (name: string): string => entries.find((e) => e.name === name)!.path;

  const unanswered = (error: unknown): Found => {
    if (error instanceof Unanswered) return { error: error.message };
    throw error;
  };
  let found: Found;
  if (parsed.entry !== undefined) {
    const qualified = `${parsed.entry}#${parsed.issue}`;
    const entry = repos.find((r) => r.name === parsed.entry);
    if (entry === undefined) {
      if (!entries.some((e) => e.name === parsed.entry)) return fail(`${qualified}: ${parsed.entry} names no entry of repos: (${entries.map((e) => e.name).join(", ")})`);
      return fail(unrunnableReason(parsed.entry, pathOf(parsed.entry), version) ?? `${parsed.entry}: ${unrunnable.find((u) => u.name === parsed.entry)?.reason ?? "not served"}`);
    }
    found = await findIn(entry, parsed.issue).catch(unanswered);
  } else found = await findAcross(repos, parsed.issue).catch(unanswered);
  // Entries the lookup set aside were not asked: an issue only their trackers hold is not found, and the message says why.
  const notAsked = parsed.entry === undefined && unrunnable.length > 0 ? `; not asked, as nothing runs there: ${unrunnable.map((u) => u.name).join(", ")}` : "";
  if ("error" in found) return fail(`${found.error}${notAsked}`);

  const { issue, listedBy } = found;
  const route = routeIssue(issue.labels, { listedBy, entries: [...repos, ...unrunnable.map(({ name }) => ({ name }))], home: true });
  if ("reason" in route) return fail(`${issue.ref}: ${route.reason}`);
  const name = route.to;
  const path = pathOf(name);
  // What the daemon would set aside is refused here, in its words: the two agree on what runs.
  const refusal = unrunnableReason(name, path, version);
  if (refusal !== undefined) return fail(refusal);
  const root = join(path, PROJECT_DIR);
  const own = [issue.id, ...(parsed.flow !== undefined ? ["--flow", parsed.flow] : []), ...(parsed.restart ? ["--restart"] : [])];
  // Picked through a shared tracker: the label chose the entry, so the line names the tracker it came from.
  const start = `${issue.ref}: running in ${name}${listedBy.shared ? ` (${listedBy.location.at})` : ""}`;
  if (resolve(root) === resolve(deps.root)) {
    if (listedBy.shared) deps.out(start);
    return deps.runHere(own);
  }
  const [command = "sous", ...prefix] = deps.engine;
  const runArgs = ["run", ...own];
  deps.out(`${start}: ${[...deps.engine, ...runArgs].join(" ")} in ${path}`);
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
