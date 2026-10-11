/**
 * The HTTP surface of `sous ui`, on `node:http` alone:
 *
 *   GET /api/runs                          every run folder as a list row, the flows and the live lock
 *   GET /api/runs/:issue?attempt=&scope=   one issue as a flow view
 *   GET /api/runs/:issue/logs/:name?from=  an agent log from byte `from` on
 *   GET /api/runs/:issue/github            the GitHub Actions runs of the squash commit (`gh`, cached)
 *   GET /api/flows/:name                   a flow file as a preview graph, run or not
 *   GET /api/events                        Server-Sent Events: `change` with `{issue}`
 *
 * Anything else is the built app from `dist/`; an unknown path gets its
 * `index.html`, since the app routes in the browser.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, join, normalize, sep } from "node:path";
import { repoRootOf } from "sous-factory/read";
import type { GitHubLookup } from "./github.js";
import { flowNames, listRows, liveLocks, readFlow, readLog, readRun, type Project } from "./runs.js";
import type { Feed } from "./watch.js";

export type ServerOptions = { project: Project; feed: Feed; distDir: string; github: GitHubLookup; heartbeatMs?: number };

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const intParam = (value: string | null): number | undefined => {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  return Number(value);
};

const serveStatic = async (res: ServerResponse, distDir: string, pathname: string) => {
  const index = join(distDir, "index.html");
  if (!existsSync(index)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("sous ui: the app is not built; run `npm run build` in packages/ui\n");
    return;
  }
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const file = join(distDir, relative);
  const inside = file.startsWith(distDir + sep) && !relative.split(/[\\/]/).includes("..");
  const target = inside && extname(file) !== "" && existsSync(file) ? file : index;
  const body = await readFile(target);
  const cache = target === index ? "no-cache" : "public, max-age=31536000, immutable";
  res.writeHead(200, { "content-type": TYPES[extname(target)] ?? "application/octet-stream", "cache-control": cache });
  res.end(body);
};

const events = (req: IncomingMessage, res: ServerResponse, feed: Feed, heartbeatMs: number) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write("retry: 2000\n\n");
  const unsubscribe = feed.subscribe((change) => res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`));
  const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
};

const handle = async (req: IncomingMessage, res: ServerResponse, options: ServerOptions) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
  if (path === "/api/events") return events(req, res, options.feed, options.heartbeatMs ?? 15_000);
  if (path === "/api/runs") {
    const [rows, live] = await Promise.all([listRows(options.project), liveLocks(options.project)]);
    return json(res, 200, { repo: basename(repoRootOf(options.project.root)), flows: flowNames(options.project), rows, live });
  }
  const flow = /^\/api\/flows\/([^/]+)$/.exec(path);
  if (flow !== null) {
    const view = readFlow(options.project, decodeURIComponent(flow[1] ?? ""));
    return view === undefined ? json(res, 404, { error: `no flow ${flow[1]}` }) : json(res, 200, view);
  }
  const log = /^\/api\/runs\/([^/]+)\/logs\/([^/]+)$/.exec(path);
  if (log !== null) {
    const read = await readLog(options.project, decodeURIComponent(log[1] ?? ""), decodeURIComponent(log[2] ?? ""), intParam(url.searchParams.get("from")) ?? 0);
    if (read.kind === "invalid") return json(res, 400, { error: "not a log file name" });
    if (read.kind === "missing") return json(res, 404, { error: "no such log" });
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-log-start": String(read.start), "x-log-size": String(read.size) });
    return res.end(read.text);
  }
  const github = /^\/api\/runs\/([^/]+)\/github$/.exec(path);
  if (github !== null) {
    const issue = decodeURIComponent(github[1] ?? "");
    const read = await readRun(options.project, issue);
    if (read.kind === "missing") return json(res, 404, { error: `no run for ${issue}` });
    if (read.kind === "error") return json(res, 422, { error: read.error });
    return json(res, 200, await options.github(read.view.summary.squash));
  }
  const run = /^\/api\/runs\/([^/]+)$/.exec(path);
  if (run !== null) {
    const issue = decodeURIComponent(run[1] ?? "");
    const attempt = intParam(url.searchParams.get("attempt"));
    const scope = url.searchParams.get("scope");
    const read = await readRun(options.project, issue, { ...(attempt !== undefined ? { attempt } : {}), ...(scope !== null ? { scope } : {}) });
    if (read.kind === "missing") return json(res, 404, { error: `no run for ${issue}` });
    if (read.kind === "error") return json(res, 422, { error: read.error });
    return json(res, 200, read.view);
  }
  if (path.startsWith("/api/")) return json(res, 404, { error: "not found" });
  return serveStatic(res, options.distDir, path);
};

export const createUiServer = (options: ServerOptions): Server =>
  createServer((req, res) => {
    handle(req, res, options).catch((error: unknown) => {
      if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  });
