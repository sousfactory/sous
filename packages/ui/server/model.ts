/**
 * The view model: one issue's session and timeline mapped onto the GitHub
 * Actions vocabulary. Pure; the browser imports the types only.
 *
 * Attempts are run segments. Attempt N shows every visit of segments 1..N,
 * the way GitHub carries jobs over into a re-run, with the outcome of N.
 * A node's status is its latest visit's: success or failure once closed,
 * in progress while open in a live run, failure when its run crashed or died
 * first, cancelled when it was interrupted; an unvisited node is queued while
 * the run is live, skipped after.
 */
import { visitLanes, type Agent, type AgentOutcome, type RunOutcome, type RunSegment, type Session, type Span, type StepKind, type Timeline, type TokenUsage, type Topology, type TopologyNode } from "sous-factory/read";

export type Status = "success" | "failure" | "in_progress" | "queued" | "skipped" | "cancelled";

/** The run outcomes of core, plus `running` (live) and `stale` (no end, process gone). */
export type Outcome = RunOutcome | "running" | "stale" | "unknown";

export type RunSummary = {
  issue: string;
  title: string;
  flow: string;
  branch: string;
  status: Status;
  outcome: Outcome;
  live: boolean;
  attempts: number;
  runId?: string;
  sha?: string;
  /** The squash commit `merge` landed on the base branch; set once the run is done. */
  squash?: string;
  /** Why the run crashed, as its `run.end` recorded it, and the step whose visit it left open. */
  crash?: { error: string; step?: string };
  startedAt?: string;
  endedAt?: string;
};

export type RunRow = { kind: "run"; updatedAt: string; summary: RunSummary } | { kind: "error"; updatedAt: string; issue: string; error: string };

export type Attempt = { n: number; runId: string; startedAt: string; endedAt?: string; outcome: Outcome; sha: string; resumedFrom?: { step: string; iteration: number } };

export type WorkItem = { key: string; id: string; isIssue: boolean; state: "open" | "done"; current: boolean };

export type StepNode = {
  id: string;
  status: Status;
  visits: number;
  uses?: string;
  agent?: Agent;
  /** Known when the step loaded from stepsDir. */
  kind?: StepKind;
  /** A prepare runs before the agent and may skip it. */
  prepare?: true;
  /** The latest visit's prepare skipped the agent, with its reason. */
  agentSkipped?: { reason?: string };
  /** An eval judges the step's run (prompt or module); an eval-only step has none. */
  evalGate?: true;
  startedAt?: string;
  endedAt?: string;
  /** Visited in this run, but not a step of the flow file as it is now. */
  unknown?: true;
  /** While in progress: what runs now, the step's `prepare`, its work (agent or module) or its `eval()`. */
  phase?: Phase;
};

export type Phase = "prepare" | "work" | "eval";

export type PrepareView = { startedAt: string; endedAt?: string; agent?: "run" | "skip"; reason?: string };

export type StepEdge = { from: string; to: string; taken: boolean };

export type IterationView = {
  n: number;
  agent?: {
    kind: string;
    model: string;
    startedAt: string;
    endedAt?: string;
    outcome?: AgentOutcome;
    usage?: TokenUsage;
    sessionId?: string;
    commits: string[];
    /** File name under `logs/<issue>/`. */
    log: string;
  };
  eval?: { startedAt: string; endedAt?: string; ok?: boolean };
};

export type VisitView = {
  spanId: string;
  runId: string;
  scope: string;
  startedAt: string;
  endedAt?: string;
  next?: string;
  status: Status;
  /** The error that crashed the run while this visit was open. */
  error?: string;
  /** The visit's prepare call; absent for a step without one, and on a visit that reused a recorded result. */
  prepare?: PrepareView;
  iterations: IterationView[];
};

export type RouteView = { to: string; when?: string; exhausted?: true };

export type StepDetail = {
  id: string;
  routes: RouteView[];
  visits: VisitView[];
  /** The session's record of the latest visit; only for the latest attempt, which the session describes. */
  record?: { ok: boolean; log: string; output: unknown; commits: string[]; session?: string; prepared?: { agent: "run" | "skip"; reason?: string; output: unknown } };
};

export type RunView = {
  summary: RunSummary;
  attempt: number;
  attemptList: Attempt[];
  scope: string;
  work: WorkItem[];
  entry?: string;
  nodes: StepNode[];
  edges: StepEdge[];
  details: Record<string, StepDetail>;
  flowError?: string;
};

/** A step of a flow preview: what it uses and does, and where it can route. */
export type FlowStepDetail = { id: string; uses: string; description?: string; routes: RouteView[] };

/** A flow file drawn without a run: every step queued, no route taken. */
export type FlowView = {
  name: string;
  entry?: string;
  nodes: StepNode[];
  edges: StepEdge[];
  details: Record<string, FlowStepDetail>;
  /** Why the flow file could not be read; nothing is drawn then. */
  error?: string;
};

export type DeriveInput = {
  session: Session;
  timeline: Timeline;
  /** The flow as its file is now, or why it could not be read. */
  topology: Topology | { error: string };
  /** A live `sous run` holds the lock for this issue. */
  live: boolean;
  /** 1-based; the latest when absent or out of range. */
  attempt?: number;
  scope?: string;
};

const OUTCOME_STATUS: Record<Outcome, Status> = {
  running: "in_progress",
  done: "success",
  blocked: "failure",
  crashed: "failure",
  stale: "failure",
  interrupted: "cancelled",
  unknown: "skipped",
};

export const outcomeStatus = (outcome: Outcome): Status => OUTCOME_STATUS[outcome];

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

/** The outcome of a run segment; only the latest one can be running, and only while live. */
const segmentOutcome = (run: RunSegment, isLatest: boolean, live: boolean): Outcome => {
  if (run.outcome !== undefined) return run.outcome;
  return isLatest && live ? "running" : "stale";
};

/** Without any run segment the session alone tells how far it got. */
const sessionOutcome = (session: Session, live: boolean): Outcome =>
  live ? "running" : session.current === "done" ? "done" : session.blocked ? "blocked" : "unknown";

/** Keyed by run id. */
type Outcomes = ReadonlyMap<string, Outcome>;

const visitStatus = (span: Span, outcomes: Outcomes): Status => {
  if (span.endedAt !== undefined) return span.ok === true ? "success" : "failure";
  const outcome = outcomes.get(span.runId);
  if (outcome === "running") return "in_progress";
  return outcome === "crashed" || outcome === "stale" ? "failure" : "cancelled";
};

/**
 * The end event's path replaces the start event's (the `.2` sibling after a
 * retry). Logs recorded before events carried `logPath` used the old
 * `<step>-<n>.log` name; current names are never rebuilt here.
 */
const logName = (step: string, n: number, logPath: string | undefined): string => (logPath !== undefined ? (logPath.split(/[\\/]/).pop() ?? logPath) : `${step}-${n}.log`);

const visitView = (span: Span, outcomes: Outcomes, errors: ReadonlyMap<string, string>): VisitView => {
  const error = span.endedAt === undefined ? errors.get(span.runId) : undefined;
  return {
    spanId: span.id,
    runId: span.runId,
    scope: span.scope,
    startedAt: span.startedAt,
    ...(span.endedAt !== undefined ? { endedAt: span.endedAt } : {}),
    ...(span.next !== undefined ? { next: span.next } : {}),
    status: visitStatus(span, outcomes),
    ...(error !== undefined ? { error } : {}),
    ...(span.prepare !== undefined ? { prepare: span.prepare } : {}),
    iterations: span.iterations.map((it) => ({
      n: it.n,
      ...(it.agent !== undefined
        ? {
            agent: {
              kind: it.agent.kind,
              model: it.agent.model,
              startedAt: it.agent.startedAt,
              commits: it.agent.commits,
              log: logName(span.step, it.n, it.agent.logPath),
              ...(it.agent.endedAt !== undefined ? { endedAt: it.agent.endedAt } : {}),
              ...(it.agent.outcome !== undefined ? { outcome: it.agent.outcome } : {}),
              ...(it.agent.usage !== undefined ? { usage: it.agent.usage } : {}),
              ...(it.agent.sessionId !== undefined ? { sessionId: it.agent.sessionId } : {}),
            },
          }
        : {}),
      ...(it.eval !== undefined
        ? {
            eval: {
              startedAt: it.eval.startedAt,
              ...(it.eval.endedAt !== undefined ? { endedAt: it.eval.endedAt } : {}),
              ...(it.eval.ok !== undefined ? { ok: it.eval.ok } : {}),
            },
          }
        : {}),
    })),
  };
};

/** Work items in order of first appearance: span scopes and lanes, then the session's records. */
const workItems = (session: Session, spans: readonly Span[], lanes: ReadonlyMap<string, string>): string[] => {
  const keys = [...spans.flatMap((s) => [s.scope, lanes.get(s.id) ?? s.scope]), ...Object.keys(session.scopes), ...Object.keys(session.workProgress)];
  return [...new Set(keys)];
};

/**
 * The visits that colour each step in the selected work item, by the lane of
 * each visit (`visitLanes`: the item it operated on). A step shows its visits
 * in the selected lane, so a sub-issue not yet started reads as queued and
 * the full-branch steps (sync, review-full, merge) belong to the
 * issue alone. Two steps reach beyond their lane:
 * - the prelude, the issue's steps before the first sub-issue was picked
 *   (init), is shared by every work item;
 * - a step that picked a sub-issue (next-work) drives the issue's loop: in
 *   the issue's lane it shows all its visits, so its latest one colours it.
 */
const stepSpans = (spans: readonly Span[], lanes: ReadonlyMap<string, string>, scope: string, issueScope: string): Map<string, Span[]> => {
  const laneOf = (s: Span): string => lanes.get(s.id) ?? s.scope;
  const firstPick = spans.findIndex((s) => laneOf(s) !== issueScope);
  const before = new Set(firstPick > 0 ? spans.slice(0, firstPick) : []);
  const byStep = new Map<string, Span[]>();
  for (const span of spans) byStep.set(span.step, [...(byStep.get(span.step) ?? []), span]);
  const shown = new Map<string, Span[]>();
  for (const [step, all] of byStep) {
    const prelude = all.every((s) => before.has(s));
    const picks = all.some((s) => laneOf(s) !== s.scope && laneOf(s) !== issueScope);
    const loop = scope === issueScope && picks;
    shown.set(step, prelude || loop ? all : all.filter((s) => laneOf(s) === scope));
  }
  return shown;
};

/**
 * What an in-progress visit runs now. A module has no event of its own, so a
 * module step counts as `work` until its eval starts. Between phases (agent
 * ended, eval not started) there is none.
 */
const phaseOf = (span: Span, kind: StepKind | undefined): Phase | undefined => {
  const it = last(span.iterations);
  if (it === undefined && span.prepare !== undefined) return span.prepare.endedAt === undefined ? "prepare" : undefined;
  if (it?.eval !== undefined) return it.eval.endedAt === undefined ? "eval" : undefined;
  if (it?.agent !== undefined) return it.agent.endedAt === undefined ? "work" : undefined;
  return kind === "module" ? "work" : undefined;
};

const isTerminal = (to: string): boolean => to === "done" || to === "blocked";

/** The step's shape from the flow file and its step.yaml, as a card shows it. */
const shapeProps = (entry: TopologyNode) => ({
  uses: entry.uses,
  ...(entry.agent !== undefined ? { agent: entry.agent } : {}),
  ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
  ...(entry.prepare === true ? { prepare: true as const } : {}),
  ...(entry.evalGate === true ? { evalGate: true as const } : {}),
});

/** The routes the graph draws: no `done`, `blocked` or exhausted edges, each pair once. */
const drawnEdges = (topology: Topology | undefined): { from: string; to: string }[] => {
  const drawn: { from: string; to: string }[] = [];
  for (const e of topology?.edges ?? []) {
    if (e.exhausted === true || isTerminal(e.to) || drawn.some((x) => x.from === e.from && x.to === e.to)) continue;
    drawn.push({ from: e.from, to: e.to });
  }
  return drawn;
};

/** Every route out of `id`, the terminal and exhausted ones included, in file order. */
const routesOf = (topology: Topology | undefined, id: string): RouteView[] =>
  (topology?.edges ?? [])
    .filter((e) => e.from === id)
    .map((e) => ({ to: e.to, ...(e.when !== undefined ? { when: e.when } : {}), ...(e.exhausted === true ? { exhausted: true as const } : {}) }));

/** The flow file alone, for a flow that may never have run. */
export const deriveFlow = (name: string, topology: Topology | { error: string }): FlowView => {
  if ("error" in topology) return { name, nodes: [], edges: [], details: {}, error: topology.error };
  return {
    name,
    entry: topology.entry,
    nodes: topology.nodes.map((n) => ({ id: n.id, status: "queued", visits: 0, ...shapeProps(n) })),
    edges: drawnEdges(topology).map((e) => ({ ...e, taken: false })),
    details: Object.fromEntries(
      topology.nodes.map((n) => [n.id, { id: n.id, uses: n.uses, ...(n.description !== undefined ? { description: n.description } : {}), routes: routesOf(topology, n.id) }]),
    ),
  };
};

export const deriveRun = (input: DeriveInput): RunView => {
  const { session, timeline, live } = input;
  const runs = timeline.runs;
  const index = input.attempt !== undefined && input.attempt >= 1 && input.attempt <= runs.length ? input.attempt - 1 : runs.length - 1;
  const selected = runs[index];
  const isLatest = index === runs.length - 1;
  const known = new Set(runs.slice(0, index + 1).map((r) => r.id));
  const spans = runs.length === 0 ? timeline.spans : timeline.spans.filter((s) => known.has(s.runId));
  const outcome = selected === undefined ? sessionOutcome(session, live) : segmentOutcome(selected, isLatest, live);
  const outcomes: Outcomes = new Map(runs.slice(0, index + 1).map((run, i) => [run.id, i === index ? outcome : segmentOutcome(run, false, live)]));
  const errors = new Map(runs.flatMap((run) => (run.error !== undefined ? [[run.id, run.error] as const] : [])));

  const issueScope = session.issue;
  const lanes = visitLanes(spans);
  const scopes = workItems(session, spans, lanes);
  const lastSpan = last(spans);
  const defaultScope = isLatest || lastSpan === undefined ? session.work : (lanes.get(lastSpan.id) ?? lastSpan.scope);
  const scope = input.scope !== undefined && scopes.includes(input.scope) ? input.scope : defaultScope;

  const topology = "error" in input.topology ? undefined : input.topology;
  const declared = topology?.nodes ?? [];
  const declaredIds = new Set(declared.map((n) => n.id));
  const visitedIds = [...new Set(spans.map((s) => s.step))];
  const ids = [...declared.map((n) => n.id), ...visitedIds.filter((id) => !declaredIds.has(id))];

  const spansOf = stepSpans(spans, lanes, scope, issueScope);
  const nodes: StepNode[] = ids.map((id) => {
    const own = spansOf.get(id) ?? [];
    const latest = last(own);
    const entry = declared.find((n) => n.id === id);
    const status: Status = latest !== undefined ? visitStatus(latest, outcomes) : outcome === "running" ? "queued" : "skipped";
    const phase = latest !== undefined && status === "in_progress" ? phaseOf(latest, entry?.kind) : undefined;
    return {
      id,
      status,
      visits: own.length,
      ...(entry !== undefined ? shapeProps(entry) : { unknown: true as const }),
      ...(latest?.prepare?.agent === "skip" ? { agentSkipped: latest.prepare.reason !== undefined ? { reason: latest.prepare.reason } : {} } : {}),
      ...(latest !== undefined ? { startedAt: latest.startedAt } : {}),
      ...(latest?.endedAt !== undefined ? { endedAt: latest.endedAt } : {}),
      ...(phase !== undefined ? { phase } : {}),
    };
  });

  // Taken when the target was visited in this lane too: next-work in the issue's lane did route to implement, but not there.
  const edges: StepEdge[] = drawnEdges(topology).map((e) => ({
    ...e,
    taken: (spansOf.get(e.to) ?? []).length > 0 && (spansOf.get(e.from) ?? []).some((s) => s.next === e.to),
  }));

  const details: Record<string, StepDetail> = {};
  for (const id of ids) {
    const own = spansOf.get(id) ?? [];
    const recordScope = last(own)?.scope ?? scope;
    const record = isLatest ? session.scopes[recordScope]?.[id] : undefined;
    details[id] = {
      id,
      routes: routesOf(topology, id),
      visits: own.map((s) => visitView(s, outcomes, errors)),
      ...(record !== undefined
        ? {
            record: {
              ok: record.ok,
              log: record.log,
              output: record.output,
              commits: record.commits,
              ...(record.session !== undefined ? { session: record.session } : {}),
              ...(record.prepared !== undefined ? { prepared: record.prepared } : {}),
            },
          }
        : {}),
    };
  }

  const work: WorkItem[] = scopes.map((key) => ({
    key,
    id: key,
    isIssue: key === issueScope,
    state: session.workProgress[key]?.state ?? "open",
    current: key === session.work,
  }));

  const attemptList: Attempt[] = runs.map((run, i) => ({
    n: i + 1,
    runId: run.id,
    startedAt: run.startedAt,
    outcome: segmentOutcome(run, i === runs.length - 1, live),
    sha: run.sha,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.resumedFrom !== undefined ? { resumedFrom: run.resumedFrom } : {}),
  }));

  return {
    summary: summarize(session, timeline, live, selected, outcome),
    attempt: index + 1,
    attemptList,
    scope,
    work,
    ...(topology !== undefined ? { entry: topology.entry } : {}),
    nodes,
    edges,
    details,
    ...("error" in input.topology ? { flowError: input.topology.error } : {}),
  };
};

/** `merge` marks the issue's own work record done with the squash sha; none when the branch was already merged. */
const squashOf = (session: Session): string | undefined => {
  const own = session.workProgress[session.issue];
  return session.current === "done" && own?.state === "done" ? own.commits[0] : undefined;
};

/** The crash of `run`, with the step it left open; only a `run.end` written since it carries an error has one. */
const crashOf = (timeline: Timeline, run: RunSegment | undefined): RunSummary["crash"] => {
  if (run?.error === undefined) return undefined;
  const open = last(timeline.spans.filter((s) => s.runId === run.id && s.endedAt === undefined));
  return { error: run.error, ...(open !== undefined ? { step: open.step } : {}) };
};

const summarize = (session: Session, timeline: Timeline, live: boolean, run: RunSegment | undefined, outcome: Outcome): RunSummary => {
  const first = timeline.spans[0];
  const squash = squashOf(session);
  const crash = crashOf(timeline, run);
  return {
    issue: session.issue,
    title: session.title,
    flow: session.flow,
    branch: session.branch,
    status: outcomeStatus(outcome),
    outcome,
    live: outcome === "running" && live,
    attempts: timeline.runs.length,
    ...(run !== undefined ? { runId: run.id, sha: run.sha, startedAt: run.startedAt } : first !== undefined ? { startedAt: first.startedAt } : {}),
    ...(run?.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(squash !== undefined ? { squash } : {}),
    ...(crash !== undefined ? { crash } : {}),
  };
};

/** The latest attempt's summary, for the runs list. */
export const summarizeRun = (session: Session, timeline: Timeline, live: boolean): RunSummary => {
  const run = last(timeline.runs);
  const outcome = run === undefined ? sessionOutcome(session, live) : segmentOutcome(run, true, live);
  return summarize(session, timeline, live, run, outcome);
};
