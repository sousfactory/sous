/**
 * Change feed: which issue changed, as soon as the executor writes. Watches
 * the runs folder, the logs folder and the lock with `fs.watch`, debounced
 * per issue. Where watching is unavailable it compares file mtimes on a
 * timer instead. The lock is also polled, because a run that dies without
 * removing it changes liveness without writing anything.
 */
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";
import { LOCK_FILE } from "sous-factory/read";

/** `issue: null` means something every view shares changed: the lock, or the set of runs. */
export type Change = { issue: string | null };

export type FeedOptions = {
  root: string;
  runsRoot: string;
  logsRoot: string;
  /** Liveness of the lock; compared on each poll. */
  liveness: () => Promise<string>;
  debounceMs?: number;
  pollMs?: number;
  /** Tests force the mtime fallback. */
  watchFiles?: boolean;
};

export type Feed = { subscribe: (listener: (change: Change) => void) => () => void; close: () => void };

/** `84/session.json` or `84` → `84`: the first path segment names the run folder; an empty path → null. */
export const issueOf = (relative: string): string | null => {
  const head = relative.split(/[\\/]/)[0] ?? "";
  return head === "" || head.startsWith(".") ? null : head;
};

/** Every file under `dir` one or two levels deep (`<issue>/<file>`) with its mtime. */
const snapshot = (dir: string): Map<string, number> => {
  const out = new Map<string, number>();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = join(dir, entry.name);
    out.set(entry.name, 0);
    for (const file of readdirSync(sub)) {
      try {
        out.set(`${entry.name}${sep}${file}`, statSync(join(sub, file)).mtimeMs);
      } catch {
        // removed between listing and stat
      }
    }
  }
  return out;
};

const changedKeys = (before: Map<string, number>, after: Map<string, number>): string[] => [
  ...[...after].filter(([k, t]) => before.get(k) !== t).map(([k]) => k),
  ...[...before.keys()].filter((k) => !after.has(k)),
];

/** Calls `fire` once per key after `ms` without another `push` of that key. */
export const debouncer = <K>(ms: number, fire: (key: K) => void) => {
  const timers = new Map<K, NodeJS.Timeout>();
  return {
    push(key: K) {
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          fire(key);
        }, ms),
      );
    },
    cancel() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
};

export const createFeed = (options: FeedOptions): Feed => {
  const pollMs = options.pollMs ?? 1000;
  const listeners = new Set<(change: Change) => void>();
  const watchers: FSWatcher[] = [];
  let closed = false;
  const pending = debouncer<string | null>(options.debounceMs ?? 150, (issue) => {
    for (const listener of listeners) listener({ issue });
  });

  const emit = (issue: string | null) => {
    if (!closed) pending.push(issue);
  };

  const tryWatch = (dir: string, recursive: boolean, onName: (name: string) => void): boolean => {
    if (options.watchFiles === false || !existsSync(dir)) return false;
    try {
      const w = watch(dir, { recursive }, (_event, name) => onName(name === null ? "" : String(name)));
      w.on("error", () => w.close());
      watchers.push(w);
      return true;
    } catch {
      return false;
    }
  };

  const fromRuns = (name: string) => emit(issueOf(name));
  const watchedRuns = tryWatch(options.runsRoot, true, (name) => {
    fromRuns(name);
    // A new run folder also changes the list.
    if (issueOf(name) !== null && !name.includes(sep) && !name.includes("/")) emit(null);
  });
  const watchedLogs = tryWatch(options.logsRoot, true, (name) => {
    const issue = issueOf(name);
    if (issue !== null) emit(issue);
  });
  tryWatch(options.root, false, (name) => {
    if (name === LOCK_FILE) emit(null);
  });

  let runs = watchedRuns ? new Map<string, number>() : snapshot(options.runsRoot);
  let logs = watchedLogs ? new Map<string, number>() : snapshot(options.logsRoot);
  let liveness: string | undefined;
  void options.liveness().then((l) => (liveness = l));

  const poll = setInterval(() => {
    if (!watchedRuns) {
      const next = snapshot(options.runsRoot);
      const keys = changedKeys(runs, next);
      runs = next;
      for (const k of keys) emit(issueOf(k));
      if (keys.some((k) => !k.includes(sep))) emit(null);
    }
    if (!watchedLogs) {
      const next = snapshot(options.logsRoot);
      for (const k of changedKeys(logs, next)) emit(issueOf(k));
      logs = next;
    }
    void options.liveness().then((l) => {
      if (liveness !== undefined && l !== liveness) emit(null);
      liveness = l;
    });
  }, pollMs);

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      clearInterval(poll);
      pending.cancel();
      for (const w of watchers) w.close();
      listeners.clear();
    },
  };
};
