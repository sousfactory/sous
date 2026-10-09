import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, classifyLock, describeLock, isProcessAlive, lockPath, parseLock } from "../../src/commands/lock.js";

describe("lock", () => {
  it("lives at .sous/.lock", () => {
    expect(lockPath("/repo/.sous")).toBe("/repo/.sous/.lock");
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
    const path = join(dir, ".lock");
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
});
