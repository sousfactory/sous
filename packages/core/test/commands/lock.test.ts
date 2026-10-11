import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, classifyLock, createRepoLock, describeLock, isProcessAlive, liveLocks, lockPath, parseLock, repoLockPath } from "../../src/commands/lock.js";

describe("repo lock", () => {
  const withDir = async (fn: (dir: string, path: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), "sous-repo-lock-"));
    try {
      await fn(dir, repoLockPath(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("lives at .sous/locks/repo.mutex: not a .lock, so it is no running issue to liveLocks", () => {
    expect(repoLockPath("/repo/.sous")).toBe("/repo/.sous/locks/repo.mutex");
  });

  it("holds the file for the section and releases it after, also when the section throws", () =>
    withDir(async (dir, path) => {
      const lock = createRepoLock(path, { pid: 1, issue: "7" }, () => true);
      expect(await lock(async () => [existsSync(path), await liveLocks(dir, () => true)])).toEqual([true, []]);
      expect(existsSync(path)).toBe(false);
      await expect(lock(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
      expect(existsSync(path)).toBe(false);
    }));

  it("waits for a live holder and goes on once it releases", () =>
    withDir(async (_dir, path) => {
      const holder = await acquireLock(path, { pid: 2, issue: "8" }, () => true);
      let polls = 0;
      const sleep = async () => {
        if (++polls === 3 && holder.ok) await holder.release();
      };
      const lock = createRepoLock(path, { pid: 1, issue: "7" }, () => true, { sleep, pollMs: 1 });
      expect(await lock(async () => "ran")).toBe("ran");
      expect(polls).toBe(3);
    }));

  it("takes over a stale lock at once: the pid behind it is a crashed run", () =>
    withDir(async (_dir, path) => {
      await acquireLock(path, { pid: 2, issue: "8" }, () => true);
      const lock = createRepoLock(path, { pid: 1, issue: "7" }, (pid) => pid === 1, { sleep: () => Promise.reject(new Error("should not wait")) });
      expect(await lock(async () => "ran")).toBe("ran");
      expect(existsSync(path)).toBe(false);
    }));

  it("gives up after the timeout, naming the holder", () =>
    withDir(async (_dir, path) => {
      await acquireLock(path, { pid: 2, issue: "8" }, () => true);
      let t = 0;
      const lock = createRepoLock(path, { pid: 1, issue: "7" }, () => true, {
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
        timeoutMs: 1000,
        pollMs: 250,
      });
      await expect(lock(async () => "ran")).rejects.toThrow(/another sous run holds .*repo\.mutex \(pid 2, issue 8\); gave up waiting for it after 1s/);
      expect(t).toBe(1000);
    }));
});

describe("lock", () => {
  it("lives at .sous/locks/<issue>.lock, the issue path-safe", () => {
    expect(lockPath("/repo/.sous", "7")).toBe("/repo/.sous/locks/7.lock");
    expect(lockPath("/repo/.sous", "proj/a 1")).toBe("/repo/.sous/locks/proj-a-1.lock");
  });

  it("parses and classifies lock contents", () => {
    expect(parseLock('{"pid":42,"issue":"7"}')).toEqual({ pid: 42, issue: "7" });
    expect(parseLock("garbage")).toBeUndefined();
    expect(parseLock('{"pid":"x"}')).toBeUndefined();
    expect(parseLock("null")).toBeUndefined();
    expect(classifyLock(undefined, () => true)).toEqual({ kind: "free" });
    expect(classifyLock('{"pid":42,"issue":"7"}', () => true)).toEqual({ kind: "held", lock: { pid: 42, issue: "7" } });
    expect(classifyLock('{"pid":42,"issue":"7"}', () => false)).toEqual({ kind: "stale", lock: { pid: 42, issue: "7" } });
    expect(classifyLock("?", () => true)).toEqual({ kind: "unreadable", raw: "?" });
  });

  it("describes every refusal", () => {
    expect(describeLock("/l", { kind: "held", lock: { pid: 42, issue: "7" } })).toBe("another sous run holds /l (pid 42, issue 7)");
    expect(describeLock("/l", { kind: "stale", lock: { pid: 42, issue: "7" } })).toBe("stale lock /l: pid 42 (issue 7) is not running; remove the file and retry");
    expect(describeLock("/l", { kind: "unreadable", raw: "?" })).toBe('unreadable lock /l: "?"; remove the file and retry');
  });

  it("sees its own process alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("acquires atomically, refuses while held and releases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sous-lock-"));
    // The locks folder is created on first use.
    const path = lockPath(dir, "7");
    const first = await acquireLock(path, { pid: 1, issue: "7" }, () => true);
    expect(first.ok).toBe(true);
    expect(await acquireLock(path, { pid: 2, issue: "8" }, () => true)).toEqual({ ok: false, status: { kind: "held", lock: { pid: 1, issue: "7" } } });
    expect(await acquireLock(path, { pid: 2, issue: "8" }, () => false)).toEqual({ ok: false, status: { kind: "stale", lock: { pid: 1, issue: "7" } } });
    if (first.ok) await first.release();
    const second = await acquireLock(path, { pid: 2, issue: "8" }, () => true);
    expect(second.ok).toBe(true);
    // The sync release is for a process "exit" listener, where async work never runs; a second call must be harmless.
    if (second.ok) second.releaseSync();
    expect(existsSync(path)).toBe(false);
    if (second.ok) second.releaseSync();
    await rm(dir, { recursive: true, force: true });
  });

  it("holds one lock per issue side by side, and lists the live ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sous-lock-"));
    expect(await liveLocks(dir, () => true)).toEqual([]);
    const seven = await acquireLock(lockPath(dir, "7"), { pid: 1, issue: "7" }, () => true);
    const three = await acquireLock(lockPath(dir, "3"), { pid: 2, issue: "3" }, () => true);
    expect([seven.ok, three.ok]).toEqual([true, true]);
    await writeFile(lockPath(dir, "9"), "garbage");
    expect(await liveLocks(dir, () => true)).toEqual([
      { pid: 2, issue: "3" },
      { pid: 1, issue: "7" },
    ]);
    expect(await liveLocks(dir, (pid) => pid === 1)).toEqual([{ pid: 1, issue: "7" }]);
    await rm(dir, { recursive: true, force: true });
  });
});
