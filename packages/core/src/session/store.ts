/**
 * The session file, `runs/<issue>/session.json`: the executor's control
 * state. Only the current schema version loads; another is an error, not a
 * migration.
 *
 * It is the run's only way to continue, so a checkpoint never truncates it:
 * the new state is written and flushed beside it, the previous file becomes
 * `session.json.bak`, and a rename puts the new one in place. A crash or a
 * full disk at any point leaves a complete file to load.
 */
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { checker } from "../config/schema.js";
import { SCHEMA_VERSION, type Session } from "../exec/scope.js";

const stepRecord = {
  type: "object",
  required: ["visits", "ok", "log", "commits"],
  additionalProperties: false,
  properties: {
    visits: { type: "integer", minimum: 1 },
    ok: { type: "boolean" },
    log: { type: "string" },
    output: {},
    commits: { type: "array", items: { type: "string" } },
    session: { type: "string" },
    prepared: {
      type: "object",
      required: ["agent", "output"],
      additionalProperties: false,
      properties: { agent: { enum: ["run", "skip"] }, reason: { type: "string" }, output: {} },
    },
  },
};

export const SESSION_SCHEMA = {
  type: "object",
  required: ["schemaVersion", "flow", "issue", "title", "branch", "specDir", "current", "previous", "work", "scopes", "workProgress", "history", "iterations", "blocked", "closed"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    flow: { type: "string", minLength: 1 },
    issue: { type: "string", minLength: 1 },
    title: { type: "string" },
    branch: { type: "string", minLength: 1 },
    specDir: { type: "string" },
    current: { type: "string", minLength: 1 },
    previous: { type: ["string", "null"] },
    work: { type: "string", minLength: 1 },
    scopes: { type: "object", additionalProperties: { type: "object", additionalProperties: stepRecord } },
    workProgress: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["state", "commits"],
        additionalProperties: false,
        properties: { state: { enum: ["open", "done"] }, commits: { type: "array", items: { type: "string" } } },
      },
    },
    history: {
      type: "array",
      items: {
        type: "object",
        required: ["step", "at", "ok", "next"],
        additionalProperties: false,
        properties: { step: { type: "string" }, at: { type: "string" }, ok: { type: "boolean" }, next: { type: "string" } },
      },
    },
    iterations: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
    blocked: { type: "boolean" },
    closed: { type: "boolean" },
  },
};

const check = checker<Session>(SESSION_SCHEMA);

/** Throws a `SousError` naming `file` when `value` is not a current-schema session. */
export const parseSession = (value: unknown, file: string): Session => check(value, file);

/** Where and how the executor writes the session; injected so tests need no file. */
export type Persist = (session: Session) => Promise<void>;

/** The checkpoint before the current one; what a run loads when a crash fell between the two renames of a save. */
export const backupFile = (path: string): string => `${path}.bak`;

const tempFile = (path: string): string => `${path}.tmp`;

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const readIfPresent = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

/**
 * The session, or the previous checkpoint when only that is left, or
 * `undefined` when the run has none. A file that is present but not a
 * session is an error: the run is not silently started over.
 */
export const loadSession = async (path: string): Promise<Session | undefined> => {
  const raw = await readIfPresent(path);
  if (raw !== undefined) return parseSession(JSON.parse(raw), path);
  const backup = await readIfPresent(backupFile(path));
  return backup === undefined ? undefined : parseSession(JSON.parse(backup), backupFile(path));
};

/** Writes and flushes `content` to `path` before returning, so a rename of it moves complete data. */
const writeFlushed = async (path: string, content: string): Promise<void> => {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const moveIfPresent = async (from: string, to: string): Promise<void> => {
  try {
    await rename(from, to);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
};

export const saveSession = async (path: string, session: Session): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFlushed(tempFile(path), `${JSON.stringify(session, null, 2)}\n`);
  await moveIfPresent(path, backupFile(path));
  await rename(tempFile(path), path);
};

/** The session is never committed to git. */
export const filePersist =
  (path: string): Persist =>
  (session) =>
    saveSession(path, session);
