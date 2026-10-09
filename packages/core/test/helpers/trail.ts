import type { Event } from "../../src/session/events.js";

const iso = (m: number, s = 0) => new Date(Date.UTC(2026, 9, 2, 9, m, s)).toISOString();

/** The span trail of run #89, shared by the timeline and status tests: the issue, sub-issues 90 and 91; `next-work` picks them, `sync` puts 89 back. */
export const TRAIL_89: readonly (readonly [step: string, scope: string, next: string, scopeAfter: string])[] = [
  ["init", "89", "next-work", "89"],
  ["next-work", "89", "implement", "90"],
  ["implement", "90", "review", "90"],
  ["review", "90", "close-work", "90"],
  ["close-work", "90", "next-work", "90"],
  ["next-work", "90", "implement", "91"],
  ["implement", "91", "review", "91"],
  ["review", "91", "close-work", "91"],
  ["close-work", "91", "next-work", "91"],
  ["next-work", "91", "sync", "91"],
  ["sync", "91", "review-full", "89"],
  ["review-full", "89", "merge", "89"],
  ["merge", "89", "done", "89"],
];

/** The trail as events; `withScopeAfter: false` writes the log of executors older than `scopeAfter`. Spans are `r1-1` … `r1-13`. */
export const trail89 = (withScopeAfter = true, end = true): Event[] => [
  { type: "run.start", at: iso(0), runId: "r1", pid: 1, host: "h", sha: "x", flow: "feature" },
  ...TRAIL_89.flatMap(([step, scope, next, scopeAfter], i): Event[] => [
    { type: "span.open", at: iso(i + 1), runId: "r1", spanId: `r1-${i + 1}`, step, scope },
    { type: "span.close", at: iso(i + 1, 30), spanId: `r1-${i + 1}`, ok: true, next, ...(withScopeAfter ? { scopeAfter } : {}) },
  ]),
  ...(end ? [{ type: "run.end", at: iso(20), runId: "r1", outcome: "done" } as Event] : []),
];

