/**
 * Agent log files, one per agent call, under `<logsDir>/<issue>/`. The span
 * id (`<runId>-<k>`: the run segment's random id and the visit's ordinal in
 * it) keeps names unique across work items, route loops and resumed runs;
 * scope, step and iteration only make the name readable. An in-session retry
 * gets its own file (`….2.log`).
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { safeId } from "../session/paths.js";

/** `logsDir` is absolute: `projectDirs(root, settings).logs`. */
export const logDir = (logsDir: string, issue: string): string => join(logsDir, safeId(issue));

export type LogCall = { spanId: string; scope: string; step: string; iteration: number };

export const logName = ({ spanId, scope, step, iteration }: LogCall, attempt = 1): string =>
  `${spanId}-${scope}-${step}-${iteration}${attempt > 1 ? `.${attempt}` : ""}.log`;

export const logPath = (logsDir: string, issue: string, call: LogCall, attempt = 1): string => join(logDir(logsDir, issue), logName(call, attempt));

/** The sibling file of `path` for retry `attempt` of the same call: `…-implement-1.log` → `…-implement-1.2.log`. */
export const withAttempt = (path: string, attempt: number): string =>
  attempt > 1 ? path.replace(/(\.\d+)?\.log$/, `.${attempt}.log`) : path.replace(/\.\d+\.log$/, ".log");

export const ensureLogDir = async (logsDir: string, issue: string): Promise<string> => {
  const dir = logDir(logsDir, issue);
  await mkdir(dir, { recursive: true });
  return dir;
};
