/**
 * The session file, `runs/<issue>/session.json`: the executor's control
 * state. Only the current schema version loads; another is an error, not a
 * migration.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  required: ["schemaVersion", "flow", "issue", "title", "branch", "specDir", "current", "previous", "work", "scopes", "workProgress", "history", "iterations", "blocked"],
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
  },
};

const check = checker<Session>(SESSION_SCHEMA);

/** Throws a `SousError` naming `file` when `value` is not a current-schema session. */
export const parseSession = (value: unknown, file: string): Session => check(value, file);

/** Where and how the executor writes the session; injected so tests need no file. */
export type Persist = (session: Session) => Promise<void>;

export const loadSession = async (path: string): Promise<Session | undefined> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseSession(JSON.parse(raw), path);
};

export const saveSession = async (path: string, session: Session): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, "utf8");
};

/** The session is never committed to git. */
export const filePersist =
  (path: string): Persist =>
  (session) =>
    saveSession(path, session);
