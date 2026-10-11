import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, classifyLock, describeLock, isProcessAlive, liveLocks, lockPath, parseLock } from "../../src/commands/lock.js";

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
