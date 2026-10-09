import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRunOptions, SandboxRunResult } from "@ai-hero/sandcastle";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostExec, killableNoSandbox, type HostExec } from "../../src/adapters/hostexec.js";
import {
  claudeToolCalls,
  createRunAgent,
  createSandboxExec,
  exitCodeOf,
  openSandbox,
  toExecResult,
  toolCallCollector,
  withEnv,
  worktreePathFor,
} from "../../src/adapters/sandcastle.js";
import { AgentProcessError, InterruptedError } from "../../src/exec/errors.js";
import type { AgentRequest } from "../../src/ports/sandbox.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { tempRepo, type TempRepo } from "../helpers/repo.js";

describe("sandcastle adapter helpers", () => {
  it("derives the worktree path the way sandcastle does", () => {
    expect(worktreePathFor("/repo", "feature/12-some-slug")).toBe("/repo/.sandcastle/worktrees/feature-12-some-slug");
  });

  it("maps exitCode to code", () => {
    expect(toExecResult({ stdout: "a", stderr: "b", exitCode: 3 })).toEqual({ code: 3, stdout: "a", stderr: "b" });
  });

  it("reads the exit code out of sandcastle's failure message", () => {
    expect(exitCodeOf("Codex exited with code 1:\nboom")).toBe(1);
    expect(exitCodeOf("Agent idle for 1800 seconds")).toBeUndefined();
  });

  it("prefixes exported, quoted environment variables to a command", () => {
    expect(withEnv("./gradlew test", undefined)).toBe("./gradlew test");
    expect(withEnv("./gradlew test", {})).toBe("./gradlew test");
    expect(withEnv("./gradlew test", { CI: "1", MSG: "it's" })).toBe("export CI='1'; export MSG='it'\\''s'; ./gradlew test");
  });
});

describe("tool calls", () => {
  it("reads the tool_use blocks of a Claude stream-json line and nothing else", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "tdd" } }] } });
    expect(claudeToolCalls(line)).toEqual([{ name: "Skill", input: { skill: "tdd" } }]);
    expect(claudeToolCalls('{"type":"user","message":{"content":[]}}')).toEqual([]);
    expect(claudeToolCalls("{not json")).toEqual([]);
    expect(claudeToolCalls("plain text")).toEqual([]);
  });

  it("falls back to sandcastle's toolCall events when no raw line carried a tool call (codex)", () => {
    const tools = toolCallCollector();
    tools.onEvent({ type: "toolCall", name: "Bash", formattedArgs: "cat skills/tdd/SKILL.md", iteration: 1, timestamp: new Date() });
    tools.onEvent({ type: "toolCall", name: "Read", formattedArgs: "skills/tdd/SKILL.md", iteration: 1, timestamp: new Date() });
    tools.onEvent({ type: "raw", line: '{"type":"item.completed"}', iteration: 1, timestamp: new Date() });
    expect(tools.calls()).toEqual([
      { name: "Bash", input: { command: "cat skills/tdd/SKILL.md" } },
      { name: "Read", input: { file_path: "skills/tdd/SKILL.md" } },
    ]);
  });
});

describe("interrupt", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sous-interrupt-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const request = (): AgentRequest => ({ agent: { kind: "claude", model: "claude-x" }, prompt: "Implement #12", logPath: join(dir, "logs", "r1-1-12-build-1.log"), outputSchema: {} });
  const valid = (sessionId: string, stdout: string): SandboxRunResult => ({ iterations: [{ sessionId }], stdout, commits: [] });
  const envelope = '<result>{"summary":"s","commits":[],"output":{},"skills":[]}</result>';

  it("forwards the run's signal to every sandcastle run, the invalid-output retry included", async () => {
    const controller = new AbortController();
    const calls: SandboxRunOptions[] = [];
    const queue = [valid("s1", "no tag"), valid("s1", envelope)];
    const run = async (options: SandboxRunOptions) => {
      calls.push(options);
      const next = queue.shift();
      if (next === undefined) throw new Error("no more");
      return next;
    };

    await createRunAgent({ run, idleTimeoutSeconds: 60, signal: controller.signal })(request());

    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.signal).toBe(controller.signal);
  });

  it("rejects an aborted call with InterruptedError, not as a failed agent process", async () => {
    const controller = new AbortController();
    const reason = new InterruptedError("the run was interrupted by SIGTERM");
    // Like sandcastle: the abort rejects the run with the signal's reason.
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const run = (options: SandboxRunOptions) =>
      new Promise<SandboxRunResult>((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        started();
      });
    const call = createRunAgent({ run, idleTimeoutSeconds: 60, signal: controller.signal })(request());
    await running;
    controller.abort(reason);

    await expect(call).rejects.toBe(reason);

    // A failure without an abort stays an agent failure.
    const failing = async (): Promise<SandboxRunResult> => {
      throw new Error("claude exited with code 1: boom");
    };
    await expect(createRunAgent({ run: failing, idleTimeoutSeconds: 60, signal: new AbortController().signal })(request())).rejects.toBeInstanceOf(AgentProcessError);
  });

  it("exec reports failures as results until the signal aborts, then rejects with InterruptedError", async () => {
    const controller = new AbortController();
    const inner = async (command: string) => {
      if (command === "boom") throw new Error("exec failed: spawn sh ENOENT");
      return { stdout: command, stderr: "", exitCode: 0 };
    };
    const exec = createSandboxExec(inner, controller.signal);

    expect(await exec("echo")).toEqual({ code: 0, stdout: "echo", stderr: "" });
    expect(await exec("boom")).toEqual({ code: 1, stdout: "", stderr: "exec failed: spawn sh ENOENT" });

    controller.abort();
    await expect(exec("echo")).rejects.toBeInstanceOf(InterruptedError);
    await expect(exec("boom")).rejects.toBeInstanceOf(InterruptedError);
  });

  /** Whether a process with this pid still runs. */
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (condition: () => boolean, ms = 3000): Promise<void> => {
    const end = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it("host exec runs sh -c in the worktree like sandcastle's no-sandbox: output, exit code, stdin, streamed lines", async () => {
    const exec = createHostExec({ cwd: dir, env: { ...process.env, SOUS_X: "y" } });
    expect(await exec("pwd; echo $SOUS_X; echo err >&2; exit 3")).toEqual({ stdout: `${await realpath(dir)}\ny\n`, stderr: "err\n", exitCode: 3 });
    expect((await exec("cat", { stdin: "fed" })).stdout).toBe("fed");
    const lines: string[] = [];
    expect(await exec("echo a; echo b", { onLine: (l) => lines.push(l) })).toEqual({ stdout: "a\nb", stderr: "", exitCode: 0 });
    expect(lines).toEqual(["a", "b"]);
    expect((await exec("kill -TERM $$")).exitCode).toBe(143);
  });

  it("host exec terminates the whole process group of a command in flight on abort, the agent's own children included", async () => {
    const controller = new AbortController();
    const exec = createHostExec({ cwd: dir, env: process.env, signal: controller.signal });
    let grandchild: number | undefined;
    // The shell stands in for the agent, its background sleep for a `./gradlew test` it started.
    const call = exec("sleep 30 & echo $!; wait", {
      onLine: (line) => {
        grandchild = Number(line);
      },
    });
    await until(() => grandchild !== undefined);
    expect(alive(grandchild ?? 0)).toBe(true);

    const reason = new InterruptedError("the run was interrupted by SIGINT");
    controller.abort(reason);

    await expect(call).rejects.toBe(reason);
    await until(() => !alive(grandchild ?? 0));
    await expect(exec("echo never")).rejects.toBe(reason);
  });

  it("killableNoSandbox is sandcastle's no-sandbox with the abortable exec", async () => {
    const controller = new AbortController();
    const provider = killableNoSandbox(controller.signal) as unknown as { tag: string; create(o: { worktreePath: string; env?: Record<string, string> }): Promise<{ worktreePath: string; exec: HostExec }> };
    expect(provider.tag).toBe("none");
    const handle = await provider.create({ worktreePath: dir, env: { SOUS_X: "z" } });
    expect(handle.worktreePath).toBe(dir);
    expect((await handle.exec("echo $SOUS_X")).stdout).toBe("z\n");

    const call = handle.exec("sleep 30");
    controller.abort();
    await expect(call).rejects.toBeDefined();
  });
});

// Opt in with SOUS_SANDCASTLE_TEST=1: creates a real worktree through sandcastle.
describe.skipIf(process.env["SOUS_SANDCASTLE_TEST"] !== "1")("openSandbox (real sandcastle)", () => {
  let repo: TempRepo;
  /** Sandcastle matches worktree paths textually against git's real paths, so no tmpdir symlink. */
  let repoRoot: string;
  beforeEach(async () => {
    repo = await tempRepo();
    repoRoot = await realpath(repo.dir);
  });
  afterEach(() => repo.cleanup());

  it("creates the branch and worktree, reuses them on a second open, execs in the worktree and closes", async () => {
    const branch = "feature/9-x";
    const first = await openSandbox({ repoRoot, branch, settings: DEFAULT_SETTINGS });
    expect(first.branch).toBe(branch);
    expect(first.worktreePath).toBe(worktreePathFor(repoRoot, branch));
    expect((await first.exec("git rev-parse --abbrev-ref HEAD")).stdout.trim()).toBe(branch);
    expect((await first.exec("pwd", { cwd: join(first.worktreePath) })).code).toBe(0);
    expect((await first.exec("echo $SOUS_X", { env: { SOUS_X: "y" } })).stdout.trim()).toBe("y");
    expect((await first.exec("exit 3")).code).toBe(3);

    const second = await openSandbox({ repoRoot, branch, settings: DEFAULT_SETTINGS });
    expect(second.worktreePath).toBe(first.worktreePath);

    await second.close();
    expect(await repo.git(["worktree", "list", "--porcelain"])).not.toContain(first.worktreePath);
  });
});
