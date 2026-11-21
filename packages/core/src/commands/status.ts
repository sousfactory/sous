/**
 * `sous status [<issue>] [--json]`. With an issue: session facts and the
 * timeline, read from `<runsDir>/<issue>/` alone, never the tracker, so it
 * works offline. Without one: the factory overview, the entries `sous watch`
 * would serve, their trackers, the daemon, the run viewer and the issues that
 * need attention; only the tracker parts go online, and a tracker that does
 * not answer is a note, never a failure. Neither form writes anything.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { createFileEventLog } from "../adapters/eventlog.js";
import { logDir } from "../adapters/logs.js";
import { worktreePathFor } from "../adapters/sandbox.js";
import { ENGINE_VERSION } from "../config/engine.js";
import { repoEntries, routeIssue } from "../config/repos.js";
import { loadSettings, projectDirs, requiredTracker, SETTINGS_FILE } from "../config/settings.js";
import { stepsOf, type HistoryEntry, type Session } from "../exec/scope.js";
import { overviewLookupOf, type BrokenEntry, type Lookup, type LookupEntry } from "../lookup.js";
import { isIssueNotFound } from "../ports/tracker.js";
import { eventsFile, runDir, sessionFile } from "../session/paths.js";
import { formatCost } from "../session/cost.js";
import { estimatedEnd, historyStatus, spanStatus, type RecordStatus } from "../session/status.js";
import { loadSession } from "../session/store.js";
import { foldTimeline, spansByLane, visitLanes, type IterationSpan, type RunSegment, type Span, type Timeline } from "../session/timeline.js";
import { iterationOf, logTail } from "../session/update.js";
import { classifyLock, isProcessAlive, liveLocks } from "./lock.js";
import { watchLockPath } from "./watch.js";

export type StatusDeps = {
  /** The project root (`.sous/`). */
  root: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** The entries the overview covers; `overviewLookupOf(root)`, the lookup `sous watch` serves with the trackers that did not build set aside, unless injected. */
  lookup?: () => Promise<Lookup>;
  isAlive?: (pid: number) => boolean;
  /** Whether something answers at `url`; an HTTP GET with a half-second timeout unless injected. */
  probe?: (url: string) => Promise<boolean>;
  engineVersion?: string;
  now?: () => number;
};

export type StatusPaths = { runDir: string; logDir: string };

export const USAGE = "usage: sous status [<issue>] [--json]";

const table = (rows: string[][]): string[] => {
  const widths = rows.reduce<number[]>((acc, row) => row.map((cell, i) => Math.max(acc[i] ?? 0, cell.length)), []);
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd());
};

const indent = (text: string, by = "  "): string[] => text.split("\n").map((l) => `${by}${l}`);

/** `42s`, `4m12s`, `2h03m`. */
export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${pad(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h${pad(Math.floor((seconds % 3600) / 60))}m`;
};

const between = (start: string, end: string | undefined): number | undefined => (end === undefined ? undefined : Date.parse(end) - Date.parse(start));

/** `HH:MM:SS` of an ISO timestamp, in UTC like the timestamps themselves. */
const clockTime = (iso: string): string => iso.slice(11, 19);

const total = (iterations: readonly IterationSpan[], part: (i: IterationSpan) => { startedAt: string; endedAt?: string } | undefined) => {
  const durations = iterations.flatMap((i) => {
    const p = part(i);
    const ms = p === undefined ? undefined : between(p.startedAt, p.endedAt);
    return ms === undefined ? [] : [ms];
  });
  return durations.length === 0 ? undefined : durations.reduce((a, b) => a + b, 0);
};

const MARKS: Record<RecordStatus, string> = { complete: "✓", "in-progress": "…", incomplete: "?", untracked: "-" };

export const TIMELINE_LEGEND = "✓ complete  … in progress  ? incomplete (end estimated)  - untracked";

/** `work 14`. */
export const laneName = (scope: string): string => `work ${scope}`;

const spanLine = (span: Span, timeline: Timeline): string => {
  const status = spanStatus(span, timeline);
  const estimate = estimatedEnd(span, timeline);
  const duration = between(span.startedAt, span.endedAt ?? estimate?.at);
  const shown = duration === undefined ? "running" : estimate !== undefined ? `~${formatDuration(duration)}` : formatDuration(duration);
  const result =
    status === "incomplete"
      ? `incomplete${estimate !== undefined ? ` (est. end ${clockTime(estimate.at)})` : ""}`
      : span.endedAt === undefined
        ? "open"
        : span.ok === true
          ? "ok"
          : "fail";
  const agent = total(span.iterations, (i) => i.agent);
  const evals = total(span.iterations, (i) => i.eval);
  const cost = formatCost(span.costUsd, span.costUnknown);
  const parts = [
    ...(agent !== undefined ? [`agent ${formatDuration(agent)}`] : []),
    ...(evals !== undefined ? [`eval ${formatDuration(evals)}`] : []),
    ...(cost !== "" ? [`cost ${cost}`] : []),
  ];
  const breakdown = span.iterations.length === 0 ? "" : `  (${span.iterations.length} iter${parts.length > 0 ? `: ${parts.join(", ")}` : ""})`;
  return `${MARKS[status]} ${clockTime(span.startedAt)}  ${span.step} ${shown}  ${result}${breakdown}`;
};

const untrackedLine = (entry: HistoryEntry): string => `${MARKS.untracked} ${entry.step}  ${entry.ok ? "ok" : "fail"}`;

const runLine = (run: RunSegment, previous: RunSegment | undefined): string => {
  const idle = previous?.endedAt !== undefined ? between(previous.endedAt, run.startedAt) : undefined;
  const resumed = run.resumedFrom !== undefined ? `  resumed at ${run.resumedFrom.step}` : "";
  const spec = run.spec === "issue" ? "  spec: issue" : "";
  const cost = formatCost(run.costUsd, run.costUnknown);
  return `run ${run.id}  ${clockTime(run.startedAt)}  ${run.outcome ?? "running"}${cost !== "" ? `  cost ${cost}` : ""}${idle !== undefined ? `  (idle ${formatDuration(idle)})` : ""}${resumed}${spec}`;
};

const lanes = (spans: Span[], timeline: Timeline, laneOf: ReadonlyMap<string, string>): string[] =>
  spansByLane(spans, laneOf).flatMap((lane) => [`    ${laneName(lane.scope)}`, ...lane.spans.map((span) => `      ${spanLine(span, timeline)}`)]);

/**
 * Spans under their run segment, one lane per work item. Spans whose run
 * segment is not in the log go under `run -`; transitions without a span
 * under `untracked`.
 */
export const renderTimeline = (session: Session, timeline: Timeline): string[] => {
  if (timeline.runs.length === 0 && timeline.spans.length === 0) return [];
  const untracked = session.history.filter((h) => historyStatus(h, timeline) === "untracked");
  const untrackedGroup = untracked.length > 0 ? ["  untracked", ...untracked.map((h) => `    ${untrackedLine(h)}`)] : [];
  const laneOf = visitLanes(timeline.spans);
  const known = new Set(timeline.runs.map((r) => r.id));
  const orphans = timeline.spans.filter((span) => !known.has(span.runId));
  const groups: [string, Span[]][] = [
    ...(orphans.length > 0 ? [["run -", orphans] as [string, Span[]]] : []),
    ...timeline.runs.map((run, i): [string, Span[]] => [runLine(run, timeline.runs[i - 1]), timeline.spans.filter((span) => span.runId === run.id)]),
  ];
  return ["timeline", `  ${TIMELINE_LEGEND}`, ...untrackedGroup, ...groups.flatMap(([header, spans]) => [`  ${header}`, ...lanes(spans, timeline, laneOf)])];
};

/** The per-issue facts as `--json` prints them; `renderStatus` prints the same, as a table and the timeline. */
export type IssueStatus = {
  issue: string;
  flow: string;
  branch: string;
  current: string;
  previous: string | null;
  work: string;
  visits: number;
  iteration: number;
  blocked: boolean;
  transitions: number;
  spec: string | null;
  run: string;
  logs: string;
  engine: string | null;
  workProgress: { work: string; state: "open" | "done"; commits: string[] }[];
  lastEval: { step: string; ok: boolean; log: string } | null;
  runs: RunSegment[];
  spans: Span[];
};

export const statusOf = (session: Session, timeline: Timeline, paths: StatusPaths): IssueStatus => {
  const current = session.current;
  const steps = stepsOf(session);
  // The last eval: the record of the step just left, when it is in the current scope.
  const last = session.previous === null ? undefined : steps[session.previous];
  return {
    issue: session.issue,
    flow: session.flow,
    branch: session.branch,
    current,
    previous: session.previous,
    work: session.work,
    visits: steps[current]?.visits ?? 0,
    iteration: iterationOf(session, current),
    blocked: session.blocked,
    transitions: session.history.length,
    spec: session.specDir === "" ? null : session.specDir,
    run: paths.runDir,
    logs: paths.logDir,
    engine: session.engine ?? null,
    workProgress: Object.entries(session.workProgress).map(([work, record]) => ({ work, state: record.state, commits: record.commits })),
    lastEval: session.previous !== null && last !== undefined ? { step: session.previous, ok: last.ok, log: last.log } : null,
    runs: timeline.runs,
    spans: timeline.spans,
  };
};

export const renderStatus = (session: Session, timeline: Timeline, paths: StatusPaths): string => {
  const status = statusOf(session, timeline, paths);
  const facts: string[][] = [
    ["issue", status.issue],
    ["flow", status.flow],
    ["branch", status.branch],
    ["current", status.current],
    ["previous", status.previous ?? "-"],
    ["work", status.work],
    ["visits", String(status.visits)],
    ["iteration", String(status.iteration)],
    ["blocked", status.blocked ? "yes" : "no"],
    ["transitions", String(status.transitions)],
    ["spec", status.spec ?? "-"],
    ["run", status.run],
    ["logs", status.logs],
    ["engine", status.engine ?? "-"],
  ];
  const lines = table(facts);

  if (status.workProgress.length > 0) {
    lines.push("", "work progress");
    const rows = status.workProgress.map(({ work, state, commits }) => [work, state, commits.length > 0 ? commits.map((c) => c.slice(0, 7)).join(", ") : "-"]);
    lines.push(...indent(table([["work", "state", "commits"], ...rows]).join("\n")));
  }

  if (status.lastEval !== null) {
    lines.push("", `last eval  ${status.lastEval.step}: ${status.lastEval.ok ? "ok" : "FAILED"}`);
    const tail = logTail(status.lastEval.log);
    if (tail.length > 0) lines.push(...indent(tail));
  }

  const rendered = renderTimeline(session, timeline);
  if (rendered.length > 0) lines.push("", ...rendered);

  return lines.join("\n");
};

/** The states of the overview's rows, in the order the table lists them. */
export const ROW_STATES = ["running", "blocked", "crashed", "interrupted", "ready"] as const;

export type RowState = (typeof ROW_STATES)[number];

export type OverviewRun = {
  issue: string;
  /** From the tracker; null when it did not answer or holds no such issue. */
  title: string | null;
  state: Exclude<RowState, "ready">;
  /** The session's current step; null for a live lock whose run has written no session yet. */
  step: string | null;
  /** When the state began (ISO): a running run's open span, else its last run's end; null when nothing recorded it. */
  since: string | null;
  branch: string | null;
  worktree: string | null;
};

export type OverviewEntry = {
  name: string;
  /** The checkout. */
  path: string;
  /** Null for an entry set aside, whose settings are not read, and for one whose settings did not load. */
  tracker: { type: string; location: string; shared: boolean } | null;
  /** Why `sous watch` sets the entry aside, or null. */
  unrunnable: string | null;
  runs: OverviewRun[];
  /**
   * Open issues carrying `<labels>:ready` that route here and are neither
   * running nor done: those without a run, and those handed back after a
   * block, a crash or an interrupt, with their session's branch and worktree.
   */
  ready: { issue: string; title: string; branch: string | null; worktree: string | null }[];
  /** Runs at `done`: counted, not listed. */
  done: number;
  /**
   * Set when the tracker was not built or did not answer (its titles null,
   * its ready issues missing), or did not give some titles (those null).
   */
  note: string | null;
};

export type Overview = {
  mode: "single" | "home";
  engine: string;
  entries: OverviewEntry[];
  daemon: { running: boolean; pid: number | null; since: string | null; stale: boolean };
  ui: { port: number; url: string; up: boolean };
};

/** The latest time a run segment recorded: its end, else its spans' last activity. */
const segmentEnd = (run: RunSegment, spans: readonly Span[]): string =>
  run.endedAt ??
  spans
    .filter((span) => span.runId === run.id)
    .flatMap((span) => [span.startedAt, span.endedAt])
    .filter((t): t is string => t !== undefined)
    .reduce((latest, t) => (t > latest ? t : latest), run.startedAt);

type SessionState = { state: OverviewRun["state"] | "done"; since: string | null };

/**
 * A session's state: running under a live lock (`livePid`), done at `done`,
 * else its last run's outcome; a last run that never ended without a live
 * lock crashed, as does a session with no run recorded that is not blocked.
 * A running run's since is that of the lock holder's own segment, the last
 * one if it has not ended and its `run.start` names the lock's pid; before
 * the holder wrote `run.start` it is null, never the previous run's start.
 */
const stateOf = (session: Session, timeline: Timeline, livePid: number | undefined): SessionState => {
  const last = timeline.runs.at(-1);
  if (livePid !== undefined) {
    const own = last !== undefined && last.endedAt === undefined && last.pid === livePid ? last : undefined;
    if (own === undefined) return { state: "running", since: null };
    const open = timeline.spans.filter((span) => span.runId === own.id && span.endedAt === undefined).at(-1);
    return { state: "running", since: open?.startedAt ?? own.startedAt };
  }
  if (session.current === "done") return { state: "done", since: null };
  if (last === undefined) return { state: session.blocked ? "blocked" : "crashed", since: null };
  const outcome = last.outcome ?? "crashed";
  return { state: outcome, since: segmentEnd(last, timeline.spans) };
};

const sessionsOf = async (runsRoot: string): Promise<{ session: Session; timeline: Timeline }[]> => {
  let names: string[];
  try {
    names = await readdir(runsRoot);
  } catch {
    return [];
  }
  const found = await Promise.all(
    names.map(async (name) => {
      try {
        const session = await loadSession(sessionFile(runsRoot, name));
        if (session === undefined) return [];
        return [{ session, timeline: foldTimeline(await createFileEventLog(eventsFile(runsRoot, session.issue)).readAll()) }];
      } catch {
        // A session another engine wrote, or one caught half written: `sous status <issue>` names the problem.
        return [];
      }
    }),
  );
  return found.flat();
};

const byIssue = (a: { issue: string }, b: { issue: string }): number => a.issue.localeCompare(b.issue, undefined, { numeric: true });

type EntryRuns = { runs: OverviewRun[]; done: number; doneIssues: Set<string> };

/** The runs of the entry whose project root is `root`, from its runs folder and its live locks, in the table's order. */
const runsOf = async (root: string, repoRoot: string, runsRoot: string, isAlive: (pid: number) => boolean): Promise<EntryRuns> => {
  const live = new Map((await liveLocks(root, isAlive)).map((l) => [l.issue, l.pid]));
  const sessions = await sessionsOf(runsRoot);
  const runs: OverviewRun[] = [];
  const doneIssues = new Set<string>();
  for (const { session, timeline } of sessions) {
    const { state, since } = stateOf(session, timeline, live.get(session.issue));
    if (state === "done") doneIssues.add(session.issue);
    else runs.push({ issue: session.issue, title: null, state, step: session.current, since, branch: session.branch, worktree: worktreePathFor(repoRoot, session.branch) });
  }
  // A run that holds its lock but has not written its session yet.
  for (const issue of live.keys()) if (!sessions.some(({ session }) => session.issue === issue)) runs.push({ issue, title: null, state: "running", step: null, since: null, branch: null, worktree: null });
  // In the table's order, so a reader of the JSON can keep it: by state, then by issue.
  runs.sort((a, b) => ROW_STATES.indexOf(a.state) - ROW_STATES.indexOf(b.state) || byIssue(a, b));
  return { runs, done: doneIssues.size, doneIssues };
};

/** A run that `<labels>:ready` hands back to the daemon: it ended blocked, crashed or interrupted. */
const handedBack = (run: OverviewRun): boolean => run.state !== "running";

const entryOf = async (entry: LookupEntry, lookup: Lookup, isAlive: (pid: number) => boolean): Promise<OverviewEntry> => {
  const settings = loadSettings(join(entry.root, SETTINGS_FILE));
  const { labels } = requiredTracker(settings, join(entry.root, SETTINGS_FILE));
  const { runs, done, doneIssues } = await runsOf(entry.root, entry.repoRoot, projectDirs(entry.root, settings).runs, isAlive);
  const result: OverviewEntry = {
    name: entry.name,
    path: entry.repoRoot,
    tracker: { type: entry.location.type, location: entry.location.at, shared: entry.shared },
    unrunnable: null,
    runs,
    ready: [],
    done,
    note: null,
  };
  let listed;
  try {
    listed = await entry.tracker.list({ labels: [`${labels}:ready`] });
  } catch {
    result.note = `tracker ${entry.location.at} did not answer; ready issues not shown`;
    return result;
  }
  const others = [...lookup.repos, ...lookup.unrunnable.map(({ name }) => ({ name })), ...(lookup.broken ?? []).map((b) => b.lister ?? { name: b.name })];
  const ready = listed.filter((issue) => {
    const route = routeIssue(issue.labels, { listedBy: entry, entries: others, home: lookup.listed });
    const run = runs.find((r) => r.issue === issue.id);
    return "to" in route && route.to === entry.name && !doneIssues.has(issue.id) && (run === undefined || handedBack(run));
  });
  result.ready = ready.map((issue) => {
    const run = runs.find((r) => r.issue === issue.id);
    return { issue: issue.id, title: issue.title, branch: run?.branch ?? null, worktree: run?.worktree ?? null };
  });
  result.runs = runs.filter((r) => !ready.some((issue) => issue.id === r.issue));
  let missed = false;
  for (const run of result.runs) {
    try {
      run.title = (await entry.tracker.getIssue(run.issue)).title;
    } catch (error) {
      if (!isIssueNotFound(error)) missed = true;
    }
  }
  if (missed) result.note = `tracker ${entry.location.at} did not answer for some issues; their titles not shown`;
  return result;
};

/** An entry whose tracker did not build: its runs with null titles when its settings loaded, none when they did not, and the note. */
const brokenEntryOf = async (entry: BrokenEntry, isAlive: (pid: number) => boolean): Promise<OverviewEntry> => {
  const note = `tracker of ${entry.name} not built: ${entry.reason}; ready issues not shown`;
  const base = { name: entry.name, path: entry.repoRoot, unrunnable: null, ready: [], note };
  if (entry.lister === undefined) return { ...base, tracker: null, runs: [], done: 0 };
  const { location, shared } = entry.lister;
  const { runs, done } = await runsOf(entry.root, entry.repoRoot, projectDirs(entry.root, loadSettings(join(entry.root, SETTINGS_FILE))).runs, isAlive);
  return { ...base, tracker: { type: location.type, location: location.at, shared }, runs, done };
};

/** Whether something answers an HTTP GET at `url` within half a second. */
export const probeHttp = (url: string): Promise<boolean> =>
  new Promise((resolve) => {
    const req = request(url, { method: "GET", timeout: 500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });

const daemonOf = async (root: string, isAlive: (pid: number) => boolean): Promise<Overview["daemon"]> => {
  const path = watchLockPath(root);
  const lock = classifyLock(await readFile(path, "utf8").catch(() => undefined), isAlive);
  switch (lock.kind) {
    case "free":
      return { running: false, pid: null, since: null, stale: false };
    case "held":
      return { running: true, pid: lock.lock.pid, since: (await stat(path)).mtime.toISOString(), stale: false };
    case "stale":
      return { running: false, pid: lock.lock.pid, since: null, stale: true };
    case "unreadable":
      return { running: false, pid: null, since: null, stale: true };
  }
};

export type OverviewDeps = Required<Pick<StatusDeps, "lookup" | "isAlive" | "probe" | "engineVersion">> & { root: string };

/** The factory overview, as `--json` prints it; `renderOverview` prints the same as text. */
export const overviewOf = async (deps: OverviewDeps): Promise<Overview> => {
  const { root, isAlive } = deps;
  const settings = loadSettings(join(root, SETTINGS_FILE));
  const lookup = await deps.lookup();
  const loaded = await Promise.all([
    ...lookup.repos.map((entry) => entryOf(entry, lookup, isAlive)),
    ...(lookup.broken ?? []).map((entry) => brokenEntryOf(entry, isAlive)),
  ]);
  const listed = repoEntries(root, settings);
  // In the order `repos:` lists them, those set aside in their place.
  const entries =
    listed === undefined
      ? loaded
      : listed.flatMap(({ name, path }): OverviewEntry[] => {
          const found = loaded.find((e) => e.name === name);
          if (found !== undefined) return [found];
          const aside = lookup.unrunnable.find((u) => u.name === name);
          return aside === undefined ? [] : [{ name, path, tracker: null, unrunnable: aside.reason, runs: [], ready: [], done: 0, note: null }];
        });
  const url = `http://127.0.0.1:${settings.uiPort}/`;
  return {
    mode: lookup.listed ? "home" : "single",
    engine: deps.engineVersion,
    entries,
    daemon: await daemonOf(root, isAlive),
    ui: { port: settings.uiPort, url, up: await deps.probe(url) },
  };
};

/** `2026-11-21 09:00:00 UTC`. */
const wallTime = (iso: string): string => `${iso.slice(0, 10)} ${clockTime(iso)} UTC`;

const trackerLine = (tracker: NonNullable<OverviewEntry["tracker"]>): string => `tracker ${tracker.type} ${tracker.location}, shared: ${tracker.shared}`;

export const renderOverview = (overview: Overview, now: number): string => {
  const home = overview.mode === "home";
  const { entries } = overview;
  const lines: string[] = [];
  if (home) {
    lines.push(`home repository, ${entries.length} ${entries.length === 1 ? "entry" : "entries"}: ${entries.map((e) => e.name).join(", ")}`, `engine ${overview.engine}`);
    lines.push(...indent(table(entries.map((e) => [e.name, e.tracker !== null ? trackerLine(e.tracker) : e.unrunnable !== null ? `set aside: ${e.unrunnable}` : "tracker not built"])).join("\n")));
  } else {
    const entry = entries[0];
    lines.push(`single repository ${entry?.name ?? "-"}`, `engine ${overview.engine}`);
    if (entry?.tracker != null) lines.push(trackerLine(entry.tracker));
  }
  const { daemon, ui } = overview;
  lines.push(
    daemon.running
      ? `daemon: running (pid ${daemon.pid}, since ${daemon.since === null ? "-" : wallTime(daemon.since)})`
      : daemon.stale
        ? `daemon: none (stale ${join("locks", "watch.pid")}${daemon.pid !== null ? `, pid ${daemon.pid} is not running` : ", unreadable"})`
        : "daemon: none",
  );
  lines.push(ui.up ? `ui: ${ui.url.replace(/\/$/, "")}` : "ui: not running (sous ui)");

  const since = (iso: string | null): string => (iso === null ? "-" : formatDuration(now - Date.parse(iso)));
  const rows = entries.flatMap((e) => [
    ...e.runs.map((r) => ({ entry: e.name, issue: r.issue, title: r.title ?? "-", state: r.state as RowState, step: r.step ?? "-", since: since(r.since) })),
    ...e.ready.map((r) => ({ entry: e.name, issue: r.issue, title: r.title, state: "ready" as RowState, step: "-", since: "-" })),
  ]);
  const order = (row: (typeof rows)[number]): number => ROW_STATES.indexOf(row.state);
  rows.sort((a, b) => order(a) - order(b) || entries.findIndex((e) => e.name === a.entry) - entries.findIndex((e) => e.name === b.entry) || byIssue(a, b));
  lines.push("");
  if (rows.length === 0) lines.push("no issue needs attention");
  else {
    const header = [...(home ? ["entry"] : []), "issue", "title", "state", "step", "since"];
    lines.push(...table([header, ...rows.map((r) => [...(home ? [r.entry] : []), r.issue, r.title, r.state, r.step, r.since])]));
  }
  const done = entries.reduce((n, e) => n + e.done, 0);
  if (done > 0) lines.push(`${done} done, see sous ui`);
  lines.push(...new Set(entries.flatMap((e) => (e.note === null ? [] : [e.note]))));
  return lines.join("\n");
};

type StatusArgs = { issue?: string; json: boolean };

const parseStatusArgs = (args: readonly string[]): StatusArgs | undefined => {
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  if (rest.length > 1 || args.filter((a) => a === "--json").length > 1) return undefined;
  if (rest.length === 0) return { json };
  const issue = rest[0]!.replace(/^#/, "");
  return issue === "" || issue.startsWith("-") ? undefined : { issue, json };
};

const issueStatus = async (issue: string, json: boolean, deps: StatusDeps): Promise<number> => {
  const { runs, logs } = projectDirs(deps.root, loadSettings(join(deps.root, SETTINGS_FILE)));
  const session = await loadSession(sessionFile(runs, issue));
  if (session === undefined) {
    deps.err(`sous status: no session for ${issue}`);
    return 1;
  }
  const timeline = foldTimeline(await createFileEventLog(eventsFile(runs, issue)).readAll());
  const paths = { runDir: runDir(runs, issue), logDir: logDir(logs, issue) };
  deps.out(json ? JSON.stringify(statusOf(session, timeline, paths), null, 2) : renderStatus(session, timeline, paths));
  return 0;
};

export const statusCommand = async (args: readonly string[], deps: StatusDeps): Promise<number> => {
  const parsed = parseStatusArgs(args);
  if (parsed === undefined) {
    deps.err(USAGE);
    return 2;
  }
  if (parsed.issue !== undefined) return issueStatus(parsed.issue, parsed.json, deps);
  const overview = await overviewOf({
    root: deps.root,
    lookup: deps.lookup ?? (() => overviewLookupOf(deps.root)),
    isAlive: deps.isAlive ?? isProcessAlive,
    probe: deps.probe ?? probeHttp,
    engineVersion: deps.engineVersion ?? ENGINE_VERSION,
  });
  deps.out(parsed.json ? JSON.stringify(overview, null, 2) : renderOverview(overview, (deps.now ?? Date.now)()));
  return 0;
};
