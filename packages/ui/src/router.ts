/** A path-and-query router over the History API; the app has three routes. */
import { useEffect, useState } from "react";

export type Route = { page: "runs"; flow?: string; step?: string } | { page: "run"; issue: string; attempt?: number; scope?: string; step?: string };

const param = (q: URLSearchParams, name: string): string | undefined => q.get(name) ?? undefined;

export const parseRoute = (pathname: string, search: string): Route => {
  const q = new URLSearchParams(search);
  const run = /^\/runs\/([^/]+)\/?$/.exec(pathname);
  if (run !== null) {
    const attempt = param(q, "attempt");
    const scope = param(q, "scope");
    const step = param(q, "step");
    return {
      page: "run",
      issue: decodeURIComponent(run[1] ?? ""),
      ...(attempt !== undefined && /^\d+$/.test(attempt) ? { attempt: Number(attempt) } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(step !== undefined ? { step } : {}),
    };
  }
  const flow = param(q, "flow");
  const step = flow !== undefined ? param(q, "step") : undefined;
  return { page: "runs", ...(flow !== undefined ? { flow } : {}), ...(step !== undefined ? { step } : {}) };
};

export const hrefOf = (route: Route): string => {
  if (route.page === "runs") {
    if (route.flow === undefined) return "/runs";
    return `/runs?flow=${encodeURIComponent(route.flow)}${route.step !== undefined ? `&step=${encodeURIComponent(route.step)}` : ""}`;
  }
  const q = new URLSearchParams();
  if (route.attempt !== undefined) q.set("attempt", String(route.attempt));
  if (route.scope !== undefined) q.set("scope", route.scope);
  if (route.step !== undefined) q.set("step", route.step);
  const query = q.toString();
  return `/runs/${encodeURIComponent(route.issue)}${query !== "" ? `?${query}` : ""}`;
};

const listeners = new Set<() => void>();

export const navigate = (href: string): void => {
  if (href === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", href);
  listeners.forEach((l) => l());
};

export const useRoute = (): Route => {
  const read = () => parseRoute(window.location.pathname, window.location.search);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => setRoute(read());
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return route;
};

/** Click handler for an in-app link: plain left clicks navigate, modified ones open as usual. */
export const onLinkClick = (href: string) => (event: React.MouseEvent) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(href);
};
