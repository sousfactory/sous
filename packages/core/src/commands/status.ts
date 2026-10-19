/**
 * `sous status <issue>`: session facts and the timeline, as plain text.
 * Reads only `<runsDir>/<issue>/`, never the tracker, so it works offline.
 */
import { join } from "node:path";
import { createFileEventLog } from "../adapters/eventlog.js";
import { logDir } from "../adapters/logs.js";
import { loadSettings, projectDirs, SETTINGS_FILE } from "../config/settings.js";
import { stepsOf, type HistoryEntry, type Session } from "../exec/scope.js";
import { eventsFile, runDir, sessionFile } from "../session/paths.js";
import { estimatedEnd, historyStatus, spanStatus, type RecordStatus } from "../session/status.js";
import { loadSession } from "../session/store.js";
import { foldTimeline, spansByLane, visitLanes, type IterationSpan, type RunSegment, type Span, type Timeline } from "../session/timeline.js";
import { iterationOf, logTail } from "../session/update.js";

export type StatusDeps = {
  /** The project root (`.sous/`). */
  root: string;
  out: (line: string) => void;
  err: (line: string) => void;
};

export type StatusPaths = { runDir: string; logDir: string };

export const USAGE = "usage: sous status <issue>";

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
  const parts = [...(agent !== undefined ? [`agent ${formatDuration(agent)}`] : []), ...(evals !== undefined ? [`eval ${formatDuration(evals)}`] : [])];
  const breakdown = span.iterations.length === 0 ? "" : `  (${span.iterations.length} iter${parts.length > 0 ? `: ${parts.join(", ")}` : ""})`;
  return `${MARKS[status]} ${clockTime(span.startedAt)}  ${span.step} ${shown}  ${result}${breakdown}`;
};

const untrackedLine = (entry: HistoryEntry): string => `${MARKS.untracked} ${entry.step}  ${entry.ok ? "ok" : "fail"}`;

const runLine = (run: RunSegment, previous: RunSegment | undefined): string => {
  const idle = previous?.endedAt !== undefined ? between(previous.endedAt, run.startedAt) : undefined;
  const resumed = run.resumedFrom !== undefined ? `  resumed at ${run.resumedFrom.step}` : "";
  const spec = run.spec === "issue" ? "  spec: issue" : "";
  return `run ${run.id}  ${clockTime(run.startedAt)}  ${run.outcome ?? "running"}${idle !== undefined ? `  (idle ${formatDuration(idle)})` : ""}${resumed}${spec}`;
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

export const renderStatus = (session: Session, timeline: Timeline, paths: StatusPaths): string => {
  const current = session.current;
  const steps = stepsOf(session);
  const facts: string[][] = [
    ["issue", session.issue],
    ["flow", session.flow],
    ["branch", session.branch],
    ["current", current],
    ["previous", session.previous ?? "-"],
    ["work", session.work],
    ["visits", String(steps[current]?.visits ?? 0)],
    ["iteration", String(iterationOf(session, current))],
    ["blocked", session.blocked ? "yes" : "no"],
    ["transitions", String(session.history.length)],
    ["spec", session.specDir === "" ? "-" : session.specDir],
    ["run", paths.runDir],
    ["logs", paths.logDir],
  ];
  const lines = table(facts);

  const progress = Object.entries(session.workProgress);
  if (progress.length > 0) {
    lines.push("", "work progress");
    const rows = progress.map(([id, record]) => [id, record.state, record.commits.length > 0 ? record.commits.map((c) => c.slice(0, 7)).join(", ") : "-"]);
    lines.push(...indent(table([["work", "state", "commits"], ...rows]).join("\n")));
  }

  // The last eval: the record of the step just left, when it is in the current scope.
  const last = session.previous === null ? undefined : steps[session.previous];
  if (session.previous !== null && last !== undefined) {
    lines.push("", `last eval  ${session.previous}: ${last.ok ? "ok" : "FAILED"}`);
    const tail = logTail(last.log);
    if (tail.length > 0) lines.push(...indent(tail));
  }

  const rendered = renderTimeline(session, timeline);
  if (rendered.length > 0) lines.push("", ...rendered);

  return lines.join("\n");
};

export const statusCommand = async (args: readonly string[], deps: StatusDeps): Promise<number> => {
  const issue = (args[0] ?? "").replace(/^#/, "");
  if (args.length !== 1 || issue === "") {
    deps.err(USAGE);
    return 2;
  }
  const { runs, logs } = projectDirs(deps.root, loadSettings(join(deps.root, SETTINGS_FILE)));
  const session = await loadSession(sessionFile(runs, issue));
  if (session === undefined) {
    deps.err(`sous status: no session for ${issue}`);
    return 1;
  }
  const timeline = foldTimeline(await createFileEventLog(eventsFile(runs, issue)).readAll());
  deps.out(renderStatus(session, timeline, { runDir: runDir(runs, issue), logDir: logDir(logs, issue) }));
  return 0;
};
