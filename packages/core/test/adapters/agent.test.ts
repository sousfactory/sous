import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRunOptions, SandboxRunResult } from "@ai-hero/sandcastle";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunOptions, envelopeSchema, lastTagContent, parseEnvelope, selectAgent, unwrapFences } from "../../src/adapters/agent.js";
import { ensureLogDir, logDir, logName, logPath, withAttempt } from "../../src/adapters/logs.js";
import { createRunAgent } from "../../src/adapters/sandcastle.js";
import { AgentOutputError, AgentProcessError } from "../../src/exec/errors.js";
import type { AgentRequest } from "../../src/ports/sandbox.js";
import { skillsSchema } from "../../src/skills.js";

const workSchema = {
  type: "object",
  required: ["filesTouched", "testsRun"],
  properties: { filesTouched: { type: "array", items: { type: "string" } }, testsRun: { type: "array", items: { type: "string" } } },
};
const reviewSchema = {
  type: "object",
  required: ["verdict", "findings"],
  properties: { verdict: { enum: ["clean", "findings"] }, findings: { type: "array" } },
};

const request = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
  agent: { kind: "claude", model: "claude-x" },
  prompt: "Implement #12",
  logPath: "/logs/12/build-1.log",
  outputSchema: workSchema,
  ...overrides,
});

const work = { summary: "done", commits: ["abc"], output: { filesTouched: ["a.kt"], testsRun: ["./gradlew test"] }, skills: [{ name: "tdd", status: "followed" }] };
const tagged = (body: string): string => `thinking…\n<result>${body}</result>\n`;

describe("logs", () => {
  const call = { spanId: "a1b2c3d4-3", scope: "12", step: "build", iteration: 2 };

  it("names one log per agent call under logsDir, after span, scope, step and iteration, with a suffix for the in-session output retry", () => {
    expect(logDir("/p/logs", "12")).toBe("/p/logs/12");
    expect(logName(call)).toBe("a1b2c3d4-3-12-build-2.log");
    expect(logPath("/p/logs", "12", call)).toBe("/p/logs/12/a1b2c3d4-3-12-build-2.log");
    expect(logPath("/p/logs", "12", call, 2)).toBe("/p/logs/12/a1b2c3d4-3-12-build-2.2.log");
    expect(logPath("/p/logs", "12", { ...call, step: "review-full", iteration: 1 })).toBe("/p/logs/12/a1b2c3d4-3-12-review-full-1.log");
  });

  it("never names two agent calls alike: other work item, re-visit of the step, other run segment", () => {
    const names = [
      call,
      { ...call, scope: "13" },
      { ...call, spanId: "a1b2c3d4-5" },
      { ...call, spanId: "e5f6a7b8-3" },
    ].map((c) => logName(c));
    expect(new Set(names).size).toBe(names.length);
  });

  it("withAttempt derives the retry file from the call's file and back", () => {
    const first = logPath("/p/logs", "12", { ...call, iteration: 1 });
    expect(withAttempt(first, 2)).toBe("/p/logs/12/a1b2c3d4-3-12-build-1.2.log");
    expect(withAttempt(withAttempt(first, 2), 3)).toBe("/p/logs/12/a1b2c3d4-3-12-build-1.3.log");
    expect(withAttempt(withAttempt(first, 2), 1)).toBe(first);
    expect(withAttempt("/p/logs/12/build-1.log", 2)).toBe("/p/logs/12/build-1.2.log");
  });
});

describe("selectAgent", () => {
  it("maps claude to Claude Code and codex to Codex, from the entry's agent", () => {
    expect(selectAgent({ kind: "claude", model: "claude-x" }).name).toBe("claude-code");
    expect(selectAgent({ kind: "codex", model: "gpt-x" }).name).toBe("codex");
  });
});

describe("envelope extraction", () => {
  it("takes the last complete <result> block", () => {
    expect(lastTagContent("<result>one</result> text <result>two</result> <result>open")).toBe("two");
    expect(lastTagContent("no tag here")).toBeUndefined();
    expect(lastTagContent("<result>unterminated")).toBeUndefined();
  });

  it("unwraps a json fence", () => {
    expect(unwrapFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(unwrapFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(unwrapFences('{"a":1}')).toBe('{"a":1}');
  });

  it("wraps the step's output schema in the envelope schema", () => {
    expect(envelopeSchema(workSchema)).toEqual({
      type: "object",
      required: ["summary", "commits", "output", "skills"],
      properties: { summary: { type: "string" }, commits: { type: "array", items: { type: "string" } }, output: workSchema, skills: skillsSchema },
    });
  });

  it("parses a valid envelope, fenced or not", () => {
    expect(parseEnvelope(tagged(JSON.stringify(work)), workSchema)).toEqual({ ok: true, envelope: work });
    expect(parseEnvelope(tagged(`\`\`\`json\n${JSON.stringify(work)}\n\`\`\``), workSchema)).toEqual({ ok: true, envelope: work });
  });

  it("reports a missing tag, invalid JSON, envelope and output schema failures with the raw match", () => {
    expect(parseEnvelope("nothing", workSchema)).toEqual({ ok: false, reason: "no <result> tag in the agent output", rawMatched: undefined });
    const bad = parseEnvelope(tagged("{not json"), workSchema);
    expect(bad).toMatchObject({ ok: false, rawMatched: "{not json" });
    expect(bad.ok === false && bad.reason).toContain("not valid JSON");

    const noSkills = parseEnvelope(tagged('{"summary":"s","commits":[],"output":{"filesTouched":[],"testsRun":[]}}'), workSchema);
    expect(noSkills.ok === false && noSkills.reason).toContain("must have required property 'skills'");

    const badStatus = parseEnvelope(tagged('{"summary":"s","commits":[],"output":{"filesTouched":[],"testsRun":[]},"skills":[{"name":"tdd","status":"read"}]}'), workSchema);
    expect(badStatus.ok === false && badStatus.reason).toContain("/skills/0/status must be equal to one of the allowed values");

    const noCommits = parseEnvelope(tagged('{"summary":"s","output":{"filesTouched":[],"testsRun":[]}}'), workSchema);
    expect(noCommits.ok === false && noCommits.reason).toContain("must have required property 'commits'");

    const blockers = parseEnvelope(tagged('{"summary":"s","commits":[],"blockers":[],"payload":{}}'), workSchema);
    expect(blockers.ok === false && blockers.reason).toContain("must have required property 'output'");

    const review = parseEnvelope(tagged('{"summary":"s","commits":[],"output":{"verdict":"meh","findings":[]}}'), reviewSchema);
    expect(review.ok).toBe(false);
    expect(review.ok === false && review.reason).toContain("/output/verdict must be equal to one of the allowed values");
  });
});

describe("buildRunOptions", () => {
  const agent = selectAgent({ kind: "claude", model: "claude-x" });
  const deps = { agent, idleTimeoutSeconds: 1800 };

  it("sends the rendered prompt inline, logged to the request's file", () => {
    expect(buildRunOptions(request(), deps)).toEqual({
      agent,
      prompt: "Implement #12",
      idleTimeoutSeconds: 1800,
      logging: { type: "file", path: "/logs/12/build-1.log" },
    });
  });

  it("passes a resume through", () => {
    expect(buildRunOptions(request({ resumeSession: "b1" }), deps)).toMatchObject({ prompt: "Implement #12", resumeSession: "b1" });
    expect(buildRunOptions(request(), deps)).not.toHaveProperty("resumeSession");
  });
});

describe("createRunAgent", () => {
  let root: string;
  let first: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sous-agent-"));
    first = logPath(root, "12", { spanId: "r1-1", scope: "12", step: "build", iteration: 1 });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const result = (stdout: string, sessionId?: string): SandboxRunResult => ({
    iterations: [sessionId !== undefined ? { sessionId } : {}],
    stdout,
    commits: [],
  });

  /** A scripted sandcastle `run` that records what it was called with; an Error entry is thrown. */
  const scripted = (...results: (SandboxRunResult | Error)[]) => {
    const calls: SandboxRunOptions[] = [];
    const queue = [...results];
    const run = async (options: SandboxRunOptions) => {
      calls.push(options);
      const next = queue.shift();
      if (next === undefined) throw new Error("scripted run: no more results");
      if (next instanceof Error) throw next;
      return next;
    };
    return { run, calls };
  };

  it("returns the envelope and session id of a valid run and creates the log dir", async () => {
    const { run, calls } = scripted(result(tagged(JSON.stringify(work)), "s1"));
    const runAgent = createRunAgent({ run, idleTimeoutSeconds: 60 });

    expect(await runAgent(request({ logPath: first }))).toEqual({ envelope: work, sessionId: "s1", logPath: first, toolCalls: [] });
    expect(calls).toEqual([
      expect.objectContaining({ prompt: "Implement #12", idleTimeoutSeconds: 60, logging: { type: "file", path: first, onAgentStreamEvent: expect.any(Function) } }),
    ]);
    expect((await stat(logDir(root, "12"))).isDirectory()).toBe(true);
  });

  it("passes the token usage of the run through when sandcastle reports it, and leaves it out otherwise", async () => {
    const usage = { inputTokens: 1200, outputTokens: 340, cacheCreationInputTokens: 50, cacheReadInputTokens: 9000 };
    const withUsage = scripted({ iterations: [{ sessionId: "s1", usage }], stdout: tagged(JSON.stringify(work)), commits: [] });
    expect((await createRunAgent({ run: withUsage.run, idleTimeoutSeconds: 60 })(request({ logPath: first }))).usage).toEqual(usage);

    const without = scripted(result(tagged(JSON.stringify(work)), "s1"));
    expect(await createRunAgent({ run: without.run, idleTimeoutSeconds: 60 })(request({ logPath: first }))).not.toHaveProperty("usage");
  });

  it("resumes once with the validation message when the output does not parse, then succeeds", async () => {
    const { run, calls } = scripted(result("no tag", "s1"), result(tagged(JSON.stringify(work)), "s1"));
    const runAgent = createRunAgent({ run, idleTimeoutSeconds: 60 });

    expect(await runAgent(request({ logPath: first }))).toEqual({ envelope: work, sessionId: "s1", logPath: withAttempt(first, 2), toolCalls: [] });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      resumeSession: "s1",
      prompt: expect.stringContaining("Your output did not validate: no <result> tag"),
      idleTimeoutSeconds: 60,
      logging: { type: "file", path: withAttempt(first, 2), onAgentStreamEvent: expect.any(Function) },
    });
  });

  it("collects the tool calls of the run and of its invalid-output retry from the raw stream", async () => {
    const raw = (input: Record<string, unknown>, name = "Read") =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hm" }, { type: "tool_use", name, input }] } });
    const queue = [
      { line: raw({ file_path: "/r/skills/tdd/SKILL.md" }), stdout: "no tag" },
      { line: raw({ command: "cat skills/implement/SKILL.md" }, "Bash"), stdout: tagged(JSON.stringify(work)) },
    ];
    const run = async (options: SandboxRunOptions): Promise<SandboxRunResult> => {
      const next = queue.shift();
      if (next === undefined) throw new Error("no more");
      const emit = options.logging?.type === "file" ? options.logging.onAgentStreamEvent : undefined;
      emit?.({ type: "toolCall", name: "Bash", formattedArgs: "ignored", iteration: 1, timestamp: new Date() });
      emit?.({ type: "raw", line: next.line, iteration: 1, timestamp: new Date() });
      return result(next.stdout, "s1");
    };

    expect((await createRunAgent({ run, idleTimeoutSeconds: 60 })(request({ logPath: first }))).toolCalls).toEqual([
      { name: "Read", input: { file_path: "/r/skills/tdd/SKILL.md" } },
      { name: "Bash", input: { command: "cat skills/implement/SKILL.md" } },
    ]);
  });

  it("throws AgentOutputError with the raw match and session id when the retry is invalid too", async () => {
    const { run, calls } = scripted(result(tagged("{bad"), "s1"), result(tagged("{still bad"), "s1"));
    const runAgent = createRunAgent({ run, idleTimeoutSeconds: 60 });

    const error = await runAgent(request({ logPath: first })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentOutputError);
    expect(error).toMatchObject({ rawMatched: "{still bad", sessionId: "s1", logPath: withAttempt(first, 2) });
    expect((error as Error).message).toContain("not valid JSON");
    expect(calls).toHaveLength(2);
  });

  it("does not retry when no session id was captured", async () => {
    const { run, calls } = scripted(result("nothing"));
    const runAgent = createRunAgent({ run, idleTimeoutSeconds: 60 });

    await expect(runAgent(request({ agent: { kind: "codex", model: "gpt-x" }, logPath: first }))).rejects.toMatchObject({
      rawMatched: undefined,
      sessionId: undefined,
      logPath: first,
    });
    expect(calls).toHaveLength(1);
  });

  it("maps a non-zero agent exit to AgentProcessError with the exit code, log path and log tail", async () => {
    const path = logPath(root, "12", { spanId: "r1-2", scope: "12", step: "review", iteration: 1 });
    const failing = async (options: SandboxRunOptions): Promise<SandboxRunResult> => {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
      await writeFile(path, `${lines.join("\n")}\n`);
      expect(options.logging).toEqual({ type: "file", path, onAgentStreamEvent: expect.any(Function) });
      throw new Error("Codex exited with code 1:\nunsupported model gpt-5.4-codex");
    };
    const runAgent = createRunAgent({ run: failing, idleTimeoutSeconds: 60 });

    const error = await runAgent(request({ agent: { kind: "codex", model: "gpt-x" }, logPath: path })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentProcessError);
    expect(error).toMatchObject({ exitCode: 1, logPath: path, sessionId: undefined });
    expect((error as Error).message).toContain("unsupported model gpt-5.4-codex");
    const tail = (error as AgentProcessError).logTail ?? "";
    expect(tail).toContain("line 30");
    expect(tail).not.toContain("line 10\n");
  });

  it("maps an idle timeout to AgentProcessError without an exit code or log tail when no log was written", async () => {
    const { run } = scripted(new Error("Agent idle for 1800 seconds"));
    const runAgent = createRunAgent({ run, idleTimeoutSeconds: 60 });

    const error = await runAgent(request({ logPath: first })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentProcessError);
    expect(error).toMatchObject({ message: "Agent idle for 1800 seconds", exitCode: undefined, logTail: undefined, logPath: first });
  });

  it("keeps the session id when the in-session output retry fails", async () => {
    const { run } = scripted(result("no tag", "s1"), new Error("claude exited with code 2:\nboom"));
    const runAgent = createRunAgent({ run, idleTimeoutSeconds: 60 });

    await expect(runAgent(request({ logPath: first }))).rejects.toMatchObject({ exitCode: 2, sessionId: "s1", logPath: withAttempt(first, 2) });
  });

  it("ensureLogDir is idempotent", async () => {
    expect(await ensureLogDir(root, "3")).toBe(logDir(root, "3"));
    expect(await ensureLogDir(root, "3")).toBe(logDir(root, "3"));
  });
});
