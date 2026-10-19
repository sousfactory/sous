/**
 * The timeline folded from the event log: one segment per `sous run`
 * process, one span per step visit, iterations with their agent call and
 * eval. The swim lanes of `sous status` and `sous ui` are the work items the
 * visits operated on.
 */
import type { AgentKind } from "../config/flow.js";
import type { PrepareVerdict } from "../index.js";
import type { AgentOutcome, Event, RunOutcome, TokenUsage } from "./events.js";
import type { SpecSource } from "./spec.js";

export type RunSegment = {
  id: string;
  startedAt: string;
  endedAt?: string;
  outcome?: RunOutcome;
  /** Why a `crashed` segment ended, from its `run.end`. */
  error?: string;
  pid: number;
  host: string;
  sha: string;
  flow: string;
  resumedFrom?: { step: string; iteration: number };
  spec?: SpecSource;
};

export type AgentSpan = {
  kind: AgentKind;
  model: string;
  startedAt: string;
  endedAt?: string;
  sessionId?: string;
  resumedSession?: string;
  logPath?: string;
  usage?: TokenUsage;
  commits: string[];
  outcome?: AgentOutcome;
};

export type EvalSpan = {
  startedAt: string;
  endedAt?: string;
  ok?: boolean;
};

export type PrepareSpan = {
  startedAt: string;
  endedAt?: string;
  agent?: PrepareVerdict;
  reason?: string;
};

/**
 * One agent call and/or one eval inside a span. `n` is the step's iteration
 * counter; a re-entry eval after `blocked` runs before any agent and is `n: 0`.
 */
export type IterationSpan = { n: number; agent?: AgentSpan; eval?: EvalSpan };

/** One visit to a step. */
export type Span = {
  id: string;
  runId: string;
  step: string;
  /** Scope key: the work item's number. */
  scope: string;
  startedAt: string;
  endedAt?: string;
  ok?: boolean;
  next?: string;
  headSha?: string;
  /** The scope key after the visit, from `span.close`; absent in older logs. */
  scopeAfter?: string;
  /** Set when the step has a `prepare` and it ran in this span; a re-entry reuses the recorded result and has none. */
  prepare?: PrepareSpan;
  iterations: IterationSpan[];
};

export type Timeline = { runs: RunSegment[]; spans: Span[] };

const lastOf = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

/** An eval after an agent call shares its iteration; one without a preceding agent opens its own. */
const withIteration = (span: Span, n: number, next: (it: IterationSpan) => IterationSpan): Span => {
  const last = lastOf(span.iterations);
  return last !== undefined && last.n === n
    ? { ...span, iterations: [...span.iterations.slice(0, -1), next(last)] }
    : { ...span, iterations: [...span.iterations, next({ n })] };
};

const lastActivity = (run: RunSegment, spans: readonly Span[]): string =>
  spans
    .filter((span) => span.runId === run.id)
    .flatMap((span) => [
      span.startedAt,
      span.endedAt,
      span.prepare?.startedAt,
      span.prepare?.endedAt,
      ...span.iterations.flatMap((i) => [i.agent?.startedAt, i.agent?.endedAt, i.eval?.startedAt, i.eval?.endedAt]),
    ])
    .filter((t): t is string => t !== undefined)
    .reduce((latest, t) => (t > latest ? t : latest), run.startedAt);

/**
 * Only the last segment can still be running. An earlier one without
 * `run.end` belonged to a process that died; it is shown as `crashed` at its
 * last recorded activity.
 */
const closeDeadRuns = ({ runs, spans }: Timeline): Timeline => ({
  spans,
  runs: runs.map((run, i) => (run.endedAt === undefined && i < runs.length - 1 ? { ...run, endedAt: lastActivity(run, spans), outcome: "crashed" } : run)),
});

const applyToRun = (runs: RunSegment[], id: string, next: (run: RunSegment) => RunSegment): RunSegment[] =>
  runs.map((run) => (run.id === id ? next(run) : run));

const applyToSpan = (spans: Span[], id: string, next: (span: Span) => Span): Span[] => spans.map((span) => (span.id === id ? next(span) : span));

const apply = ({ runs, spans }: Timeline, event: Event): Timeline => {
  switch (event.type) {
    case "run.start": {
      const { at, runId, pid, host, sha, flow, resumedFrom, spec } = event;
      const run: RunSegment = { id: runId, startedAt: at, pid, host, sha, flow, ...(resumedFrom !== undefined ? { resumedFrom } : {}), ...(spec !== undefined ? { spec } : {}) };
      return { runs: [...runs, run], spans };
    }
    case "run.end":
      return { runs: applyToRun(runs, event.runId, (run) => ({ ...run, endedAt: event.at, outcome: event.outcome, ...(event.error !== undefined ? { error: event.error } : {}) })), spans };
    case "span.open": {
      const { at, spanId, runId, step, scope } = event;
      return { runs, spans: [...spans, { id: spanId, runId, step, scope, startedAt: at, iterations: [] }] };
    }
    case "span.close":
      return {
        runs,
        spans: applyToSpan(spans, event.spanId, (span) => ({
          ...span,
          endedAt: event.at,
          ok: event.ok,
          next: event.next,
          ...(event.headSha !== undefined ? { headSha: event.headSha } : {}),
          ...(event.scopeAfter !== undefined ? { scopeAfter: event.scopeAfter } : {}),
        })),
      };
    case "prepare.start":
      return { runs, spans: applyToSpan(spans, event.spanId, (span) => ({ ...span, prepare: { startedAt: event.at } })) };
    case "prepare.end":
      return {
        runs,
        spans: applyToSpan(spans, event.spanId, (span) =>
          span.prepare === undefined
            ? span
            : { ...span, prepare: { ...span.prepare, endedAt: event.at, agent: event.agent, ...(event.reason !== undefined ? { reason: event.reason } : {}) } },
        ),
      };
    case "iteration.agent.start":
      return {
        runs,
        spans: applyToSpan(spans, event.spanId, (span) => ({
          ...span,
          iterations: [
            ...span.iterations,
            {
              n: event.n,
              agent: {
                kind: event.kind,
                model: event.model,
                startedAt: event.at,
                commits: [],
                ...(event.resumedSession !== undefined ? { resumedSession: event.resumedSession } : {}),
                ...(event.logPath !== undefined ? { logPath: event.logPath } : {}),
              },
            },
          ],
        })),
      };
    case "iteration.agent.end":
      return {
        runs,
        spans: applyToSpan(spans, event.spanId, (span) =>
          withIteration(span, event.n, (it) =>
            it.agent === undefined
              ? it
              : {
                  ...it,
                  agent: {
                    ...it.agent,
                    endedAt: event.at,
                    outcome: event.outcome,
                    commits: event.commits,
                    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
                    ...(event.usage !== undefined ? { usage: event.usage } : {}),
                    ...(event.logPath !== undefined ? { logPath: event.logPath } : {}),
                  },
                },
          ),
        ),
      };
    case "iteration.eval.start":
      return {
        runs,
        spans: applyToSpan(spans, event.spanId, (span) => withIteration(span, event.n, (it) => ({ ...it, eval: { startedAt: event.at } }))),
      };
    case "iteration.eval.end":
      return {
        runs,
        spans: applyToSpan(spans, event.spanId, (span) =>
          withIteration(span, event.n, (it) => (it.eval === undefined ? it : { ...it, eval: { ...it.eval, endedAt: event.at, ok: event.ok } })),
        ),
      };
    case "output":
    case "skills":
      return { runs, spans };
  }
};

export const foldTimeline = (events: readonly Event[]): Timeline => closeDeadRuns(events.reduce<Timeline>(apply, { runs: [], spans: [] }));

export type Lane = { scope: string; spans: Span[] };

/**
 * The lane of every visit, by span id: the work item it operated on. That is
 * the scope it opened in, except for a visit that put another item on the
 * bench: `next-work` belongs to the sub-issue it picked, `sync` to the issue
 * it put back. Older logs lack `scopeAfter`; there the following span tells:
 * if it is the step this one routed to and opened in another scope, the
 * bench moved during this visit. The session record itself stays in the
 * scope the visit opened in.
 */
export const visitLanes = (spans: readonly Span[]): Map<string, string> =>
  new Map(
    spans.map((span, i) => {
      if (span.scopeAfter !== undefined) return [span.id, span.scopeAfter];
      const following = spans[i + 1];
      const moved = span.endedAt !== undefined && following !== undefined && following.step === span.next && following.scope !== span.scope;
      return [span.id, moved ? following.scope : span.scope];
    }),
  );

/**
 * Lanes in order of first appearance, spans in open order. Pass the whole
 * timeline's `lanes` when `spans` is only part of it, since a lane can depend
 * on the following span.
 */
export const spansByLane = (spans: readonly Span[], lanes: ReadonlyMap<string, string> = visitLanes(spans)): Lane[] => {
  const grouped = new Map<string, Span[]>();
  for (const span of spans) {
    const scope = lanes.get(span.id) ?? span.scope;
    const lane = grouped.get(scope);
    if (lane === undefined) grouped.set(scope, [span]);
    else lane.push(span);
  }
  return [...grouped].map(([scope, spans]) => ({ scope, spans }));
};
