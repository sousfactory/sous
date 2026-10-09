/**
 * Subprocess wrapper shared by the git and tracker adapters. It never throws
 * on a non-zero exit, so callers decide (`must()`); tests inject their own
 * `Exec` to script responses.
 */
import { spawn } from "node:child_process";
import type { ExecOptions, ExecResult } from "../index.js";

export type { ExecOptions, ExecResult };

export type Exec = (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

export const exec: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    // A spawn failure (command not found) is reported like a failed run.
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

export class ExecError extends Error {
  constructor(
    readonly what: string,
    readonly result: ExecResult,
  ) {
    const detail = result.stderr.trim() || result.stdout.trim();
    super(`${what} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
    this.name = "ExecError";
  }
}

/** Trimmed stdout of a successful run; throws `ExecError` with stderr otherwise. */
export const must = (result: ExecResult, what: string): string => {
  if (result.code !== 0) throw new ExecError(what, result);
  return result.stdout.trim();
};
