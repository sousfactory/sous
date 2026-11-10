/**
 * Claude Code in print mode with the stream-json output: one JSON object per
 * line. `system/init` carries the session id, each `assistant` message its
 * text and `tool_use` blocks with their full input (the skill audit reads
 * `Read.file_path` and `Skill.skill`), and the final `result` the answer
 * with the token usage and the dollar cost of the call (`total_cost_usd`,
 * the CLI's own figure).
 */
import type { ToolCall } from "../../ports/sandbox.js";
import type { TokenUsage } from "../../session/events.js";
import { isRecord, parseJsonLine, type Provider, type StreamEvent } from "./provider.js";

const usageOf = (value: unknown): TokenUsage | undefined => {
  if (!isRecord(value)) return undefined;
  const { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } = value;
  if (typeof input_tokens !== "number" || typeof output_tokens !== "number") return undefined;
  return {
    inputTokens: input_tokens,
    outputTokens: output_tokens,
    cacheCreationInputTokens: typeof cache_creation_input_tokens === "number" ? cache_creation_input_tokens : 0,
    cacheReadInputTokens: typeof cache_read_input_tokens === "number" ? cache_read_input_tokens : 0,
  };
};

/** The `tool_use` blocks of one `assistant` line, with the input as sent. */
export const claudeToolCalls = (line: string): ToolCall[] => claude.parseLine(line).flatMap((e) => (e.type === "tool" ? [e.call] : []));

export const claude: Provider = {
  name: "claude",
  buildCommand: ({ model, prompt, resumeSession }) => ({
    argv: [
      "claude",
      "--print",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--model",
      model,
      ...(resumeSession !== undefined ? ["--resume", resumeSession] : []),
      "-p",
      "-",
    ],
    stdin: prompt,
  }),
  parseLine: (line) => {
    const obj = parseJsonLine(line);
    if (obj === undefined) return [];
    if (obj["type"] === "system" && obj["subtype"] === "init" && typeof obj["session_id"] === "string") return [{ type: "session", id: obj["session_id"] }];
    if (obj["type"] === "assistant" && isRecord(obj["message"]) && Array.isArray(obj["message"]["content"])) {
      return obj["message"]["content"].flatMap((block: unknown): StreamEvent[] => {
        if (!isRecord(block)) return [];
        if (block["type"] === "text" && typeof block["text"] === "string") return [{ type: "text", text: block["text"] }];
        if (block["type"] === "tool_use" && typeof block["name"] === "string" && isRecord(block["input"])) return [{ type: "tool", call: { name: block["name"], input: block["input"] } }];
        return [];
      });
    }
    if (obj["type"] === "result") {
      const usage = usageOf(obj["usage"]);
      const cost = obj["total_cost_usd"];
      return [
        ...(typeof obj["result"] === "string" ? [{ type: "result", text: obj["result"] } as const] : []),
        ...(usage !== undefined ? [{ type: "usage", usage } as const] : []),
        ...(typeof cost === "number" && Number.isFinite(cost) ? [{ type: "cost", usd: cost } as const] : []),
      ];
    }
    return [];
  },
};
