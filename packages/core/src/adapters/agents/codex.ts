/**
 * Codex in `exec` mode with `--json`: one event per line. `thread.started`
 * carries the session id (a thread to Codex), a completed `agent_message`
 * item the prose, a started `command_execution` item the command it runs
 * (Codex has no read tool; the skill audit sees a `cat` as a Bash call), and
 * `turn.completed` the usage. A resume is the `resume` subcommand, not a
 * flag.
 */
import type { TokenUsage } from "../../session/events.js";
import { isRecord, parseJsonLine, type Provider, type StreamEvent } from "./provider.js";

const usageOf = (value: unknown): TokenUsage | undefined => {
  if (!isRecord(value)) return undefined;
  const { input_tokens, cached_input_tokens, output_tokens } = value;
  if (typeof input_tokens !== "number" || typeof output_tokens !== "number") return undefined;
  const cached = typeof cached_input_tokens === "number" ? cached_input_tokens : 0;
  return { inputTokens: input_tokens - cached, outputTokens: output_tokens, cacheCreationInputTokens: 0, cacheReadInputTokens: cached };
};

const errorMessage = (obj: Record<string, unknown>): string | undefined => {
  const error = obj["error"];
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error["message"] === "string") return error["message"];
  return typeof obj["message"] === "string" ? obj["message"] : undefined;
};

export const codex: Provider = {
  name: "codex",
  buildCommand: ({ model, prompt, resumeSession }) => ({
    argv: ["codex", "exec", ...(resumeSession !== undefined ? ["resume", resumeSession] : []), "--json", "--dangerously-bypass-approvals-and-sandbox", "-m", model, "-"],
    stdin: prompt,
  }),
  parseLine: (line) => {
    const obj = parseJsonLine(line);
    if (obj === undefined) return [];
    const item = isRecord(obj["item"]) ? obj["item"] : undefined;
    if (obj["type"] === "thread.started" && typeof obj["thread_id"] === "string") return [{ type: "session", id: obj["thread_id"] }];
    if (obj["type"] === "item.completed" && item?.["type"] === "agent_message" && typeof item["text"] === "string") {
      return [
        { type: "text", text: item["text"] },
        { type: "result", text: item["text"] },
      ];
    }
    if (obj["type"] === "item.started" && item?.["type"] === "command_execution" && typeof item["command"] === "string") {
      return [{ type: "tool", call: { name: "Bash", input: { command: item["command"] } } }];
    }
    if (obj["type"] === "error") {
      const message = errorMessage(obj);
      return message !== undefined ? [{ type: "result", text: message } satisfies StreamEvent] : [];
    }
    if (obj["type"] === "turn.completed") {
      const usage = usageOf(obj["usage"]);
      return usage !== undefined ? [{ type: "usage", usage }] : [];
    }
    return [];
  },
};
