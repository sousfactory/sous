/**
 * Reading a project from disk: the run folders under `runsDir`, their
 * session and event log, the flow file, agent logs and the lock. The
 * executor overwrites `session.json` in place, so a read can catch it half
 * written; such a read is retried briefly before it counts as an error.
 */
import { existsSync, readdirSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  classifyLock,
  eventsFile,
  foldTimeline,
  isProcessAlive,
  listFlows,
  loadSession,
  loadSettings,
  lockPath,
  logDir,
  parseEvents,
  parseFlow,
  projectDirs,
  sessionFile,
  SETTINGS_FILE,
  topology,
  type LockInfo,
  type Session,
  type Timeline,
  type Topology,
} from "sous-factory/read";
import { deriveFlow, deriveRun, summarizeRun, type FlowView, type RunRow, type RunView } from "./model.js";

export type Project = {
  /** The project root, `.sous/`. */
  root: string;
  runsRoot: string;
  logsRoot: string;
  flowsRoot: string;
  stepsRoot: string;
  isAlive: (pid: number) => boolean;
};

export const openProject = (root: string, isAlive: (pid: number) => boolean = isProcessAlive): Project => {
  const dirs = projectDirs(root, loadSettings(join(root, SETTINGS_FILE)));
  return { root, runsRoot: dirs.runs, logsRoot: dirs.logs, flowsRoot: dirs.flows, stepsRoot: dirs.steps, isAlive };
};

/** The lock of a live `sous run`; a stale or unreadable lock is no live run. */
export const liveLock = async (project: Project): Promise<LockInfo | undefined> => {
  let raw: string | undefined;
  try {
    raw = await readFile(lockPath(project.root), "utf8");
  } catch {
    raw = undefined;
  }
  const status = classifyLock(raw, project.isAlive);
  return status.kind === "held" ? status.lock : undefined;
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A half-written session is a JSON syntax error; anything else is final. */
const readSession = async (path: string, retries = 3): Promise<Session | undefined> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await loadSession(path);
    } catch (error) {
      if (!(error instanceof SyntaxError) || attempt >= retries) throw error;
      await pause(40);
    }
  }
};

const readTimeline = async (path: string): Promise<Timeline> => {
  try {
    return foldTimeline(parseEvents(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runs: [], spans: [] };
    throw error;
  }
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Loader messages start with the absolute file; the view knows the issue, so keep the rest. */
const withoutPath = (text: string, path: string): string => (text.startsWith(`${path}: `) ? text.slice(path.length + 2) : text);

/** Every run folder's name: the issue id as the core wrote it; `listRows` orders them by activity. */
export const runIssues = (project: Project): string[] =>
  existsSync(project.runsRoot)
    ? readdirSync(project.runsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name)
        .sort()
    : [];

const updatedAt = async (project: Project, issue: string): Promise<string> => {
  const times = await Promise.all(
    [sessionFile(project.runsRoot, issue), eventsFile(project.runsRoot, issue)].map((f) => stat(f).then((s) => s.mtimeMs, () => 0)),
  );
  return new Date(Math.max(...times)).toISOString();
};

const NO_SESSION = "no session.json yet";

export const readRow = async (project: Project, issue: string, lock: LockInfo | undefined): Promise<RunRow> => {
  const updated = await updatedAt(project, issue);
  const file = sessionFile(project.runsRoot, issue);
  try {
    const session = await readSession(file);
    if (session === undefined) return { kind: "error", updatedAt: updated, issue, error: NO_SESSION };
    const timeline = await readTimeline(eventsFile(project.runsRoot, issue));
    return { kind: "run", updatedAt: updated, summary: summarizeRun(session, timeline, lock?.issue === session.issue) };
  } catch (error) {
    return { kind: "error", updatedAt: updated, issue, error: withoutPath(message(error), file) };
  }
};

/** Every run folder, most recently written first. */
export const listRows = async (project: Project): Promise<RunRow[]> => {
  const lock = await liveLock(project);
  const rows = await Promise.all(runIssues(project).map((issue) => readRow(project, issue, lock)));
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

const flowTopology = (project: Project, name: string): Topology | { error: string } => {
  try {
    return topology(parseFlow(join(project.flowsRoot, `${name}.yaml`)), project.stepsRoot);
  } catch (error) {
    return { error: message(error) };
  }
};

/** The flow names under `flowsDir`, without the extension. */
export const flowNames = (project: Project): string[] => listFlows(project.flowsRoot).map((f) => basename(f).replace(/\.ya?ml$/, ""));

/** A flow file as a preview; only a name `flowNames` lists is read, so no path reaches outside `flowsDir`. */
export const readFlow = (project: Project, name: string): FlowView | undefined =>
  flowNames(project).includes(name) ? deriveFlow(name, flowTopology(project, name)) : undefined;

export type RunRead = { kind: "ok"; view: RunView } | { kind: "missing" } | { kind: "error"; error: string };

export const readRun = async (project: Project, issue: string, options: { attempt?: number; scope?: string } = {}): Promise<RunRead> => {
  const file = sessionFile(project.runsRoot, issue);
  try {
    const session = await readSession(file);
    if (session === undefined) return existsSync(join(project.runsRoot, issue)) ? { kind: "error", error: NO_SESSION } : { kind: "missing" };
    const timeline = await readTimeline(eventsFile(project.runsRoot, issue));
    const lock = await liveLock(project);
    const view = deriveRun({
      session,
      timeline,
      topology: flowTopology(project, session.flow),
      live: lock?.issue === session.issue,
      ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
    });
    return { kind: "ok", view };
  } catch (error) {
    return { kind: "error", error: withoutPath(message(error), file) };
  }
};

/** Keeps a request inside `<logsDir>/<issue>/`. */
export const LOG_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.log$/;

export type LogRead = { kind: "ok"; text: string; start: number; size: number } | { kind: "missing" } | { kind: "invalid" };

/** The agent log from byte `from` on, so a live view can append what is new; a file shorter than `from` is read whole (`start` 0). */
export const readLog = async (project: Project, issue: string, name: string, from = 0): Promise<LogRead> => {
  if (!LOG_NAME.test(name) || name.includes("..")) return { kind: "invalid" };
  const path = join(logDir(project.logsRoot, issue), name);
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return { kind: "missing" };
  }
  try {
    const { size } = await handle.stat();
    const start = from > 0 && from <= size ? from : 0;
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return { kind: "ok", text: buffer.toString("utf8"), start, size };
  } finally {
    await handle.close();
  }
};
