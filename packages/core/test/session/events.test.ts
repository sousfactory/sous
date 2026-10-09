import { describe, expect, it } from "vitest";
import { isEvent, isOutput, type Event } from "../../src/session/events.js";

const at = "2026-10-02T09:00:00.000Z";

/** One of each event kind, with every optional field set. */
export const everyEvent = (): Event[] => [
  { type: "run.start", at, runId: "r1", pid: 42, host: "box", sha: "abc1234", flow: "feature", resumedFrom: { step: "build", iteration: 1 } },
  { type: "span.open", at, runId: "r1", spanId: "r1-1", step: "build", scope: "14" },
  { type: "prepare.start", at, spanId: "r1-1" },
  { type: "prepare.end", at, spanId: "r1-1", agent: "skip", reason: "nothing came in" },
  { type: "iteration.agent.start", at, spanId: "r1-1", n: 1, kind: "claude", model: "claude-x", resumedSession: "s0" },
  {
    type: "iteration.agent.end",
    at,
    spanId: "r1-1",
    n: 1,
    outcome: "ok",
    commits: ["c1"],
    sessionId: "s1",
    usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 },
    logPath: "/logs/build-1.log",
  },
  { type: "iteration.eval.start", at, spanId: "r1-1", n: 1 },
  { type: "iteration.eval.end", at, spanId: "r1-1", n: 1, ok: true },
  {
    type: "output",
    at,
    spanId: "r1-1",
    step: "build",
    iteration: 1,
    scope: "14",
    sessionId: "s1",
    envelope: { summary: "did", commits: ["c1"], output: { filesTouched: [], testsRun: [] } },
    eval: { ok: true, logTail: "ok" },
  },
  { type: "span.close", at, spanId: "r1-1", ok: true, next: "review", headSha: "c1" },
  { type: "run.end", at, runId: "r1", outcome: "done" },
];

describe("isEvent", () => {
  it("accepts every event kind after a JSON round trip", () => {
    for (const event of everyEvent()) expect(isEvent(JSON.parse(JSON.stringify(event)))).toBe(true);
  });

  it("accepts the minimal form of each event, without optional fields", () => {
    const minimal: Event[] = [
      { type: "run.start", at, runId: "r1", pid: 1, host: "h", sha: "x", flow: "task" },
      { type: "span.open", at, runId: "r1", spanId: "r1-1", step: "init", scope: "1" },
      { type: "prepare.end", at, spanId: "r1-1", agent: "run" },
      { type: "iteration.agent.start", at, spanId: "r1-1", n: 1, kind: "codex", model: "m" },
      { type: "iteration.agent.end", at, spanId: "r1-1", n: 1, outcome: "process-failed", commits: [] },
      { type: "iteration.eval.end", at, spanId: "r1-1", n: 0, ok: false },
      { type: "span.close", at, spanId: "r1-1", ok: false, next: "blocked" },
    ];
    for (const event of minimal) expect(isEvent(event)).toBe(true);
  });

  it("rejects an unknown type, a missing timestamp, a missing field and a bad outcome", () => {
    expect(isEvent({ type: "nope", at })).toBe(false);
    expect(isEvent({ type: "run.end", runId: "r1", outcome: "done" })).toBe(false);
    expect(isEvent({ type: "run.end", at, outcome: "done" })).toBe(false);
    expect(isEvent({ type: "run.end", at, runId: "r1", outcome: "exploded" })).toBe(false);
    expect(isEvent({ type: "prepare.end", at, spanId: "r1-1", agent: "maybe" })).toBe(false);
    expect(isEvent({ type: "iteration.agent.end", at, spanId: "s", n: 1, outcome: "meh", commits: [] })).toBe(false);
    expect(isEvent("run.end")).toBe(false);
    expect(isEvent(null)).toBe(false);
  });

  it("isOutput narrows to output events", () => {
    const outputs = everyEvent().filter(isOutput);
    expect(outputs.map((o) => o.envelope.commits)).toEqual([["c1"]]);
  });
});
