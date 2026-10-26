import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostExec, HostExecOptions, HostExecResult } from "../../src/adapters/hostexec.js";
import { logDir, logPath, withAttempt } from "../../src/adapters/logs.js";
import {
  createOpenSandbox,
  createRunAgent,
  createSandboxExec,
  formatToolArgs,
  isManagedWorktree,
  toExecResult,
  worktreeFor,
  worktreePathFor,
} from "../../src/adapters/sandbox.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { AgentOutputError, AgentProcessError, InterruptedError } from "../../src/exec/errors.js";
import type { AgentRequest } from "../../src/ports/sandbox.js";
import { createGit } from "../../src/adapters/git.js";
import { fakeGit } from "../fakes/git.js";
import { tempRepo, type TempRepo } from "../helpers/repo.js";

describe("sandbox helpers", () => {
  it("derives the worktree path from the branch under .sous/worktrees, slashes as dashes", () => {
    expect(worktreePathFor("/repo", "feature/12-some-slug")).toBe("/repo/.sous/worktrees/feature-12-some-slug");
  });

  it("knows the worktrees sous made, the pre-0.6.0 location included", () => {
    expect(isManagedWorktree("/repo/.sous/worktrees/feature-12-x")).toBe(true);
    expect(isManagedWorktree("/repo/.sandcastle/worktrees/feature-12-x")).toBe(true);
    expect(isManagedWorktree("/repo")).toBe(false);
    expect(isManagedWorktree("/elsewhere/wt-1")).toBe(false);
  });

  it("maps exitCode to code", () => {
    expect(toExecResult({ stdout: "a", stderr: "b", exitCode: 3 })).toEqual({ code: 3, stdout: "a", stderr: "b" });
  });

  it("formats a tool call's one telling argument for the log", () => {
    expect(formatToolArgs({ command: "ls", description: "list" })).toBe("ls");
    expect(formatToolArgs({ file_path: "/r/a.ts" })).toBe("/r/a.ts");
    expect(formatToolArgs({ skill: "tdd" })).toBe("tdd");
    expect(formatToolArgs({ other: "x".repeat(300) })).toHaveLength(201);
  });
});

describe("worktreeFor", () => {
  it("reuses the worktree the branch is checked out in, under either managed location", async () => {
    const git = fakeGit({ worktrees: { "feature/1-x": "/repo/.sandcastle/worktrees/feature-1-x" } });
    expect(await worktreeFor(git, "/repo", "feature/1-x", "main")).toBe("/repo/.sandcastle/worktrees/feature-1-x");
    expect(git.calls).toEqual(["worktreeOf(/repo, feature/1-x)"]);
  });

  it("adds a new worktree from the base branch when the branch is checked out nowhere", async () => {
    const git = fakeGit();
    expect(await worktreeFor(git, "/repo", "feature/1-x", "main")).toBe("/repo/.sous/worktrees/feature-1-x");
    expect(git.calls).toEqual(["worktreeOf(/repo, feature/1-x)", "addWorktree(/repo, /repo/.sous/worktrees/feature-1-x, feature/1-x, main)"]);
  });

  it("refuses a branch checked out outside the managed worktrees, the primary checkout say", async () => {
    const git = fakeGit({ worktrees: { "feature/1-x": "/repo" } });
    await expect(worktreeFor(git, "/repo", "feature/1-x", "main")).rejects.toThrow(/checked out at \/repo; sous runs it in a worktree of its own/);
  });
});

type Scripted = HostExecResult | Error | ((options: HostExecOptions) => HostExecResult | Promise<HostExecResult>);

/** A scripted host exec: each call takes the next script; a function may stream lines through `onLine` first. */
const scripted = (...scripts: Scripted[]) => {
  const calls: { command: string | readonly string[]; options: HostExecOptions }[] = [];
  const queue = [...scripts];
  const exec: HostExec = async (command, options = {}) => {
    calls.push({ command, options });
    const next = queue.shift();
    if (next === undefined) throw new Error("scripted exec: no more results");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(options) : next;
  };
  return { exec, calls };
};

const ok = (stdout = ""): HostExecResult => ({ stdout, stderr: "", exitCode: 0 });

const workSchema = {
  type: "object",
  required: ["filesTouched", "testsRun"],
  properties: { filesTouched: { type: "array", items: { type: "string" } }, testsRun: { type: "array", items: { type: "string" } } },
};
const work = { summary: "done", commits: ["abc"], output: { filesTouched: ["a.kt"], testsRun: ["./gradlew test"] }, skills: [{ name: "tdd", status: "followed" }] };
const tagged = (body: string): string => `thinking…\n<result>${body}</result>`;

/** Claude stream-json lines. */
const init = (sessionId: string) => JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });
const assistant = (text: string, tool?: { name: string; input: Record<string, unknown> }) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }, ...(tool !== undefined ? [{ type: "tool_use", ...tool }] : [])] } });
const resultLine = (result: string, usage?: Record<string, number>) => JSON.stringify({ type: "result", result, ...(usage !== undefined ? { usage } : {}) });

/** An agent process that streams `lines`, then exits with `exitCode`. */
const streaming =
  (lines: string[], exitCode = 0, stderr = ""): Scripted =>
  (options) => {
    for (const line of lines) options.onLine?.(line);
    return { stdout: lines.join("\n"), stderr, exitCode };
  };

describe("createRunAgent", () => {
  let root: string;
  let first: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sous-agent-"));
    first = logPath(root, "12", { spanId: "r1-1", scope: "12", step: "build", iteration: 1 });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const request = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
    agent: { kind: "claude", model: "claude-x" },
    prompt: "Implement #12",
    logPath: first,
    outputSchema: workSchema,
    ...overrides,
  });

  it("runs the provider's command with the prompt on stdin and the idle timeout, returns the envelope and session id, writes the log", async () => {
    const { exec, calls } = scripted(streaming([init("s1"), assistant("working", { name: "Bash", input: { command: "./gradlew test" } }), assistant(tagged(JSON.stringify(work))), resultLine(tagged(JSON.stringify(work)))]));
    const runAgent = createRunAgent({ exec, idleTimeoutSeconds: 60 });

    expect(await runAgent(request())).toEqual({ envelope: work, sessionId: "s1", logPath: first, toolCalls: [{ name: "Bash", input: { command: "./gradlew test" } }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toEqual(["claude", "--print", "--verbose", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--model", "claude-x", "-p", "-"]);
    expect(calls[0]?.options).toMatchObject({ stdin: "Implement #12", idleTimeoutMs: 60_000, onLine: expect.any(Function) });
    expect((await stat(logDir(root, "12"))).isDirectory()).toBe(true);
    const log = await readFile(first, "utf8");
    expect(log).toMatch(/^\n--- Run started: \d{4}-/);
    expect(log).toContain("working\nBash(./gradlew test)\n");
    expect(log).not.toContain('"type":"assistant"');
  });

  it("resumes the request's session through the provider's command", async () => {
    const { exec, calls } = scripted(streaming([init("s1"), assistant(tagged(JSON.stringify(work)))]));
    await createRunAgent({ exec, idleTimeoutSeconds: 60 })(request({ resumeSession: "s0" }));
    expect(calls[0]?.command).toContain("--resume");
    expect(calls[0]?.command).toContain("s0");
  });

  it("passes the usage through when the provider reports it, for codex too", async () => {
    const usage = { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 50, cache_read_input_tokens: 9000 };
    const withUsage = scripted(streaming([init("s1"), assistant(tagged(JSON.stringify(work))), resultLine("done", usage)]));
    expect((await createRunAgent({ exec: withUsage.exec, idleTimeoutSeconds: 60 })(request())).usage).toEqual({ inputTokens: 1200, outputTokens: 340, cacheCreationInputTokens: 50, cacheReadInputTokens: 9000 });

    const without = scripted(streaming([init("s1"), assistant(tagged(JSON.stringify(work)))]));
    expect(await createRunAgent({ exec: without.exec, idleTimeoutSeconds: 60 })(request())).not.toHaveProperty("usage");

    const codexLines = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: tagged(JSON.stringify(work)) } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } }),
    ];
    const viaCodex = scripted(streaming(codexLines));
    expect(await createRunAgent({ exec: viaCodex.exec, idleTimeoutSeconds: 60 })(request({ agent: { kind: "codex", model: "gpt-x" } }))).toMatchObject({
      sessionId: "t1",
      usage: { inputTokens: 600, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 400 },
    });
    expect(viaCodex.calls[0]?.command).toEqual(["codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-x", "-"]);
  });

  it("resumes once with the validation message when the output does not parse, then succeeds, logging the retry beside the call", async () => {
    const { exec, calls } = scripted(streaming([init("s1"), assistant("no tag")]), streaming([init("s1"), assistant(tagged(JSON.stringify(work)))]));
    const runAgent = createRunAgent({ exec, idleTimeoutSeconds: 60 });

    expect(await runAgent(request())).toEqual({ envelope: work, sessionId: "s1", logPath: withAttempt(first, 2), toolCalls: [] });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.command).toContain("--resume");
    expect(calls[1]?.command).toContain("s1");
    expect(calls[1]?.options.stdin).toContain("Your output did not validate: no <result> tag");
    expect((await stat(withAttempt(first, 2))).isFile()).toBe(true);
  });

  it("collects the tool calls of the run and of its invalid-output retry", async () => {
    const { exec } = scripted(
      streaming([init("s1"), assistant("hm", { name: "Read", input: { file_path: "/r/skills/tdd/SKILL.md" } }), assistant("no tag")]),
      streaming([init("s1"), assistant("ok", { name: "Bash", input: { command: "cat skills/implement/SKILL.md" } }), assistant(tagged(JSON.stringify(work)))]),
    );
    expect((await createRunAgent({ exec, idleTimeoutSeconds: 60 })(request())).toolCalls).toEqual([
      { name: "Read", input: { file_path: "/r/skills/tdd/SKILL.md" } },
      { name: "Bash", input: { command: "cat skills/implement/SKILL.md" } },
    ]);
  });

  it("throws AgentOutputError with the raw match and session id when the retry is invalid too", async () => {
    const { exec, calls } = scripted(streaming([init("s1"), assistant(tagged("{bad"))]), streaming([init("s1"), assistant(tagged("{still bad"))]));
    const error = await createRunAgent({ exec, idleTimeoutSeconds: 60 })(request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentOutputError);
    expect(error).toMatchObject({ rawMatched: "{still bad", sessionId: "s1", logPath: withAttempt(first, 2) });
    expect((error as Error).message).toContain("not valid JSON");
    expect(calls).toHaveLength(2);
  });

  it("does not retry when no session id was captured", async () => {
    const { exec, calls } = scripted(streaming([assistant("nothing")]));
    await expect(createRunAgent({ exec, idleTimeoutSeconds: 60 })(request())).rejects.toMatchObject({ rawMatched: undefined, sessionId: undefined, logPath: first });
    expect(calls).toHaveLength(1);
  });

  it("maps a non-zero agent exit to AgentProcessError with the exit code, stderr, log path and log tail", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => assistant(`line ${i + 1}`));
    const { exec } = scripted(streaming([init("s1"), ...lines], 1, "unsupported model gpt-5.4-codex\n"));
    const error = await createRunAgent({ exec, idleTimeoutSeconds: 60 })(request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentProcessError);
    expect(error).toMatchObject({ exitCode: 1, logPath: first, sessionId: "s1" });
    expect((error as Error).message).toBe("claude exited with code 1:\nunsupported model gpt-5.4-codex");
    const tail = (error as AgentProcessError).logTail ?? "";
    expect(tail).toContain("line 30");
    expect(tail).toContain("claude exited with code 1");
    expect(tail).not.toContain("line 5\n");
  });

  it("maps an idle timeout to AgentProcessError naming the seconds", async () => {
    const idle = scripted((options) => {
      options.onLine?.(init("s1"));
      return { stdout: "", stderr: "", exitCode: 143, timedOut: true };
    });
    const error = await createRunAgent({ exec: idle.exec, idleTimeoutSeconds: 1800 })(request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentProcessError);
    expect(error).toMatchObject({ message: "Agent idle for 1800 seconds: no output received", exitCode: 143, logPath: first, sessionId: "s1" });
  });

  it("maps a CLI that cannot start to AgentProcessError without an exit code", async () => {
    const { exec } = scripted(new Error("exec failed: spawn claude ENOENT"));
    const error = await createRunAgent({ exec, idleTimeoutSeconds: 60 })(request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentProcessError);
    expect(error).toMatchObject({ message: "exec failed: spawn claude ENOENT", exitCode: undefined, logPath: first });
    expect((error as AgentProcessError).logTail).toContain("exec failed: spawn claude ENOENT");
  });

  it("keeps the session id when the in-session output retry fails", async () => {
    const { exec } = scripted(streaming([init("s1"), assistant("no tag")]), streaming([], 2, "boom"));
    await expect(createRunAgent({ exec, idleTimeoutSeconds: 60 })(request())).rejects.toMatchObject({ exitCode: 2, sessionId: "s1", logPath: withAttempt(first, 2) });
  });
});

describe("interrupt", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sous-interrupt-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const request = (): AgentRequest => ({ agent: { kind: "claude", model: "claude-x" }, prompt: "Implement #12", logPath: join(dir, "logs", "r1-1-12-build-1.log"), outputSchema: {} });

  it("rejects an aborted call with InterruptedError, not as a failed agent process", async () => {
    const controller = new AbortController();
    const reason = new InterruptedError("the run was interrupted by SIGTERM");
    // Like the host exec: the abort rejects the call with the signal's reason.
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const exec: HostExec = () =>
      new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        started();
      });
    const call = createRunAgent({ exec, idleTimeoutSeconds: 60, signal: controller.signal })(request());
    await running;
    controller.abort(reason);

    await expect(call).rejects.toBe(reason);

    // A failure without an abort stays an agent failure.
    const failing: HostExec = async () => {
      throw new Error("exec failed: spawn claude ENOENT");
    };
    await expect(createRunAgent({ exec: failing, idleTimeoutSeconds: 60, signal: new AbortController().signal })(request())).rejects.toBeInstanceOf(AgentProcessError);
  });

  it("exec reports failures as results until the signal aborts, then rejects with InterruptedError", async () => {
    const controller = new AbortController();
    const inner: HostExec = async (command, options) => {
      if (command === "boom") throw new Error("exec failed: spawn sh ENOENT");
      return { stdout: `${String(command)} ${options?.cwd ?? ""} ${options?.env?.["X"] ?? ""}`, stderr: "", exitCode: 0 };
    };
    const exec = createSandboxExec(inner, controller.signal);

    expect(await exec("echo")).toEqual({ code: 0, stdout: "echo  ", stderr: "" });
    expect(await exec("echo", { cwd: "/w", env: { X: "1" } })).toEqual({ code: 0, stdout: "echo /w 1", stderr: "" });
    expect(await exec("boom")).toEqual({ code: 1, stdout: "", stderr: "exec failed: spawn sh ENOENT" });

    controller.abort();
    await expect(exec("echo")).rejects.toBeInstanceOf(InterruptedError);
    await expect(exec("boom")).rejects.toBeInstanceOf(InterruptedError);
  });
});

describe("openSandbox (real repository)", () => {
  let repo: TempRepo;
  /** git prints real paths, so the repository root is resolved past the tmpdir symlink. */
  let repoRoot: string;
  beforeEach(async () => {
    repo = await tempRepo();
    repoRoot = await realpath(repo.dir);
  });
  afterEach(() => repo.cleanup());

  it("creates the branch and worktree, reuses them on a second open, execs in the worktree and closes a clean one", async () => {
    const branch = "feature/9-x";
    const openSandbox = createOpenSandbox(createGit());
    const first = await openSandbox({ repoRoot, branch, settings: DEFAULT_SETTINGS });
    expect(first.branch).toBe(branch);
    expect(first.worktreePath).toBe(worktreePathFor(repoRoot, branch));
    expect((await first.exec("git rev-parse --abbrev-ref HEAD")).stdout.trim()).toBe(branch);
    expect((await first.exec("pwd", { cwd: join(first.worktreePath) })).code).toBe(0);
    expect((await first.exec("echo $SOUS_X", { env: { SOUS_X: "y" } })).stdout.trim()).toBe("y");
    expect((await first.exec("exit 3")).code).toBe(3);

    const second = await openSandbox({ repoRoot, branch, settings: DEFAULT_SETTINGS });
    expect(second.worktreePath).toBe(first.worktreePath);

    // A worktree with changes is kept, even untracked ones.
    await writeFile(join(first.worktreePath, "scratch.txt"), "x\n");
    await second.close();
    expect(await repo.git(["worktree", "list", "--porcelain"])).toContain(first.worktreePath);
    await rm(join(first.worktreePath, "scratch.txt"));
    await second.close();
    expect(await repo.git(["worktree", "list", "--porcelain"])).not.toContain(first.worktreePath);
  });

  it("refuses a branch checked out in the primary checkout", async () => {
    await repo.git(["checkout", "-q", "-b", "feature/10-y"]);
    await expect(createOpenSandbox(createGit())({ repoRoot, branch: "feature/10-y", settings: DEFAULT_SETTINGS })).rejects.toThrow(/sous runs it in a worktree of its own/);
  });
});
