/**
 * Flows built from the `fixtures/exec/steps` library and run through
 * the real executor over the in-memory fakes. `visit` runs one entry and
 * stubs every step its routes name, so `next` is observable.
 */
import { join } from "node:path";
import { DONE, TERMINALS, type Agent, type LoadedEntry, type Flow } from "../../src/config/flow.js";
import { isAgentic, loadStep, type Step } from "../../src/config/step.js";
import { runFlow, type ExecutorPorts } from "../../src/exec/executor.js";
import type { Session } from "../../src/exec/scope.js";
import type { AgentRequest } from "../../src/ports/sandbox.js";
import { createSession } from "../../src/session/update.js";
import { fixture } from "../helpers.js";
import { fakeEventLog, type FakeEventLog } from "./eventlog.js";
import { fakeGit, type FakeGit } from "./git.js";
import { fakeTracker, issue, type FakeTracker } from "./tracker.js";
import { agentResult, envelope, fakeSandbox, type FakeSandbox } from "./sandbox.js";

export const execRoot = fixture("exec");

export const CLAUDE: Agent = { kind: "claude", model: "claude-x" };
export const CODEX: Agent = { kind: "codex", model: "gpt-x" };

const loaded = new Map<string, Step>();

export const stepOf = (name: string): Step => {
  const cached = loaded.get(name);
  if (cached !== undefined) return cached;
  const step = loadStep(fixture("exec", "steps", name));
  loaded.set(name, step);
  return step;
};

/** An entry using fixture step `uses`, routed to `done` unless told otherwise; agentic steps get Claude. */
export const entryOf = (id: string, uses: string, overrides: Partial<Omit<LoadedEntry, "id" | "uses" | "step">> = {}): LoadedEntry => {
  const step = stepOf(uses);
  return { id, uses, with: {}, routes: [{ to: DONE }], ...(isAgentic(step) ? { agent: CLAUDE } : {}), ...overrides, step };
};

export const flowOf = (...entries: LoadedEntry[]): Flow => {
  const first = entries[0];
  if (first === undefined) throw new Error("flowOf needs at least one entry");
  return { name: "test", file: "/test/flows/test.yaml", entry: first.id, steps: entries };
};

export const sessionOf = (entry: string, overrides: Partial<Session> = {}): Session => ({
  ...createSession({ flow: "test", issue: "1", title: "Test issue", branch: "feature/1-test-issue", specDir: "specs/1-test-issue", entry }),
  ...overrides,
});

/** A ticking clock: 09:00:00Z, 09:00:01Z, … */
export const fakeClock = (): (() => Date) => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 9, 2, 9, 0, tick++));
};

export const silentLog = { info: () => undefined, warn: () => undefined };

/** An agent answer whose eval (fixture `agent`) passes or fails with `log`. */
export const answer = (sessionId: string, ok = true, log?: string, commits: string[] = [`c-${sessionId}`]) =>
  agentResult(sessionId, envelope({ commits, output: { ok, ...(log !== undefined ? { log } : {}) } }));

export type Transition = { from: string; to: string; ok: boolean };

/** The ports a test may replace; the fakes stay fakes so their recorders are readable. */
export type FakePortOverrides = Partial<Omit<ExecutorPorts, "sandbox" | "git" | "tracker" | "events" | "persist" | "onTransition">> & {
  git?: FakeGit;
  tracker?: FakeTracker;
  events?: FakeEventLog;
};

export type FakePorts = ExecutorPorts & {
  readonly sandbox: FakeSandbox;
  readonly git: FakeGit;
  readonly tracker: FakeTracker;
  readonly events: FakeEventLog;
  readonly persisted: Session[];
  readonly transitions: Transition[];
};

export const portsOf = (sandbox: FakeSandbox = fakeSandbox(), overrides: FakePortOverrides = {}): FakePorts => {
  const persisted: Session[] = [];
  const transitions: Transition[] = [];
  const events = overrides.events ?? fakeEventLog();
  const target = overrides.issue ?? issue({ id: "1", title: "Test issue" });
  const tracker = overrides.tracker ?? fakeTracker({ issues: [issue({ id: "1", title: "Test issue" })] });
  const git = overrides.git ?? fakeGit();
  return {
    issue: target,
    work: { id: target.id, ref: target.ref, title: target.title, body: target.body },
    clock: fakeClock(),
    skillsDir: join(execRoot, "skills"),
    logsDir: join(execRoot, "logs"),
    repoRoot: "/repo",
    log: silentLog,
    runId: "r1",
    ...overrides,
    git,
    tracker,
    sandbox,
    events,
    persisted,
    transitions,
    persist: async (s) => {
      persisted.push(s);
    },
    onTransition: async (s, to) => {
      const from = s.history.at(-1)?.step ?? "?";
      transitions.push({ from, to, ok: s.history.at(-1)?.ok ?? false });
    },
  };
};

/** Every route target of `entries` that is not an entry itself, as a `void` step going to `done`. */
const stubs = (entries: readonly LoadedEntry[]): LoadedEntry[] => {
  const ids = new Set(entries.map((e) => e.id));
  const targets = new Set(entries.flatMap((e) => e.routes.map((r) => r.to)).filter((t) => !ids.has(t) && !TERMINALS.includes(t)));
  return [...targets].map((id) => entryOf(id, "void"));
};

export type Visit = {
  session: Session;
  sandbox: FakeSandbox;
  requests: AgentRequest[];
  /** Where the entry went. */
  next: string;
  ports: FakePorts;
};

/** One visit to `entry` through the real executor; the steps its routes name are stubs. */
export const visit = async (entry: LoadedEntry, session: Session = sessionOf(entry.id), ports: FakePorts = portsOf()): Promise<Visit> => {
  const final = await runFlow(flowOf(entry, ...stubs([entry])), session, ports);
  const first = ports.transitions[0];
  if (first === undefined) throw new Error("visit: no transition recorded");
  return { session: final, sandbox: ports.sandbox, requests: ports.sandbox.requests, next: first.to, ports };
};
