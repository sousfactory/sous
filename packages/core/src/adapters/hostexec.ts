/**
 * Host commands that an abort can stop. Each command runs in its own process
 * group and gets SIGTERM for the whole group on abort, so the group holds
 * the shell, the agent and what it started (a `./gradlew test` and its
 * JVMs); only a process that starts its own session or group escapes.
 *
 * Every command goes through it: the agent, and `Sandbox.exec` (evals).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { createInterface } from "node:readline";

export type HostExecOptions = {
  /** Called with every stdout line as it arrives; the stdout kept for the result is then a bounded tail. */
  onLine?: (line: string) => void;
  cwd?: string;
  stdin?: string;
  /** Over the base environment. */
  env?: Record<string, string>;
  /** The command is terminated once it has printed nothing for this long; the result then says `timedOut`. */
  idleTimeoutMs?: number;
};
export type HostExecResult = { stdout: string; stderr: string; exitCode: number; timedOut?: true };
/** A string runs through `sh -c`; an argv runs the executable directly, no shell, no quoting. */
export type HostExec = (command: string | readonly string[], options?: HostExecOptions) => Promise<HostExecResult>;

/** The tail of streamed output kept for the result. */
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
      const [file, args] = typeof command === "string" ? ["sh", ["-c", command]] : [command[0] ?? "", command.slice(1)];
      const proc = spawn(file, args, {
        cwd: options.cwd ?? cwd,
        env: { ...env, ...options.env },
        stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        detached: true,
      });
      running.add(proc);
      if (options.stdin !== undefined) proc.stdin?.end(options.stdin);

      let timedOut = false;
      let idle: NodeJS.Timeout | undefined;
      const touch = () => {
        if (options.idleTimeoutMs === undefined) return;
        clearTimeout(idle);
        idle = setTimeout(() => {
          timedOut = true;
          terminate(proc);
        }, options.idleTimeoutMs);
      };
      touch();

      const stdout = boundedTail(options.onLine !== undefined ? maxTailChars : Infinity, options.onLine !== undefined ? "\n" : "");
      const stderr = boundedTail(options.onLine !== undefined ? maxTailChars : Infinity, "");
      const { onLine } = options;
      if (onLine !== undefined && proc.stdout !== null) {
        createInterface({ input: proc.stdout }).on("line", (line) => {
          touch();
          stdout.push(line);
          onLine(line);
        });
      } else {
        proc.stdout?.on("data", (chunk: Buffer) => {
          touch();
          stdout.push(chunk.toString());
        });
      }
      proc.stderr?.on("data", (chunk: Buffer) => {
        touch();
        stderr.push(chunk.toString());
      });

      proc.on("error", (error) => {
        clearTimeout(idle);
        running.delete(proc);
        reject(new Error(`exec failed: ${error.message}`));
      });
      proc.on("close", (code, exitSignal) => {
        clearTimeout(idle);
        running.delete(proc);
        if (signal?.aborted) reject(signal.reason);
        else resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: exitCodeOf(code, exitSignal), ...(timedOut ? { timedOut: true } : {}) });
      });
    });
};
