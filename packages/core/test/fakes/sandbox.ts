import { interruptedBy } from "../../src/exec/errors.js";
import type { Envelope, ExecResult } from "../../src/index.js";
import type { AgentRequest, AgentResult, Sandbox } from "../../src/ports/sandbox.js";

export type FakeSandbox = Sandbox & {
  readonly requests: AgentRequest[];
  readonly execs: string[];
  /** Every exec call with its cwd (`undefined` means the worktree root). */
  readonly execCalls: { command: string; cwd: string | undefined }[];
  readonly closed: boolean;
  /** Agent calls the signal aborted while they were in flight. */
  readonly abortedCalls: number;
};

/** An agent call that never answers: it rejects with `InterruptedError` once the sandbox's signal aborts. */
export type UntilAborted = { untilAborted: true; onStart?: () => void };

/**
 * An agent call that runs until the run is interrupted; `onStart` runs once
 * the call listens for the abort (to fire a signal mid-call).
 */
export const untilAborted = (onStart?: () => void): UntilAborted => ({ untilAborted: true, ...(onStart !== undefined ? { onStart } : {}) });

/** One scripted agent call: a result, an Error to throw, a function of the request (to flip other fakes as the "agent" works), or a call that waits for the abort. */
export type AgentScript = AgentResult | Error | ((req: AgentRequest) => AgentResult) | UntilAborted;

export type FakeSandboxOptions = {
  /** Scripted agent results, consumed in order. */
  agent?: AgentScript[];
  /** Scripted exec results by command; a list is consumed in order and its last entry sticks. Unknown commands succeed with empty output. */
  exec?: Record<string, ExecResult | ExecResult[]>;
  worktreePath?: string;
  branch?: string;
  /** The run's interrupt, as `openSandbox` gets it: once aborted, `runAgent` and `exec` reject with `InterruptedError`. */
  signal?: AbortSignal;
};

export const envelope = (overrides: Partial<Envelope> = {}): Envelope => ({
  summary: "did the thing",
  commits: ["abc123"],
  output: {},
  ...overrides,
});

export const agentResult = (sessionId: string, env: Envelope = envelope()): AgentResult => ({ envelope: env, sessionId });

export const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
export const fail = (stderr = "boom", code = 1): ExecResult => ({ code, stdout: "", stderr });

export const fakeSandbox = (options: FakeSandboxOptions = {}): FakeSandbox => {
  const scripted = [...(options.agent ?? [])];
  const execScripts = new Map(Object.entries(options.exec ?? {}).map(([command, results]) => [command, Array.isArray(results) ? [...results] : [results]]));
  const requests: AgentRequest[] = [];
  const execs: string[] = [];
  const execCalls: FakeSandbox["execCalls"] = [];
  let closed = false;
  let abortedCalls = 0;
  const { signal } = options;
  const waitForAbort = (script: UntilAborted): Promise<AgentResult> =>
    new Promise((_, reject) => {
      if (signal === undefined) throw new Error("fakeSandbox: untilAborted needs a signal");
      const onAbort = () => {
        abortedCalls++;
        reject(interruptedBy(signal));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      script.onStart?.();
    });
  return {
    worktreePath: options.worktreePath ?? "/tmp/worktree",
    branch: options.branch ?? "feature/1-test",
    requests,
    execs,
    execCalls,
    get closed() {
      return closed;
    },
    get abortedCalls() {
      return abortedCalls;
    },
    async runAgent(req) {
      if (signal?.aborted === true) throw interruptedBy(signal);
      requests.push(req);
      const next = scripted.shift();
      if (next === undefined) throw new Error(`fakeSandbox: no scripted agent result for request #${requests.length} (${req.logPath})`);
      if (next instanceof Error) throw next;
      if ("untilAborted" in next) return waitForAbort(next);
      return typeof next === "function" ? next(req) : next;
    },
    async exec(command, execOptions) {
      if (signal?.aborted === true) throw interruptedBy(signal);
      execs.push(command);
      execCalls.push({ command, cwd: execOptions?.cwd });
      const queue = execScripts.get(command);
      if (queue === undefined) return ok();
      return (queue.length > 1 ? queue.shift() : queue[0]) ?? ok();
    },
    async close() {
      closed = true;
    },
  };
};
