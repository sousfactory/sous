import { describe, expect, it } from "vitest";
import type { Event } from "../../src/session/events.js";
import { estimatedEnd, iterationStatus, runStatus, spanStatus } from "../../src/session/status.js";
import { trail89 } from "../helpers/trail.js";
import { foldTimeline, spansByLane, visitLanes, type Span, type Timeline } from "../../src/session/timeline.js";

const iso = (m: number, s = 0) => new Date(Date.UTC(2026, 9, 2, 9, m, s)).toISOString();
const runStart = (runId: string, m: number, extra: Partial<Extract<Event, { type: "run.start" }>> = {}): Event => ({
  type: "run.start",
  at: iso(m),
  runId,
  pid: 1,
  host: "h",
  sha: "x",
  flow: "feature",
  ...extra,
});

/**
 * Run r1: build (one agent call, eval, closed), then a review span that was
 * never closed, then a review whose eval was cut off (the process died).
 * Run r2 resumed at review and is still in its first agent call.
 */
export const scripted = (): Event[] => [
  runStart("r1", 1),
  { type: "span.open", at: iso(2), runId: "r1", spanId: "r1-1", step: "build", scope: "14" },
  { type: "iteration.agent.start", at: iso(2), spanId: "r1-1", n: 1, kind: "claude", model: "b" },
  { type: "iteration.agent.end", at: iso(5), spanId: "r1-1", n: 1, outcome: "ok", commits: ["c1"], sessionId: "s1", logPath: "/l/build-1.log" },
  { type: "iteration.eval.start", at: iso(5), spanId: "r1-1", n: 1 },
  { type: "iteration.eval.end", at: iso(6), spanId: "r1-1", n: 1, ok: true },
  { type: "output", at: iso(6), spanId: "r1-1", step: "build", iteration: 1, scope: "14", sessionId: "s1", envelope: { summary: "", commits: ["c1"], output: {} }, eval: { ok: true, logTail: "" } },
  { type: "span.close", at: iso(6), spanId: "r1-1", ok: true, next: "review", headSha: "c1" },
  { type: "span.open", at: iso(6), runId: "r1", spanId: "r1-2", step: "review", scope: "14" },
  { type: "span.open", at: iso(8), runId: "r1", spanId: "r1-3", step: "review", scope: "14" },
  { type: "iteration.agent.start", at: iso(8), spanId: "r1-3", n: 1, kind: "codex", model: "r" },
  { type: "iteration.agent.end", at: iso(9), spanId: "r1-3", n: 1, outcome: "ok", commits: [] },
  { type: "iteration.eval.start", at: iso(9), spanId: "r1-3", n: 1 },
  runStart("r2", 20, { resumedFrom: { step: "review", iteration: 1 } }),
  { type: "span.open", at: iso(21), runId: "r2", spanId: "r2-1", step: "review", scope: "14" },
  { type: "iteration.agent.start", at: iso(21), spanId: "r2-1", n: 1, kind: "codex", model: "r", resumedSession: "x1" },
];

export const span = (timeline: Timeline, id: string): Span => {
  const found = timeline.spans.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no span ${id}`);
  return found;
};

describe("foldTimeline", () => {
  it("builds one segment per run.start and closes an earlier one without run.end as crashed at its last activity", () => {
    const { runs } = foldTimeline(scripted());
    expect(runs).toEqual([
      { id: "r1", startedAt: iso(1), endedAt: iso(9), outcome: "crashed", pid: 1, host: "h", sha: "x", flow: "feature" },
      { id: "r2", startedAt: iso(20), pid: 1, host: "h", sha: "x", flow: "feature", resumedFrom: { step: "review", iteration: 1 } },
    ]);
  });

  it("closes a segment with its run.end and leaves a lone open segment running", () => {
    const { runs } = foldTimeline([...scripted(), { type: "run.end", at: iso(30), runId: "r2", outcome: "blocked" }]);
    expect(runs[1]).toMatchObject({ endedAt: iso(30), outcome: "blocked" });
    expect(foldTimeline([runStart("r1", 1)]).runs[0]).not.toHaveProperty("endedAt");
  });

  it("keeps the error a crashed run.end carries", () => {
    const { runs } = foldTimeline([...scripted(), { type: "run.end", at: iso(30), runId: "r2", outcome: "crashed", error: "merge: refusing to merge" }]);
    expect(runs[1]).toMatchObject({ outcome: "crashed", error: "merge: refusing to merge" });
    expect(runs[0]).not.toHaveProperty("error");
  });

  it("builds spans in open order with scope, close data and nested iterations", () => {
    const t = foldTimeline(scripted());
    expect(t.spans.map((s) => [s.id, s.runId, s.step, s.scope])).toEqual([
      ["r1-1", "r1", "build", "14"],
      ["r1-2", "r1", "review", "14"],
      ["r1-3", "r1", "review", "14"],
      ["r2-1", "r2", "review", "14"],
    ]);
    expect(span(t, "r1-1")).toMatchObject({ startedAt: iso(2), endedAt: iso(6), ok: true, next: "review", headSha: "c1" });
    expect(span(t, "r1-1").iterations).toEqual([
      {
        n: 1,
        agent: { kind: "claude", model: "b", startedAt: iso(2), endedAt: iso(5), outcome: "ok", commits: ["c1"], sessionId: "s1", logPath: "/l/build-1.log" },
        eval: { startedAt: iso(5), endedAt: iso(6), ok: true },
      },
    ]);
    expect(span(t, "r1-2")).toMatchObject({ iterations: [] });
    expect(span(t, "r1-2")).not.toHaveProperty("endedAt");
    expect(span(t, "r1-3").iterations[0]).toMatchObject({ n: 1, agent: { outcome: "ok", endedAt: iso(9) }, eval: { startedAt: iso(9) } });
    expect(span(t, "r1-3").iterations[0]?.eval).not.toHaveProperty("endedAt");
    expect(span(t, "r2-1").iterations[0]?.agent).toMatchObject({ resumedSession: "x1", commits: [] });
    expect(span(t, "r2-1").iterations[0]?.agent).not.toHaveProperty("endedAt");
  });

  it("puts a deterministic eval in its own iteration and ignores output events", () => {
    const t = foldTimeline([
      runStart("r1", 0),
      { type: "span.open", at: iso(1), runId: "r1", spanId: "r1-1", step: "verify", scope: "1" },
      { type: "iteration.eval.start", at: iso(1), spanId: "r1-1", n: 1 },
      { type: "iteration.eval.end", at: iso(3), spanId: "r1-1", n: 1, ok: false },
      { type: "output", at: iso(3), spanId: "r1-1", step: "verify", iteration: 1, scope: "1", envelope: { summary: "", commits: [], output: {} }, eval: { ok: false, logTail: "" } },
    ]);
    expect(span(t, "r1-1")).toMatchObject({ scope: "1", iterations: [{ n: 1, eval: { startedAt: iso(1), endedAt: iso(3), ok: false } }] });
  });

  it("is pure and folds an empty log to nothing", () => {
    const events = scripted();
    const before = JSON.stringify(events);
    foldTimeline(events);
    expect(JSON.stringify(events)).toBe(before);
    expect(foldTimeline([])).toEqual({ runs: [], spans: [] });
  });
});

const laneSteps = (t: Timeline) => spansByLane(t.spans).map((l) => [l.scope, l.spans.map((s) => s.step)]);

describe("visitLanes and spansByLane", () => {
  it("groups spans into lanes per scope, in order of first appearance", () => {
    const t = foldTimeline([
      ...scripted(),
      { type: "span.open", at: iso(22), runId: "r2", spanId: "r2-2", step: "close-work", scope: "14" },
      { type: "span.open", at: iso(23), runId: "r2", spanId: "r2-3", step: "build", scope: "15" },
      { type: "span.open", at: iso(24), runId: "r2", spanId: "r2-4", step: "sync", scope: "1" },
      { type: "span.open", at: iso(25), runId: "r2", spanId: "r2-5", step: "review", scope: "15" },
    ]);
    expect(spansByLane(t.spans).map((l) => [l.scope, l.spans.map((s) => s.id)])).toEqual([
      ["14", ["r1-1", "r1-2", "r1-3", "r2-1", "r2-2"]],
      ["15", ["r2-3", "r2-5"]],
      ["1", ["r2-4"]],
    ]);
    expect(spansByLane([])).toEqual([]);
  });

  it("lanes a visit by the work item it operated on: next-work in the sub-issue it picked, sync in the issue it put back", () => {
    const expected = [
      ["89", ["init", "sync", "review-full", "merge"]],
      ["90", ["next-work", "implement", "review", "close-work"]],
      ["91", ["next-work", "implement", "review", "close-work", "next-work"]],
    ];
    expect(foldTimeline(trail89()).spans[1]).toMatchObject({ scope: "89", scopeAfter: "90" });
    expect(laneSteps(foldTimeline(trail89()))).toEqual(expected);
    // A log without scopeAfter derives the same lanes from the span that follows.
    expect(laneSteps(foldTimeline(trail89(false)))).toEqual(expected);
    // The session record does not move: the span keeps the scope it opened in.
    expect(foldTimeline(trail89()).spans.find((s) => s.step === "sync")?.scope).toBe("91");
  });

  it("derives no move from a span that did not close or whose follower is not the step it routed to", () => {
    const t = foldTimeline([
      runStart("r1", 0),
      { type: "span.open", at: iso(1), runId: "r1", spanId: "r1-1", step: "next-work", scope: "89" },
      runStart("r2", 2),
      { type: "span.open", at: iso(3), runId: "r2", spanId: "r2-1", step: "next-work", scope: "90" },
      { type: "span.close", at: iso(4), spanId: "r2-1", ok: false, next: "blocked" },
      runStart("r3", 5),
      { type: "span.open", at: iso(6), runId: "r3", spanId: "r3-1", step: "implement", scope: "91" },
    ]);
    expect([...visitLanes(t.spans)]).toEqual([
      ["r1-1", "89"],
      ["r2-1", "90"],
      ["r3-1", "91"],
    ]);
  });

  it("takes the lanes of the whole timeline when given a part of it", () => {
    const t = foldTimeline(trail89(false));
    const tail = t.spans.slice(9);
    expect(spansByLane(tail).map((l) => l.scope)).toEqual(["91", "89"]);
    expect(spansByLane(t.spans.slice(10, 11)).map((l) => l.scope)).toEqual(["91"]);
    expect(spansByLane(t.spans.slice(10, 11), visitLanes(t.spans)).map((l) => l.scope)).toEqual(["89"]);
  });
});

describe("statuses over a folded log", () => {
  const t = foldTimeline(scripted());

  it("spans: complete when closed, incomplete in a dead run, in progress in the live one", () => {
    expect(spanStatus(span(t, "r1-1"), t)).toBe("complete");
    expect(spanStatus(span(t, "r1-2"), t)).toBe("incomplete");
    expect(spanStatus(span(t, "r1-3"), t)).toBe("incomplete");
    expect(spanStatus(span(t, "r2-1"), t)).toBe("in-progress");
  });

  it("iterations: complete when agent and eval ended, otherwise following the run", () => {
    const [build, review, live] = [span(t, "r1-1"), span(t, "r1-3"), span(t, "r2-1")];
    expect(iterationStatus(build.iterations[0]!, build, t)).toBe("complete");
    expect(iterationStatus(review.iterations[0]!, review, t)).toBe("incomplete");
    expect(iterationStatus(live.iterations[0]!, live, t)).toBe("in-progress");
  });

  it("runs: complete once ended (crashed included), in progress while open", () => {
    expect(t.runs.map(runStatus)).toEqual(["complete", "in-progress"]);
  });

  it("estimates an incomplete span's end from the next span in its run, else from the run's end", () => {
    expect(estimatedEnd(span(t, "r1-2"), t)).toEqual({ at: iso(8), estimated: true });
    expect(estimatedEnd(span(t, "r1-3"), t)).toEqual({ at: iso(9), estimated: true });
    expect(estimatedEnd(span(t, "r1-1"), t)).toBeUndefined();
    expect(estimatedEnd(span(t, "r2-1"), t)).toBeUndefined();
  });
});
