/**
 * Event types of the log in `runs/<issue>/events.jsonl`. Observability only:
 * nothing the executor needs to resume lives here; control state is the
 * session. Kept beside timeline and status, which fold it, rather than under
 * `exec/`, which only emits it.
 */
import type { AgentKind } from "../config/flow.js";
import type { Envelope } from "../index.js";
import type { SkillAudit } from "../skills.js";

export const RUN_OUTCOMES = ["done", "blocked", "crashed", "interrupted"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const AGENT_OUTCOMES = ["ok", "invalid-output", "process-failed"] as const;
export type AgentOutcome = (typeof AGENT_OUTCOMES)[number];

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

type Base = { at: string };

/** One `sous run` process starts working on the issue. */
export type RunStartEvent = Base & {
  type: "run.start";
  runId: string;
  pid: number;
  host: string;
  /** `git rev-parse --short HEAD` of the repository at start, `unknown` if unavailable. */
  sha: string;
  flow: string;
  /** Set when the run did not start at the flow's entry. */
  resumedFrom?: { step: string; iteration: number };
};

/** `error` is set on a `crashed` outcome; absent in older logs. */
export type RunEndEvent = Base & { type: "run.end"; runId: string; outcome: RunOutcome; error?: string };

/** A visit to a step begins; `scope` is the session's scope key at that moment. */
export type SpanOpenEvent = Base & { type: "span.open"; runId: string; spanId: string; step: string; scope: string };

export type SpanCloseEvent = Base & {
  type: "span.close";
  spanId: string;
  ok: boolean;
  /** Step id routed to after the visit, `done` or `blocked`. */
  next: string;
  headSha?: string;
  /**
   * Differs from the span's `scope` when the visit put another work item on
   * the bench (`next-work`, `sync`). Absent in older logs.
   */
  scopeAfter?: string;
};

/** Appended before the agent call, so a crash during the call leaves it in the log. */
export type AgentStartEvent = Base & {
  type: "iteration.agent.start";
  spanId: string;
  n: number;
  kind: AgentKind;
  model: string;
  resumedSession?: string;
  /** The end event's `logPath` replaces it when a retry wrote a sibling file. Absent in older logs. */
  logPath?: string;
};

export type AgentEndEvent = Base & {
  type: "iteration.agent.end";
  spanId: string;
  n: number;
  outcome: AgentOutcome;
  commits: string[];
  sessionId?: string;
  usage?: TokenUsage;
  logPath?: string;
};

/** Appended before the `prepare` call, so a crash during it leaves it in the log. */
export type PrepareStartEvent = Base & { type: "prepare.start"; spanId: string };

export type PrepareEndEvent = Base & { type: "prepare.end"; spanId: string; agent: "run" | "skip"; reason?: string };

export type EvalStartEvent = Base & { type: "iteration.eval.start"; spanId: string; n: number };

export type EvalEndEvent = Base & { type: "iteration.eval.end"; spanId: string; n: number; ok: boolean };

/** An envelope with its eval, in the scope it was produced in. */
export type OutputEvent = Base & {
  type: "output";
  spanId: string;
  step: string;
  iteration: number;
  scope: string;
  sessionId?: string;
  envelope: Envelope;
  eval: { ok: boolean; logTail: string };
};

/** Only when a skill was expected, reported or read; problems are warnings, not failures. */
export type SkillsEvent = Base & { type: "skills"; spanId: string; n: number } & SkillAudit;

export type Event =
  | RunStartEvent
  | RunEndEvent
  | SpanOpenEvent
  | SpanCloseEvent
  | PrepareStartEvent
  | PrepareEndEvent
  | AgentStartEvent
  | AgentEndEvent
  | EvalStartEvent
  | EvalEndEvent
  | OutputEvent
  | SkillsEvent;

export type EventType = Event["type"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type PendingEvent = DistributiveOmit<Event, "at">;

const REQUIRED: Record<EventType, readonly string[]> = {
  "run.start": ["runId", "pid", "host", "sha", "flow"],
  "run.end": ["runId", "outcome"],
  "span.open": ["runId", "spanId", "step", "scope"],
  "span.close": ["spanId", "ok", "next"],
  "prepare.start": ["spanId"],
  "prepare.end": ["spanId", "agent"],
  "iteration.agent.start": ["spanId", "n", "kind", "model"],
  "iteration.agent.end": ["spanId", "n", "outcome", "commits"],
  "iteration.eval.start": ["spanId", "n"],
  "iteration.eval.end": ["spanId", "n", "ok"],
  output: ["spanId", "step", "iteration", "scope", "envelope", "eval"],
  skills: ["spanId", "n", "expected", "reported", "read", "problems"],
};

const OUTCOMES: Partial<Record<EventType, readonly string[]>> = {
  "run.end": RUN_OUTCOMES,
  "iteration.agent.end": AGENT_OUTCOMES,
};

const PREPARE_AGENT = ["run", "skip"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export const isEvent = (value: unknown): value is Event => {
  if (!isRecord(value) || typeof value["type"] !== "string" || typeof value["at"] !== "string") return false;
  const required = REQUIRED[value["type"] as EventType];
  if (required === undefined || !required.every((key) => value[key] !== undefined)) return false;
  if (value["type"] === "prepare.end" && !(PREPARE_AGENT as readonly unknown[]).includes(value["agent"])) return false;
  const outcomes = OUTCOMES[value["type"] as EventType];
  return outcomes === undefined || outcomes.includes(value["outcome"] as string);
};

export const isOutput = (event: Event): event is OutputEvent => event.type === "output";
