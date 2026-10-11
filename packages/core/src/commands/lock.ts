/**
 * One `sous run` per issue at a time: `.sous/locks/<issue>.lock` holds the
 * running pid and issue. Runs on different issues go in parallel, each in
 * its own worktree. A stale lock is reported, never taken over; a human
 * removes it.
 *
 * The parallel runs share one repository checkout, so `locks/repo.mutex`
 * serializes the steps that work on it (`ctx.repoLock`): the merge's
 * freshness check and its squash happen under it as one transaction.
 */
import { rmSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SousError } from "../exec/errors.js";
import type { Ctx } from "../index.js";
import { safeId } from "../session/paths.js";

export const LOCKS_DIR = "locks";

export const locksDir = (root: string): string => join(root, LOCKS_DIR);

export const lockPath = (root: string, issue: string): string => join(locksDir(root), `${safeId(issue)}.lock`);

/** Not a `.lock` file, so `liveLocks` does not list the holder as a second running issue. */
export const REPO_LOCK = "repo.mutex";

export const repoLockPath = (root: string): string => join(locksDir(root), REPO_LOCK);

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
  await mkdir(dirname(path), { recursive: true });
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

export type RepoLockOptions = {
  /** How long a run waits for the holder before giving up; the sections held are seconds long. */
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export const REPO_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
export const REPO_LOCK_POLL_MS = 250;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `ctx.repoLock` for one run: waits for the lock at `path`, runs `fn`,
 * releases. Unlike the per-issue lock, a stale one is taken over: it guards
 * seconds of work, so the pid behind it is a crashed run, and a human need
 * not clear it before every other merge may go on. An unreadable file may
 * be one another process is writing this instant, so it is waited on, and
 * named in the error when the wait runs out.
 */
export const createRepoLock = (path: string, lock: LockInfo, isAlive: (pid: number) => boolean, options: RepoLockOptions = {}): Ctx["repoLock"] => {
  const timeoutMs = options.timeoutMs ?? REPO_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? REPO_LOCK_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? pause;
  return async (fn) => {
    const deadline = now() + timeoutMs;
    for (;;) {
      const acquired = await acquireLock(path, lock, isAlive);
      if (acquired.ok) {
        try {
          return await fn();
        } finally {
          await acquired.release();
        }
      }
      if (acquired.status.kind === "stale") {
        await rm(path, { force: true });
        continue;
      }
      if (now() >= deadline) throw new SousError(`${describeLock(path, acquired.status)}; gave up waiting for it after ${Math.round(timeoutMs / 1000)}s`);
      await sleep(pollMs);
    }
  };
};

/** Every lock under `locks/` whose pid is alive: the runs going on right now, ordered by issue. */
export const liveLocks = async (root: string, isAlive: (pid: number) => boolean): Promise<LockInfo[]> => {
  let names: string[];
  try {
    names = (await readdir(locksDir(root))).filter((n) => n.endsWith(".lock"));
  } catch {
    return [];
  }
  const raws = await Promise.all(names.map((n) => readFile(join(locksDir(root), n), "utf8").catch(() => undefined)));
  return raws
    .map((raw) => classifyLock(raw, isAlive))
    .flatMap((status) => (status.kind === "held" ? [status.lock] : []))
    .sort((a, b) => a.issue.localeCompare(b.issue));
};
