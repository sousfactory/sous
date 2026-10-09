/**
 * Event log over a JSON Lines file. A process killed mid-write leaves a
 * partial last line; reading drops it, since everything before it is intact
 * and nothing after it was ever written.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventLog } from "../ports/eventlog.js";
import { isEvent, type Event } from "../session/events.js";

const parseLine = (line: string, last: boolean): unknown => {
  try {
    return JSON.parse(line);
  } catch (error) {
    if (last) return undefined;
    throw error;
  }
};

const toEvent = (raw: unknown, index: number): Event => {
  if (!isEvent(raw)) throw new Error(`events.jsonl line ${index + 1} is not an event: ${JSON.stringify(raw)}`);
  return raw;
};

export const parseEvents = (text: string): Event[] => {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  return lines.flatMap((line, i) => {
    const raw = parseLine(line, i === lines.length - 1);
    return raw === undefined ? [] : [toEvent(raw, i)];
  });
};

export const createFileEventLog = (path: string): EventLog => ({
  async append(event) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
  },
  async readAll() {
    try {
      return parseEvents(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  },
});
