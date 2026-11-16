/**
 * Reading a project from disk: the run folders under `runsDir`, their
 * session and event log, the flow file, agent logs and the locks. The
 * executor overwrites `session.json` in place, so a read can catch it half
 * written; such a read is retried briefly before it counts as an error.
 */
import { existsSync, readdirSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  eventsFile,
  foldTimeline,
  isProcessAlive,
  listFlows,
  liveLocks as readLiveLocks,
  loadSession,
  loadSettings,
  logDir,
  parseEvents,
  parseFlow,
  PROJECT_DIR,
  projectDirs,
  repoEntries,
  SCHEMA_VERSION,
  sessionFile,
  SETTINGS_FILE,
  topology,
  type LockInfo,
  type OutputEvent,
  type Session,
  type Timeline,
  type Topology,
} from "sous-factory/read";
import type { GitHubLookup } from "./github.js";
import { deriveFlow, deriveRun, summarizeRun, type ErrorRow, type FlowView, type RepoTag, type RunRow, type RunView } from "./model.js";

export type Project = {
  /** The project root, `.sous/`. */
  root: string;
  runsRoot: string;
  logsRoot: string;
  flowsRoot: string;
  stepsRoot: string;
  /** `uiPort` of `sous.yaml`: where `sous ui` listens unless `--port` says otherwise. */
  uiPort: number;
  isAlive: (pid: number) => boolean;
};

export const openProject = (root: string, isAlive: (pid: number) => boolean = isProcessAlive): Project => {
  const settings = loadSettings(join(root, SETTINGS_FILE));
  const dirs = projectDirs(root, settings);
  return { root, runsRoot: dirs.runs, logsRoot: dirs.logs, flowsRoot: dirs.flows, stepsRoot: dirs.steps, uiPort: settings.uiPort, isAlive };
};

/** A repository of the home project's `repos:` list, read as a project of its own; `github` asks `gh` in its checkout. */
export type RepoSource = RepoTag & { project: Project; github?: GitHubLookup };

/** The repositories `repos:` lists, each opened from its own `.sous/`; `undefined` without `repos:`. */
export const openRepos = (home: Project): RepoSource[] | undefined =>
  repoEntries(home.root, loadSettings(join(home.root, SETTINGS_FILE)))?.map(({ name, path }) => ({
    name,
    folder: basename(path),
    project: openProject(join(path, PROJECT_DIR), home.isAlive),
  }));

/** The locks of the live `sous run`s, one per issue; a stale or unreadable lock is no live run. */
export const liveLocks = (project: Project): Promise<LockInfo[]> => readLiveLocks(project.root, project.isAlive);

const holds = (locks: readonly LockInfo[], issue: string): boolean => locks.some((l) => l.issue === issue);

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

/** The folded timeline and the `output` events the fold leaves out. */
const readEvents = async (path: string): Promise<{ timeline: Timeline; outputs: OutputEvent[] }> => {
  try {
    const events = parseEvents(await readFile(path, "utf8"));
    return { timeline: foldTimeline(events), outputs: events.filter((e): e is OutputEvent => e.type === "output") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { timeline: { runs: [], spans: [] }, outputs: [] };
    throw error;
  }
};

const readTimeline = async (path: string): Promise<Timeline> => (await readEvents(path)).timeline;

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

export const readRow = async (project: Project, issue: string, locks: readonly LockInfo[]): Promise<RunRow> => {
  const updated = await updatedAt(project, issue);
  const file = sessionFile(project.runsRoot, issue);
  try {
    const session = await readSession(file);
    if (session === undefined) return { kind: "error", updatedAt: updated, issue, error: NO_SESSION };
    const timeline = await readTimeline(eventsFile(project.runsRoot, issue));
    return { kind: "run", updatedAt: updated, summary: summarizeRun(session, timeline, holds(locks, session.issue)) };
  } catch (error) {
    return { kind: "error", updatedAt: updated, issue, error: withoutPath(message(error), file), ...(await foreignFields(file)) };
  }
};

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * What a record on another schema version still says: the versions, and
 * the title, flow and branch where they are strings. Nothing for a record
 * on this version, or one that is no JSON object at all.
 */
const foreignFields = async (file: string): Promise<Pick<ErrorRow, "schema" | "title" | "flow" | "branch">> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const found = record.schemaVersion;
  if (typeof found !== "number" || found === SCHEMA_VERSION) return {};
  const fields = { title: text(record.title), flow: text(record.flow), branch: text(record.branch) };
  return {
    schema: { found, expected: SCHEMA_VERSION },
    ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
  };
};

const newestFirst = (rows: RunRow[]): RunRow[] => rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/** Every run folder, most recently written first. */
export const listRows = async (project: Project): Promise<RunRow[]> => {
  const locks = await liveLocks(project);
  return newestFirst(await Promise.all(runIssues(project).map((issue) => readRow(project, issue, locks))));
};

/** Every run folder of every listed repository in one list, most recently written first, each row tagged with its repository. */
export const listRepoRows = async (repos: readonly RepoSource[]): Promise<RunRow[]> => {
  const lists = await Promise.all(
    repos.map(async ({ name, folder, project }) => (await listRows(project)).map((row): RunRow => ({ ...row, repo: { name, folder } }))),
  );
  return newestFirst(lists.flat());
};

/** The live locks of every listed repository, each naming its repository. */
export const repoLiveLocks = async (repos: readonly RepoSource[]): Promise<(LockInfo & { repo: string })[]> =>
  (await Promise.all(repos.map(async ({ name, project }) => (await liveLocks(project)).map((lock) => ({ ...lock, repo: name }))))).flat();

/**
 * The project a request about `issue` reads: the home project without
 * `repos:`; with it, the repository `repo` names, or else the first one
 * holding a run folder for the issue. `undefined` when none fits.
 */
export const projectFor = (home: Project, repos: readonly RepoSource[] | undefined, issue: string, repo: string | undefined): Project | undefined => {
  if (repos === undefined) return home;
  if (repo !== undefined) return repos.find((r) => r.name === repo)?.project;
  return repos.find((r) => runIssues(r.project).includes(issue))?.project;
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
    const { timeline, outputs } = await readEvents(eventsFile(project.runsRoot, issue));
    const locks = await liveLocks(project);
    const view = deriveRun({
      session,
      timeline,
      outputs,
      topology: flowTopology(project, session.flow),
      live: holds(locks, session.issue),
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
