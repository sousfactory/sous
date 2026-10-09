/**
 * Derived completeness of timeline records. Events are appended as things
 * happen, so a span or iteration without an end was either still running or
 * cut off by a crash; its run segment tells which.
 */
import type { HistoryEntry } from "../exec/scope.js";
import type { IterationSpan, RunSegment, Span, Timeline } from "./timeline.js";

/**
 * `complete`: ended. `in-progress`: not ended, its run segment still open.
 * `incomplete`: not ended, its run segment closed or missing (a span
 * recorded outside a run, or naming a segment the log does not have).
 * `untracked`: a history entry with no span in the log.
 */
export type RecordStatus = "complete" | "in-progress" | "incomplete" | "untracked";

const runOf = (timeline: Timeline, span: Span): RunSegment | undefined => timeline.runs.find((r) => r.id === span.runId);

const unended = (timeline: Timeline, span: Span): RecordStatus => {
  const run = runOf(timeline, span);
  return run !== undefined && run.endedAt === undefined ? "in-progress" : "incomplete";
};

/** Complete once ended, whatever the outcome; a crash shows as the `crashed` outcome, not here. */
export const runStatus = (run: RunSegment): RecordStatus => (run.endedAt === undefined ? "in-progress" : "complete");

export const spanStatus = (span: Span, timeline: Timeline): RecordStatus => (span.endedAt !== undefined ? "complete" : unended(timeline, span));

/** Complete when its agent call and its eval, whichever it has, both ended. */
export const iterationStatus = (iter: IterationSpan, span: Span, timeline: Timeline): RecordStatus => {
  const parts = [iter.agent, iter.eval].filter((p) => p !== undefined);
  return parts.length > 0 && parts.every((p) => p.endedAt !== undefined) ? "complete" : unended(timeline, span);
};

/** History and log share no id; the span is matched by step and close time. */
export const spanOf = (entry: HistoryEntry, timeline: Timeline): Span | undefined =>
  timeline.spans.find((s) => s.step === entry.step && s.endedAt === entry.at);

export const historyStatus = (entry: HistoryEntry, timeline: Timeline): RecordStatus => {
  const span = spanOf(entry, timeline);
  return span === undefined ? "untracked" : spanStatus(span, timeline);
};

export type EstimatedEnd = { at: string; estimated: true };

/**
 * Where an incomplete span probably ended: the start of the next span in the
 * same run, else the end of its run segment. Undefined for any other status.
 */
export const estimatedEnd = (span: Span, timeline: Timeline): EstimatedEnd | undefined => {
  if (spanStatus(span, timeline) !== "incomplete") return undefined;
  const sameRun = timeline.spans.filter((s) => s.runId === span.runId);
  const next = sameRun[sameRun.findIndex((s) => s.id === span.id) + 1];
  const at = next?.startedAt ?? runOf(timeline, span)?.endedAt;
  return at === undefined ? undefined : { at, estimated: true };
};
