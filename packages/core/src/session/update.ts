/** Pure session mutations; the executor owns the live value. Scope records are `exec/scope.ts`'s. */
import { BLOCKED } from "../config/flow.js";
import { SCHEMA_VERSION, scopeKey, type HistoryEntry, type Session } from "../exec/scope.js";
import type { WorkRecord } from "../index.js";

export type NewSession = {
  flow: string;
  issue: string;
  title: string;
  branch: string;
  specDir: string;
  entry: string;
};

/** A new session starts with the issue itself on the bench. */
export const createSession = ({ flow, issue, title, branch, specDir, entry }: NewSession): Session =>
  setWork(
    {
      schemaVersion: SCHEMA_VERSION,
      flow,
      issue,
      title,
      branch,
      specDir,
      current: entry,
      previous: null,
      work: issue,
      scopes: {},
      workProgress: {},
      history: [],
      iterations: { [entry]: 0 },
      blocked: false,
    },
    issue,
  );

/** Lines kept when a log is stored as a tail (session, events, comments). */
export const LOG_TAIL_LINES = 40;

export const logTail = (log: string, lines: number = LOG_TAIL_LINES): string => log.split("\n").slice(-lines).join("\n");

export const iterationOf = (session: Session, step: string): number => session.iterations[step] ?? 0;

const withIteration = (session: Session, step: string, n: number): Session => ({ ...session, iterations: { ...session.iterations, [step]: n } });

/** A new visit: the step's counter starts fresh. */
export const setCurrent = (session: Session, step: string): Session => withIteration({ ...session, previous: session.current, current: step }, step, 0);

export const bumpIteration = (session: Session, step: string): Session => withIteration(session, step, iterationOf(session, step) + 1);

export const resetIteration = (session: Session, step: string): Session => withIteration(session, step, 0);

export const markBlocked = (session: Session): Session => ({ ...session, blocked: true });

/** Re-entry after `blocked` gives the current step a fresh iteration budget. */
export const clearBlocked = (session: Session): Session => withIteration({ ...session, blocked: false }, session.current, 0);

export const appendHistory = (session: Session, entry: HistoryEntry): Session => ({ ...session, history: [...session.history, entry] });

const emptyRecord = (): WorkRecord => ({ state: "open", commits: [] });

const withProgress = (session: Session, work: string, next: (r: WorkRecord) => WorkRecord): Session => {
  const key = scopeKey(work);
  return { ...session, workProgress: { ...session.workProgress, [key]: next(session.workProgress[key] ?? emptyRecord()) } };
};

/** Re-entering keeps the item's existing scope records and progress. */
export const setWork = (session: Session, work: string): Session => {
  const key = scopeKey(work);
  return withProgress({ ...session, work, scopes: { ...session.scopes, [key]: session.scopes[key] ?? {} } }, work, (r) => r);
};

export const markWorkDone = (session: Session, work: string, commits: readonly string[]): Session =>
  withProgress(session, work, (r) => ({ ...r, state: "done", commits: [...r.commits, ...commits] }));

export const setSpecDir = (session: Session, specDir: string): Session => ({ ...session, specDir });

/** `blocked` keeps `current` on the step, so a re-run resumes there. */
export const transition = (session: Session, step: string, next: string, at: Date, ok: boolean): Session => {
  const recorded = appendHistory(session, { step, at: at.toISOString(), ok, next });
  return next === BLOCKED ? markBlocked(recorded) : setCurrent(recorded, next);
};
