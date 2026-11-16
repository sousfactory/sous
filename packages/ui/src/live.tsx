/**
 * Live data: one EventSource for the whole app. Each `change` event bumps a
 * version, per issue or global; a view refetches when its version moves.
 * A global change (the lock, the set of runs) moves every version. Over
 * `repos:` a change names its repository too, and counts for that one only.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Versions = { global: number; issues: Record<string, number>; connected: boolean };

const LiveContext = createContext<Versions>({ global: 0, issues: {}, connected: false });

export const LiveProvider = ({ children }: { children: ReactNode }) => {
  const [versions, setVersions] = useState<Versions>({ global: 0, issues: {}, connected: false });
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/events");
    source.addEventListener("open", () => setVersions((v) => ({ ...v, connected: true, global: v.global + 1 })));
    source.addEventListener("error", () => setVersions((v) => ({ ...v, connected: false })));
    source.addEventListener("change", (event) => {
      const { issue, repo } = JSON.parse((event as MessageEvent<string>).data) as { issue: string | null; repo?: string };
      const key = issue === null ? null : keyOf(issue, repo);
      setVersions((v) => (key === null ? { ...v, global: v.global + 1 } : { ...v, issues: { ...v.issues, [key]: (v.issues[key] ?? 0) + 1 } }));
    });
    return () => source.close();
  }, []);
  return <LiveContext.Provider value={versions}>{children}</LiveContext.Provider>;
};

/** An issue's version key; over `repos:` the same issue id in two repositories counts apart. */
const keyOf = (issue: string, repo: string | undefined): string => (repo === undefined ? issue : `${repo}\u0000${issue}`);

/** A number that changes whenever data of `issue` in `repo` (or of every view) may have changed. */
export const useVersion = (issue?: string, repo?: string): string => {
  const v = useContext(LiveContext);
  return `${v.global}:${issue === undefined ? Object.values(v.issues).reduce((a, b) => a + b, 0) : (v.issues[keyOf(issue, repo)] ?? 0)}`;
};

export const useConnected = (): boolean => useContext(LiveContext).connected;

export type Fetched<T> = { data?: T; error?: string; loading: boolean };

/** GET `url` as JSON, again whenever `version` changes; keeps the last data while reloading. */
export const useJson = <T,>(url: string, version: string): Fetched<T> => {
  const [state, setState] = useState<Fetched<T>>({ loading: true });
  const current = useRef(url);
  current.current = url;
  const load = useCallback(async () => {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      const body = (await res.json()) as T & { error?: string };
      if (current.current !== url) return;
      if (!res.ok) setState({ error: body.error ?? `HTTP ${res.status}`, loading: false });
      else setState({ data: body, loading: false });
    } catch (error) {
      if (current.current === url) setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error), loading: false }));
    }
  }, [url]);
  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
  }, [url]);
  useEffect(() => {
    void load();
  }, [load, version]);
  return state;
};

/** The current time, ticking every second while `active`. */
export const useNow = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
};
