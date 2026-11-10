/**
 * What an agent CLI is to sous: a command line for one call and a parser for
 * the lines it streams back. One module per agent (`claude.ts`, `codex.ts`),
 * nothing else differs between them. The runner, the log, the envelope and
 * the retry are shared and live in `../sandbox.ts`.
 */
import type { ToolCall } from "../../ports/sandbox.js";
import type { TokenUsage } from "../../session/events.js";

export type CommandRequest = {
  model: string;
  prompt: string;
  /** The agent's own session to continue; the CLI's resume flag. */
  resumeSession?: string;
};

/** `argv[0]` is the executable; the prompt goes on stdin, never into argv (Linux caps argv at 128 KiB). */
export type AgentCommand = { argv: string[]; stdin: string };

export type StreamEvent =
  /** The session id the CLI assigned or continued; the last one seen is the call's. */
  | { type: "session"; id: string }
  /** A piece of the agent's prose, in order. */
  | { type: "text"; text: string }
  /** The agent's final answer, when the CLI marks one; the envelope is looked for here first. */
  | { type: "result"; text: string }
  | { type: "tool"; call: ToolCall }
  | { type: "usage"; usage: TokenUsage }
  /** The call's cost in US dollars as the CLI reports it; a CLI that reports none never emits it. */
  | { type: "cost"; usd: number };

export type Provider = {
  /** The agent's name in error messages: `claude exited with code 1`. */
  name: string;
  buildCommand(req: CommandRequest): AgentCommand;
  /** The events of one stdout line; none for a line that is not the CLI's JSON. */
  parseLine(line: string): StreamEvent[];
};

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The object of a JSON line, or undefined for any other line. */
export const parseJsonLine = (line: string): Record<string, unknown> | undefined => {
  if (!line.startsWith("{")) return undefined;
  try {
    const obj: unknown = JSON.parse(line);
    return isRecord(obj) ? obj : undefined;
  } catch {
    return undefined;
  }
};
