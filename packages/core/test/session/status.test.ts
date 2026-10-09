import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../src/exec/scope.js";
import type { Event } from "../../src/session/events.js";
import { estimatedEnd, historyStatus, iterationStatus, spanOf, spanStatus } from "../../src/session/status.js";
import { foldTimeline } from "../../src/session/timeline.js";

const iso = (m: number) => new Date(Date.UTC(2026, 9, 2, 9, m)).toISOString();

/** A build span closed at 09:06 in run r1, and spans recorded without any run segment. */
const events: Event[] = [
  { type: "run.start", at: iso(0), runId: "r1", pid: 1, host: "h", sha: "x", flow: "task" },
  { type: "span.open", at: iso(2), runId: "r1", spanId: "r1-1", step: "build", scope: "1" },
  { type: "span.close", at: iso(6), spanId: "r1-1", ok: true, next: "review" },
  { type: "run.end", at: iso(7), runId: "r1", outcome: "interrupted" },
  { type: "span.open", at: iso(10), runId: "", spanId: "span-1", step: "review", scope: "1" },
  { type: "iteration.agent.start", at: iso(10), spanId: "span-1", n: 1, kind: "codex", model: "r" },
  { type: "span.open", at: iso(11), runId: "gone", spanId: "gone-1", step: "fix", scope: "1" },
];
const t = foldTimeline(events);
const find = (id: string) => {
  const s = t.spans.find((x) => x.id === id);
  if (s === undefined) throw new Error(id);
  return s;
};

describe("spans without a run segment", () => {
  it("are incomplete, never in progress, as are their iterations, with no estimated end", () => {
    const [outside, orphan] = [find("span-1"), find("gone-1")];
    expect(spanStatus(outside, t)).toBe("incomplete");
    expect(spanStatus(orphan, t)).toBe("incomplete");
    expect(iterationStatus(outside.iterations[0]!, outside, t)).toBe("incomplete");
    expect(estimatedEnd(orphan, t)).toBeUndefined();
  });
});

describe("historyStatus", () => {
  const closed: HistoryEntry = { step: "build", at: iso(6), ok: true, next: "review" };

  it("follows the span that closed at the transition's time", () => {
    expect(spanOf(closed, t)?.id).toBe("r1-1");
    expect(historyStatus(closed, t)).toBe("complete");
  });

  it("is untracked when no span closed with the entry (events lost, or a different step)", () => {
    expect(historyStatus({ ...closed, at: iso(5) }, t)).toBe("untracked");
    expect(historyStatus({ ...closed, step: "review" }, t)).toBe("untracked");
    expect(historyStatus(closed, foldTimeline([]))).toBe("untracked");
  });
});
