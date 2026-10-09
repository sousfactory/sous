/**
 * Host commands that an abort can stop. sandcastle's `noSandbox()` cannot:
 * an aborted `run()` rejects, but the agent process keeps running (sandcastle
 * only stops awaiting it). `killableNoSandbox` swaps in an `exec` that runs
 * each command in its own process group and sends SIGTERM to every group
 * still running on abort. The group holds the shell, the agent and what it
 * started (a `./gradlew test` and its JVMs); only a process that starts its
 * own session or group escapes.
 *
 * Every command goes through it: the agent, sandcastle's own git calls in
 * the worktree, and `Sandbox.exec` (evals).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { createInterface } from "node:readline";
import type { SandboxProvider } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

/** sandcastle's `NoSandboxHandle.exec` options and result. */
export type HostExecOptions = { onLine?: (line: string) => void; cwd?: string; sudo?: boolean; stdin?: string };
export type HostExecResult = { stdout: string; stderr: string; exitCode: number };
export type HostExec = (command: string, options?: HostExecOptions) => Promise<HostExecResult>;

/** As sandcastle's no-sandbox: the tail of streamed output kept for the result. */
export const MAX_TAIL_CHARS = 64 * 1024;

const boundedTail = (max: number, separator: string) => {
  const items: string[] = [];
  let total = 0;
  return {
    push(item: string) {
      const bounded = item.length > max ? item.slice(item.length - max) : item;
      total += bounded.length + (items.length > 0 ? separator.length : 0);
      items.push(bounded);
      while (total > max && items.length > 1) total -= (items.shift() ?? "").length + separator.length;
    },
    toString: () => items.join(separator),
  };
};

/** A process ended by a signal has no exit code; the shell's convention, 128 + the signal number. */
const exitCodeOf = (code: number | null, signal: NodeJS.Signals | null): number =>
  code ?? (signal !== null ? 128 + (constants.signals[signal] ?? 0) : 0);

/** Falls back to the process alone when it has no group of its own. */
const terminate = (proc: ChildProcess): void => {
  if (proc.pid === undefined) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
};

export type HostExecDeps = {
  /** The worktree; the default `cwd`. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Aborting it terminates every command still running and rejects them, and any later one, with its reason. */
  signal?: AbortSignal;
  maxTailChars?: number;
};

export const createHostExec = ({ cwd, env, signal, maxTailChars = MAX_TAIL_CHARS }: HostExecDeps): HostExec => {
  const running = new Set<ChildProcess>();
  signal?.addEventListener("abort", () => running.forEach(terminate), { once: true });

  return (command, options = {}) =>
    new Promise<HostExecResult>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const proc = spawn("sh", ["-c", command], {
        cwd: options.cwd ?? cwd,
        env,
        stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        detached: true,
      });
      running.add(proc);
      if (options.stdin !== undefined) proc.stdin?.end(options.stdin);

      const stdout = boundedTail(options.onLine !== undefined ? maxTailChars : Infinity, options.onLine !== undefined ? "\n" : "");
      const stderr = boundedTail(options.onLine !== undefined ? maxTailChars : Infinity, "");
      const { onLine } = options;
      if (onLine !== undefined && proc.stdout !== null) {
        createInterface({ input: proc.stdout }).on("line", (line) => {
          stdout.push(line);
          onLine(line);
        });
      } else proc.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
      proc.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

      proc.on("error", (error) => {
        running.delete(proc);
        reject(new Error(`exec failed: ${error.message}`));
      });
      proc.on("close", (code, exitSignal) => {
        running.delete(proc);
        if (signal?.aborted) reject(signal.reason);
        else resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: exitCodeOf(code, exitSignal) });
      });
    });
};

/** `noSandbox()` underneath its public type: `create` returns the handle sandcastle runs every command through. */
type NoSandboxInternals = {
  create(options: { worktreePath: string; env?: Record<string, string> }): Promise<{ exec: HostExec }>;
};

export const killableNoSandbox = (signal?: AbortSignal): SandboxProvider => {
  const base = noSandbox() as unknown as NoSandboxInternals;
  const provider: NoSandboxInternals = {
    ...base,
    create: async (options) => {
      const handle = await base.create(options);
      return { ...handle, exec: createHostExec({ cwd: options.worktreePath, env: { ...process.env, ...options.env }, ...(signal !== undefined ? { signal } : {}) }) };
    },
  };
  return provider as unknown as SandboxProvider;
};
