/**
 * Builders for sessions, event logs and project folders. Times are minutes
 * after a fixed start so expected durations are easy to read.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, Session, StepRecord, Topology } from "sous-factory/read";

export const at = (minute: number): string => new Date(Date.UTC(2026, 9, 4, 12, minute, 0)).toISOString();

export const session = (patch: Partial<Session> = {}): Session => ({
  schemaVersion: 8,
  flow: "task",
  issue: "84",
  title: "shorten the KDoc",
  branch: "feature/84-shorten-the-kdoc",
  specDir: "specs/84-shorten-the-kdoc",
  current: "implement",
  previous: "init",
  work: "84",
  scopes: {},
  workProgress: { "84": { state: "open", commits: [] } },
  history: [],
  iterations: {},
  blocked: false,
  closed: false,
  ...patch,
});

export const record = (patch: Partial<StepRecord> = {}): StepRecord => ({ visits: 1, ok: true, log: "", output: undefined, commits: [], ...patch });

/** init → implement → review ⇄ fix, review → merge. */
export const taskTopology: Topology = {
  entry: "init",
  nodes: [
    { id: "init", uses: "init" },
    { id: "implement", uses: "implement", agent: { kind: "claude", model: "claude-opus-5-5" } },
    { id: "review", uses: "review", agent: { kind: "codex", model: "gpt-5.5" } },
    { id: "fix", uses: "fix", agent: { kind: "claude", model: "claude-opus-5-5" } },
    { id: "merge", uses: "merge" },
  ],
  edges: [
    { from: "init", to: "implement" },
    { from: "implement", to: "review" },
    { from: "implement", to: "blocked", exhausted: true },
    { from: "review", to: "merge", when: "res.ok" },
    { from: "review", to: "blocked", when: "steps.review.visits >= 3" },
    { from: "review", to: "fix" },
    { from: "review", to: "blocked", exhausted: true },
    { from: "fix", to: "review" },
    { from: "fix", to: "blocked", exhausted: true },
    { from: "merge", to: "done" },
  ],
};

/** Event log builder: one run segment at a time, spans numbered within it. */
export class Log {
  readonly events: Event[] = [];
  private runId = "";
  private n = 0;

  start(runId: string, minute: number, extra: Partial<Extract<Event, { type: "run.start" }>> = {}): this {
    this.runId = runId;
    this.n = 0;
    this.events.push({ type: "run.start", at: at(minute), runId, pid: 1, host: "h", sha: "abc1234", flow: "task", ...extra });
    return this;
  }

  /** A visit: opens at `from`; closes at `to` with `ok`/`next` (and `scopeAfter`, when given) unless `to` is undefined. */
  visit(step: string, from: number, to: number | undefined, ok = true, next = "x", scope = "84", agent = false, scopeAfter?: string): this {
    const spanId = `${this.runId}-${++this.n}`;
    this.events.push({ type: "span.open", at: at(from), runId: this.runId, spanId, step, scope });
    const logPath = `/x/logs/84/${spanId}-${scope}-${step}-1.log`;
    if (agent) this.events.push({ type: "iteration.agent.start", at: at(from), spanId, n: 1, kind: "claude", model: "m", logPath });
    if (to !== undefined) {
      if (agent) this.events.push({ type: "iteration.agent.end", at: at(to), spanId, n: 1, outcome: "ok", commits: [], logPath });
      this.events.push({ type: "span.close", at: at(to), spanId, ok, next, ...(scopeAfter !== undefined ? { scopeAfter } : {}) });
    }
    return this;
  }

  end(minute: number, outcome: "done" | "blocked" | "crashed" | "interrupted", error?: string): this {
    this.events.push({ type: "run.end", at: at(minute), runId: this.runId, outcome, ...(error !== undefined ? { error } : {}) });
    return this;
  }

  jsonl(): string {
    return this.events.map((e) => `${JSON.stringify(e)}\n`).join("");
  }
}

export const TASK_YAML = `entry: init
steps:
  - id: init
    uses: init
    routes:
      - to: implement
  - id: implement
    uses: implement
    agent: { kind: claude, model: claude-opus-5-5 }
    routes:
      - to: merge
  - id: merge
    uses: merge
    routes:
      - to: done
`;

/** A project root (`<tmp>/repo/.sous`) with sous.yaml, the task flow and empty runs/logs. */
export const tempProject = (): string => {
  const root = join(mkdtempSync(join(tmpdir(), "sous-ui-")), "repo", ".sous");
  mkdirSync(join(root, "flows"), { recursive: true });
  mkdirSync(join(root, "runs"), { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(join(root, "sous.yaml"), "runsDir: runs\n");
  writeFileSync(join(root, "flows", "task.yaml"), TASK_YAML);
  return root;
};

export const writeRun = (root: string, issue: string, s: Session | string, log?: Log): void => {
  const dir = join(root, "runs", issue);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), typeof s === "string" ? s : JSON.stringify(s, null, 2));
  if (log !== undefined) writeFileSync(join(dir, "events.jsonl"), log.jsonl());
};
