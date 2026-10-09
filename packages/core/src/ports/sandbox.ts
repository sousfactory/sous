/**
 * Where agents and eval commands run: one issue worktree. Keeps sandcastle
 * behind a seam so tests can script it and steps never import it.
 *
 * The sandbox is opened with the run's abort signal. Once it aborts, the
 * agent process and any command in flight are terminated, and `runAgent`
 * and `exec` reject with `InterruptedError` (`exec` throws nothing else).
 */
import type { Agent } from "../config/flow.js";
import type { Envelope, ExecOptions, ExecResult } from "../index.js";
import type { TokenUsage } from "../session/events.js";

/** One agent call. The prompt arrives rendered; the executor owns retry and invalid-output texts. */
export type AgentRequest = {
  agent: Agent;
  prompt: string;
  /** Agent session to continue (iterations >= 2, or an explicit `resume`). */
  resumeSession?: string;
  /** The in-session retry for invalid output logs to a sibling file. */
  logPath: string;
  /** The step's `run.output` schema; the envelope's `output` must match it. */
  outputSchema: Record<string, unknown>;
};

/** One tool call of the agent, with its input as the provider sent it (`file_path`, `command`, `skill`, …). */
export type ToolCall = { name: string; input: Record<string, unknown> };

export type AgentResult = {
  envelope: Envelope;
  /** Undefined for providers that do not expose session ids. */
  sessionId?: string;
  /** Of the call that produced the envelope; Claude only. */
  usage?: TokenUsage;
  /** Of the call that produced the envelope: the retry's file after a retry. */
  logPath?: string;
  /** In order, the invalid-output retry's included; feeds the skill audit. */
  toolCalls?: ToolCall[];
};

export type Sandbox = {
  readonly worktreePath: string;
  readonly branch: string;
  runAgent(req: AgentRequest): Promise<AgentResult>;
  /** Never throws (the `Ctx.exec` contract), except `InterruptedError` once the run is interrupted. */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /** Tear the sandbox down; a clean worktree is removed, a dirty one is kept. */
  close(): Promise<void>;
};
