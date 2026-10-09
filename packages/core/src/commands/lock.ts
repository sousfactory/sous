/**
 * One `sous run` per project at a time: `.sous/.lock` holds the running
 * pid and issue. A stale lock is reported, never taken over; a human
 * removes it.
 */
import { rmSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LOCK_FILE = ".lock";

export const lockPath = (root: string): string => join(root, LOCK_FILE);

export type LockInfo = { pid: number; issue: string };

export type LockStatus = { kind: "free" } | { kind: "held"; lock: LockInfo } | { kind: "stale"; lock: LockInfo } | { kind: "unreadable"; raw: string };

/**
 * `releaseSync` is for a `process.on("exit")` listener, where nothing
 * asynchronous runs any more: the lock goes with the process however it ends.
 */
export type AcquireResult = { ok: true; release: () => Promise<void>; releaseSync: () => void } | { ok: false; status: Exclude<LockStatus, { kind: "free" }> };

export const parseLock = (raw: string): LockInfo | undefined => {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const { pid, issue } = value as Record<string, unknown>;
    return Number.isInteger(pid) && typeof issue === "string" && issue !== "" ? { pid: pid as number, issue } : undefined;
  } catch {
    return undefined;
  }
};

export const classifyLock = (raw: string | undefined, isAlive: (pid: number) => boolean): LockStatus => {
  if (raw === undefined) return { kind: "free" };
  const lock = parseLock(raw);
  if (lock === undefined) return { kind: "unreadable", raw };
  return isAlive(lock.pid) ? { kind: "held", lock } : { kind: "stale", lock };
};

export const describeLock = (path: string, status: Exclude<LockStatus, { kind: "free" }>): string => {
  switch (status.kind) {
    case "held":
      return `another sous run holds ${path} (pid ${status.lock.pid}, issue ${status.lock.issue})`;
    case "stale":
      return `stale lock ${path}: pid ${status.lock.pid} (issue ${status.lock.issue}) is not running; remove the file and retry`;
    case "unreadable":
      return `unreadable lock ${path}: ${JSON.stringify(status.raw)}; remove the file and retry`;
  }
};

/** Signal 0 probes without killing; EPERM means the process exists but is not ours. */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const acquireLock = async (path: string, lock: LockInfo, isAlive: (pid: number) => boolean): Promise<AcquireResult> => {
  try {
    await writeFile(path, `${JSON.stringify(lock)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const status = classifyLock(await readFile(path, "utf8"), isAlive);
    if (status.kind === "free") throw new Error(`lock ${path} vanished while being read`);
    return { ok: false, status };
  }
  return { ok: true, release: () => rm(path, { force: true }), releaseSync: () => rmSync(path, { force: true }) };
};
