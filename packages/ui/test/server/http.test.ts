import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUiServer } from "../../server/http";
import type { GitHubLookup } from "../../server/github";
import { parseArgs } from "../../server/main";
import { openProject } from "../../server/runs";
import type { Change, Feed } from "../../server/watch";
import { Log, session, tempProject, writeRun } from "../fixtures";

/** A feed the test drives by hand. */
const manualFeed = () => {
  const listeners = new Set<(c: Change) => void>();
  const feed: Feed = { subscribe: (l) => (listeners.add(l), () => listeners.delete(l)), close: () => listeners.clear() };
  return { feed, push: (c: Change) => listeners.forEach((l) => l(c)), count: () => listeners.size };
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

/** Every sha the GitHub lookup was asked about; the lookup answers `none` without one. */
const asked: (string | undefined)[] = [];
const github: GitHubLookup = async (sha) => {
  asked.push(sha);
  return sha === undefined ? { state: "none" } : { state: "unpushed", sha };
};

const serve = async (withDist = true) => {
  const root = tempProject();
  writeRun(root, "84", session(), new Log().start("r1", 0).visit("init", 0, 1, true, "implement").end(1, "done"));
  writeRun(root, "85", session({ issue: "85", current: "done", workProgress: { "85": { state: "done", commits: ["b2f04a5d78df"] } } }), new Log().start("r1", 0).visit("init", 0, 1, true, "done").end(1, "done"));
  mkdirSync(join(root, "logs", "84"), { recursive: true });
  writeFileSync(join(root, "logs", "84", "init-1.log"), "hello\nworld\n");
  writeFileSync(join(root, "logs", "84", "a1b2c3d4-2-84-implement-1.log"), "agent\n");
  const distDir = join(root, "ui-dist");
  if (withDist) {
    mkdirSync(join(distDir, "assets"), { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<html>app</html>");
    writeFileSync(join(distDir, "assets", "app.js"), "console.log(1)");
  }
  const manual = manualFeed();
  const server = createUiServer({ project: openProject(root, () => false), feed: manual.feed, distDir, github, heartbeatMs: 50 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.closeAllConnections();
    return new Promise((r) => server.close(() => r()));
  };
  return { base, ...manual };
};

describe("api", () => {
  it("lists the runs and the live lock", async () => {
    const { base } = await serve();
    const body = (await (await fetch(`${base}/api/runs`)).json()) as { repo: string; flows: string[]; rows: { kind: string }[]; live: unknown };
    expect(body.repo).toBe("repo");
    expect(body.flows).toEqual(["task"]);
    expect(body.rows.map((r) => r.kind)).toEqual(["run", "run"]);
    expect(body.live).toBeNull();
  });

  it("asks GitHub about the squash commit of a done run only, 404 for an unknown issue", async () => {
    const { base } = await serve();
    asked.length = 0;
    expect(await (await fetch(`${base}/api/runs/85/github`)).json()).toEqual({ state: "unpushed", sha: "b2f04a5d78df" });
    expect(await (await fetch(`${base}/api/runs/84/github`)).json()).toEqual({ state: "none" });
    expect(asked).toEqual(["b2f04a5d78df", undefined]);
    expect((await fetch(`${base}/api/runs/99/github`)).status).toBe(404);
  });

  it("returns one run's view, 404 for an unknown issue", async () => {
    const { base } = await serve();
    const ok = await fetch(`${base}/api/runs/84?attempt=1`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { summary: { outcome: string } }).summary.outcome).toBe("done");
    expect((await fetch(`${base}/api/runs/99`)).status).toBe(404);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it("returns a flow as a preview, 404 for a name that is not a flow file", async () => {
    const { base } = await serve();
    const ok = await fetch(`${base}/api/flows/task`);
    expect(ok.status).toBe(200);
    const view = (await ok.json()) as { name: string; entry: string; nodes: { id: string; status: string }[] };
    expect(view).toMatchObject({ name: "task", entry: "init" });
    expect(view.nodes.map((n) => [n.id, n.status])).toEqual([
      ["init", "queued"],
      ["implement", "queued"],
      ["merge", "queued"],
    ]);
    expect((await fetch(`${base}/api/flows/feature`)).status).toBe(404);
    expect((await fetch(`${base}/api/flows/..%2Fsous`)).status).toBe(404);
  });

  it("serves a log from an offset and refuses other files", async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/api/runs/84/logs/init-1.log?from=6`);
    expect(res.headers.get("x-log-start")).toBe("6");
    expect(res.headers.get("x-log-size")).toBe("12");
    expect(await res.text()).toBe("world\n");
    expect(await (await fetch(`${base}/api/runs/84/logs/a1b2c3d4-2-84-implement-1.log`)).text()).toBe("agent\n");
    expect((await fetch(`${base}/api/runs/84/logs/..%2F..%2Fsous.yaml`)).status).toBe(400);
    expect((await fetch(`${base}/api/runs/84/logs/a1b2c3d4-2%2F..%2F..%2F..%2Fsous.yaml`)).status).toBe(400);
    expect((await fetch(`${base}/api/runs/84/logs/fix-1.log`)).status).toBe(404);
  });

  it("only answers GET", async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/api/runs`, { method: "POST" })).status).toBe(405);
  });
});

describe("events", () => {
  it("streams each change and stops listening when the client leaves", async () => {
    const { base, push, count } = await serve();
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    await new Promise((r) => setTimeout(r, 20));
    push({ issue: "84" });
    while (!text.includes("data: {\"issue\":\"84\"}")) text += decoder.decode((await reader.read()).value);
    expect(text).toContain("event: change");
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(count()).toBe(0);
  });
});

describe("static app", () => {
  it("serves assets and falls back to index.html for app routes", async () => {
    const { base } = await serve();
    expect(await (await fetch(`${base}/assets/app.js`)).text()).toBe("console.log(1)");
    expect(await (await fetch(`${base}/runs/84`)).text()).toBe("<html>app</html>");
    expect(await (await fetch(`${base}/assets/..%2F..%2Fsous.yaml`)).text()).toBe("<html>app</html>");
  });

  it("says how to build when there is no app", async () => {
    const { base } = await serve(false);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/npm run build/);
  });
});

describe("parseArgs", () => {
  it("takes no arguments or --port <n>", () => {
    expect(parseArgs([])).toEqual({ port: 4680 });
    expect(parseArgs(["--port", "5000"])).toEqual({ port: 5000 });
    for (const bad of [["--port"], ["--port", "x"], ["--port", "0"], ["--port", "70000"], ["5000"], ["--port", "1", "2"]]) expect(parseArgs(bad)).toBeUndefined();
  });
});
