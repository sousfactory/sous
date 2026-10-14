/**
 * The session and its scopes. A scope belongs to one work item (a sub-issue
 * on the bench, or the issue itself), so `steps.<id>` restarts for each
 * sub-issue. Scopes are never deleted. Pure functions; the store persists,
 * `session/update.ts` holds the other mutations.
 */
import type { StepRecord, StepsScope, WorkRecord } from "../index.js";

export const SCHEMA_VERSION = 8;

/** One transition: the step left, how its eval went, and where the run went next. */
export type HistoryEntry = { step: string; at: string; ok: boolean; next: string };

export type Session = {
  schemaVersion: typeof SCHEMA_VERSION;
  flow: string;
  /** The tracker's id of the run's issue. */
  issue: string;
  /** Issue title at run start. */
  title: string;
  branch: string;
  /** `<specsDir>/<issue>-<slug>`, relative to the repository root; `init` may update it. */
  specDir: string;
  current: string;
  /** Id of the step visited before `current`; `null` at entry. */
  previous: string | null;
  /** The work item on the bench: a sub-issue id, or the issue's own. */
  work: string;
  /** `steps.<id>` records per scope key. */
  scopes: Record<string, StepsScope>;
  /** Progress of every work item the run has had on the bench, the issue itself included. */
  workProgress: Record<string, WorkRecord>;
  history: HistoryEntry[];
  /** In-visit counters per step id, reset when a visit opens. */
  iterations: Record<string, number>;
  /** The run stopped at `current` and waits for a human. */
  blocked: boolean;
  /**
   * The lifecycle has closed the issue of a run at `done`. Recorded apart
   * from `current`, which the executor persists first: a close that fails
   * after that is retried on the next `sous run` instead of being skipped.
   */
  closed: boolean;
};

export const scopeKey = (work: string): string => work;

/** `steps` as expressions see it: the records of the current scope. */
export const stepsOf = (session: Session): StepsScope => session.scopes[scopeKey(session.work)] ?? {};

/** What a visit records; `visits` is counted here. */
export type Visit = Omit<StepRecord, "visits">;

const withRecord = (session: Session, key: string, id: string, record: StepRecord): Session => ({
  ...session,
  scopes: { ...session.scopes, [key]: { ...(session.scopes[key] ?? {}), [id]: record } },
});

/**
 * Keeps only the previous visit's `session`, so `resume:` can continue it;
 * its result does not carry over. Were it kept, a run that stops between
 * this visit's agent call and its end would re-enter on the old output and
 * pass on work this visit never finished. A visit starts with `ok: true`, so
 * `sous status` reads a step in progress as fine, not as failed. `key` stays
 * the visit's scope even when the step changes the work item.
 */
export const openVisit = (session: Session, id: string, key: string = scopeKey(session.work)): Session => {
  const previous = session.scopes[key]?.[id];
  return withRecord(session, key, id, {
    ok: true,
    log: "",
    output: undefined,
    commits: [],
    ...(previous?.session !== undefined ? { session: previous.session } : {}),
    visits: (previous?.visits ?? 0) + 1,
  });
};

/** Used after an agent call (`session`) and at the end of the visit (`ok`, `log`, `output`, `commits`). */
export const updateVisit = (session: Session, id: string, patch: Partial<Visit>, key: string = scopeKey(session.work)): Session => {
  const current = session.scopes[key]?.[id];
  if (current === undefined) throw new Error(`no open visit of "${id}" in scope ${key}`);
  return withRecord(session, key, id, { ...current, ...patch });
};

/**
 * Called on the transition into the step, so a recorded `prepare` result
 * always belongs to the visit in progress. Until then the old one stays
 * readable for the steps after it.
 */
export const forgetPrepared = (session: Session, id: string, key: string = scopeKey(session.work)): Session => {
  const current = session.scopes[key]?.[id];
  if (current?.prepared === undefined) return session;
  const { prepared: _forgotten, ...rest } = current;
  return withRecord(session, key, id, rest);
};

export const recordVisit = (session: Session, id: string, visit: Visit): Session => updateVisit(openVisit(session, id), id, visit);
