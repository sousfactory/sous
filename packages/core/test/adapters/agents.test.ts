import { describe, expect, it } from "vitest";
import { claude, claudeToolCalls } from "../../src/adapters/agents/claude.js";
import { codex } from "../../src/adapters/agents/codex.js";
import { parseJsonLine } from "../../src/adapters/agents/provider.js";
import { selectAgent } from "../../src/adapters/agent.js";

describe("selectAgent", () => {
  it("maps the entry's agent kind to its provider module", () => {
    expect(selectAgent({ kind: "claude", model: "claude-x" })).toBe(claude);
    expect(selectAgent({ kind: "codex", model: "gpt-x" })).toBe(codex);
  });
});

describe("parseJsonLine", () => {
  it("returns the object of a JSON line and nothing for anything else", () => {
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLine("[1]")).toBeUndefined();
    expect(parseJsonLine("{not json")).toBeUndefined();
    expect(parseJsonLine("plain text")).toBeUndefined();
  });
});

describe("claude", () => {
  it("builds the print command with the prompt on stdin, bypassing permissions, resuming when asked", () => {
    expect(claude.buildCommand({ model: "claude-x", prompt: "Implement #12" })).toEqual({
      argv: ["claude", "--print", "--verbose", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--model", "claude-x", "-p", "-"],
      stdin: "Implement #12",
    });
    expect(claude.buildCommand({ model: "claude-x", prompt: "again", resumeSession: "s1" }).argv).toContain("--resume");
    expect(claude.buildCommand({ model: "claude-x", prompt: "again", resumeSession: "s1" }).argv.join(" ")).toContain("--resume s1 -p -");
  });

  it("reads the session id, the assistant's text and tool calls with their full input, and the result with its usage", () => {
    expect(claude.parseLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }))).toEqual([{ type: "session", id: "s1" }]);
    const assistant = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hm" },
          { type: "tool_use", name: "Read", input: { file_path: "/r/skills/tdd/SKILL.md" } },
          { type: "tool_use", name: "Skill", input: { skill: "tdd" } },
        ],
      },
    });
    expect(claude.parseLine(assistant)).toEqual([
      { type: "text", text: "hm" },
      { type: "tool", call: { name: "Read", input: { file_path: "/r/skills/tdd/SKILL.md" } } },
      { type: "tool", call: { name: "Skill", input: { skill: "tdd" } } },
    ]);
    expect(claudeToolCalls(assistant)).toEqual([
      { name: "Read", input: { file_path: "/r/skills/tdd/SKILL.md" } },
      { name: "Skill", input: { skill: "tdd" } },
    ]);
    const result = JSON.stringify({
      type: "result",
      result: "<result>{}</result>",
      usage: { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 50, cache_read_input_tokens: 9000 },
    });
    expect(claude.parseLine(result)).toEqual([
      { type: "result", text: "<result>{}</result>" },
      { type: "usage", usage: { inputTokens: 1200, outputTokens: 340, cacheCreationInputTokens: 50, cacheReadInputTokens: 9000 } },
    ]);
    expect(claude.parseLine(JSON.stringify({ type: "result", subtype: "error_max_turns" }))).toEqual([]);
    expect(claude.parseLine('{"type":"user","message":{"content":[]}}')).toEqual([]);
    expect(claude.parseLine("plain text")).toEqual([]);
  });
});

describe("codex", () => {
  it("builds the exec command with the prompt on stdin, and the resume subcommand when asked", () => {
    expect(codex.buildCommand({ model: "gpt-x", prompt: "Implement #12" })).toEqual({
      argv: ["codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-x", "-"],
      stdin: "Implement #12",
    });
    expect(codex.buildCommand({ model: "gpt-x", prompt: "again", resumeSession: "t1" }).argv).toEqual([
      "codex",
      "exec",
      "resume",
      "t1",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-x",
      "-",
    ]);
  });

  it("reads the thread id, agent messages as text and result, commands as Bash calls, errors and usage", () => {
    expect(codex.parseLine(JSON.stringify({ type: "thread.started", thread_id: "t1" }))).toEqual([{ type: "session", id: "t1" }]);
    expect(codex.parseLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }))).toEqual([
      { type: "text", text: "done" },
      { type: "result", text: "done" },
    ]);
    expect(codex.parseLine(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "cat skills/tdd/SKILL.md" } }))).toEqual([
      { type: "tool", call: { name: "Bash", input: { command: "cat skills/tdd/SKILL.md" } } },
    ]);
    expect(codex.parseLine(JSON.stringify({ type: "error", error: { message: "unsupported model" } }))).toEqual([{ type: "result", text: "unsupported model" }]);
    expect(codex.parseLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } }))).toEqual([
      { type: "usage", usage: { inputTokens: 600, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 400 } },
    ]);
    expect(codex.parseLine(JSON.stringify({ type: "item.completed", item: { type: "reasoning" } }))).toEqual([]);
  });
});
