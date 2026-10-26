import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostExec } from "../../src/adapters/hostexec.js";
import { InterruptedError } from "../../src/exec/errors.js";

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

describe("host exec", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sous-hostexec-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("runs a string through sh -c in the worktree: output, exit code, stdin, streamed lines, env", async () => {
    const exec = createHostExec({ cwd: dir, env: { ...process.env, SOUS_X: "y" } });
    expect(await exec("pwd; echo $SOUS_X; echo err >&2; exit 3")).toEqual({ stdout: `${await realpath(dir)}\ny\n`, stderr: "err\n", exitCode: 3 });
    expect((await exec("cat", { stdin: "fed" })).stdout).toBe("fed");
    expect((await exec("echo $SOUS_X $SOUS_Y", { env: { SOUS_Y: "z" } })).stdout).toBe("y z\n");
    const lines: string[] = [];
    expect(await exec("echo a; echo b", { onLine: (l) => lines.push(l) })).toEqual({ stdout: "a\nb", stderr: "", exitCode: 0 });
    expect(lines).toEqual(["a", "b"]);
    expect((await exec("kill -TERM $$")).exitCode).toBe(143);
  });

  it("runs an argv directly, with no shell in between", async () => {
    const exec = createHostExec({ cwd: dir, env: process.env });
    expect((await exec(["printf", "%s|%s", "a b", "$HOME"])).stdout).toBe("a b|$HOME");
    expect((await exec(["sh", "-c", "exit 4"])).exitCode).toBe(4);
    await expect(exec(["sous-no-such-command"])).rejects.toThrow(/exec failed: spawn sous-no-such-command ENOENT/);
  });

  it("terminates a command that prints nothing for the idle timeout and says so", async () => {
    const exec = createHostExec({ cwd: dir, env: process.env });
    const quiet = await exec("echo start; sleep 30; echo never", { idleTimeoutMs: 100, onLine: () => undefined });
    expect(quiet).toMatchObject({ stdout: "start", exitCode: 143, timedOut: true });
    // Output resets the clock: a command slower than the timeout in total still finishes when it keeps printing.
    const chatty = await exec("for i in 1 2 3 4; do echo $i; sleep 0.05; done", { idleTimeoutMs: 150, onLine: () => undefined });
    expect(chatty).toEqual({ stdout: "1\n2\n3\n4", stderr: "", exitCode: 0 });
  });

  it("terminates the whole process group of a command in flight on abort, the agent's own children included", async () => {
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
});
