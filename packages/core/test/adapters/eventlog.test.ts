import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileEventLog, parseEvents } from "../../src/adapters/eventlog.js";
import type { Event } from "../../src/session/events.js";

const at = "2026-10-02T09:00:00.000Z";
const start: Event = { type: "run.start", at, runId: "r1", pid: 1, host: "h", sha: "x", flow: "task" };
const open: Event = { type: "span.open", at, runId: "r1", spanId: "r1-1", step: "init", scope: "1" };
const end: Event = { type: "run.end", at, runId: "r1", outcome: "done" };

describe("file event log", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sous-events-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("appends one JSON line per event, creating the folder, and reads them back in order", async () => {
    const path = join(dir, "runs", "7", "events.jsonl");
    const log = createFileEventLog(path);

    await log.append(start);
    await log.append(open);
    await log.append(end);

    const text = await readFile(path, "utf8");
    expect(text.split("\n")).toHaveLength(4);
    expect(text.endsWith("\n")).toBe(true);
    expect(await log.readAll()).toEqual([start, open, end]);
  });

  it("reads an empty list when the file does not exist yet", async () => {
    expect(await createFileEventLog(join(dir, "missing.jsonl")).readAll()).toEqual([]);
  });

  it("ignores a truncated last line: a process killed mid-write loses that event only", async () => {
    const path = join(dir, "events.jsonl");
    const log = createFileEventLog(path);
    await log.append(start);
    await log.append(open);
    await appendFile(path, '{"type":"span.close","at":"2026-10-02T09:0', "utf8");

    expect(await log.readAll()).toEqual([start, open]);
  });

  it("rejects a corrupt line that is not the last one and a line that is not an event", async () => {
    const path = join(dir, "events.jsonl");
    await writeFile(path, `${JSON.stringify(start)}\nnot json\n${JSON.stringify(end)}\n`, "utf8");
    await expect(createFileEventLog(path).readAll()).rejects.toThrow();

    await writeFile(path, `${JSON.stringify({ type: "run.end", at })}\n`, "utf8");
    await expect(createFileEventLog(path).readAll()).rejects.toThrow(/line 1 is not an event/);
  });

  it("parseEvents is pure and skips blank lines", () => {
    expect(parseEvents(`${JSON.stringify(start)}\n\n${JSON.stringify(end)}\n`)).toEqual([start, end]);
    expect(parseEvents("")).toEqual([]);
  });
});
