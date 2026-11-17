import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUiServer } from "../../server/http";
import { listRepoRows, openProject, openRepos } from "../../server/runs";
import { createFeed, mergeFeeds, type Change, type Feed } from "../../server/watch";
import { Log, session, tempHome, writeRun } from "../fixtures";

const dead = () => false;

/** web holds 84 (done) and a run record of schema version 4; api holds its own 84 and 12. */
const twoRepos = () => {
  const roots = tempHome();
  writeRun(roots.web, "84", session(), new Log().start("r1", 0).visit("init", 0, 1, true, "implement").end(1, "done"));
  writeRun(roots.web, "70", JSON.stringify({ schemaVersion: 4, issue: "70", title: "old run", flow: "task", unit: 1 }));
  writeRun(roots.api, "84", session({ title: "api side of 84" }), new Log().start("r9", 0).visit("init", 0, 1, true, "implement").end(1, "blocked"));
  writeRun(roots.api, "12", session({ issue: "12", title: "twelve" }));
  mkdirSync(join(roots.api, "logs", "84"), { recursive: true });
  writeFileSync(join(roots.api, "logs", "84", "init-1.log"), "api log\n");
  return roots;
};

describe("listRepoRows", () => {
  it("lists the runs of every listed repository, each row naming its repository's folder", async () => {
    const { home } = twoRepos();
    const repos = openRepos(openProject(home, dead));
    const rows = await listRepoRows(repos ?? []);
    expect(rows.map((r) => [r.repo?.folder, r.kind === "run" ? r.summary.title : r.issue]).sort()).toEqual([
      ["api", "api side of 84"],
      ["api", "twelve"],
      ["web", "70"],
      ["web", "shorten the KDoc"],
    ]);
  });

  it("keeps the fields of a run record on another schema version and names the version", async () => {
    const { home } = twoRepos();
    const rows = await listRepoRows(openRepos(openProject(home, dead)) ?? []);
    const foreign = rows.find((r) => r.kind === "error");
    expect(foreign).toMatchObject({
      kind: "error",
      issue: "70",
      repo: { name: "web", folder: "web" },
      title: "old run",
      flow: "task",
      schema: { found: 4, expected: 9 },
    });
  });

  it("is no list for a project without repos:", () => {
    const { web } = tempHome();
    expect(openRepos(openProject(web, dead))).toBeUndefined();
  });
});

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

const serve = async (home: string) => {
  const project = openProject(home, dead);
  const feed: Feed = { subscribe: () => () => undefined, close: () => undefined };
  const server = createUiServer({ project, repos: openRepos(project), feed, distDir: join(home, "none"), github: async () => ({ state: "none" }) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () => {
    server.closeAllConnections();
    return new Promise((r) => server.close(() => r()));
  };
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

describe("api over repos:", () => {
  it("lists both repositories' rows and the home repository in the header", async () => {
    const base = await serve(twoRepos().home);
    const body = (await (await fetch(`${base}/api/runs`)).json()) as { repo: string; flows: string[]; rows: { kind: string; repo?: { folder: string } }[] };
    expect(body.repo).toBe("home");
    expect(body.flows).toEqual(["task"]);
    expect(body.rows.map((r) => r.repo?.folder).sort()).toEqual(["api", "api", "web", "web"]);
  });

  it("opens a run and its logs in the repository the request names", async () => {
    const base = await serve(twoRepos().home);
    const api = (await (await fetch(`${base}/api/runs/84?repo=api`)).json()) as { summary: { title: string; outcome: string } };
    expect(api.summary).toMatchObject({ title: "api side of 84", outcome: "blocked" });
    const web = (await (await fetch(`${base}/api/runs/84?repo=web`)).json()) as { summary: { title: string } };
    expect(web.summary.title).toBe("shorten the KDoc");
    expect(await (await fetch(`${base}/api/runs/84/logs/init-1.log?repo=api`)).text()).toBe("api log\n");
    expect((await fetch(`${base}/api/runs/84?repo=nope`)).status).toBe(404);
  });

  it("starts over a listed repository whose sous.yaml the home engine cannot read, listing it as an error row beside the others' runs", async () => {
    const roots = twoRepos();
    writeFileSync(join(roots.api, "sous.yaml"), "runsDir: runs\nfromTheFuture: true\n");
    const base = await serve(roots.home);
    const body = (await (await fetch(`${base}/api/runs`)).json()) as { rows: { kind: string; issue?: string; error?: string; settings?: boolean; repo?: { name: string } }[] };
    expect(body.rows.map((r) => r.repo?.name).sort()).toEqual(["api", "web", "web"]);
    const broken = body.rows.find((r) => r.repo?.name === "api");
    expect(broken).toMatchObject({ kind: "error", settings: true });
    expect(broken?.error).toContain("fromTheFuture");
    expect((await fetch(`${base}/api/runs/84?repo=api`)).status).toBe(404);
  });

  it("finds a run without a repository named when one repository holds it", async () => {
    const base = await serve(twoRepos().home);
    const res = await fetch(`${base}/api/runs/12`);
    expect(((await res.json()) as { summary: { title: string } }).summary.title).toBe("twelve");
  });
});

describe("mergeFeeds", () => {
  let feed: Feed | undefined;
  afterEach(() => feed?.close());

  it("reports a step change in any listed repository with that repository's name", async () => {
    const { web, api } = tempHome();
    mkdirSync(join(api, "runs", "84"));
    feed = mergeFeeds(
      [
        ["web", web],
        ["api", api],
      ].map(([repo, root]) =>
        createFeed({ root: root!, repo: repo!, runsRoot: join(root!, "runs"), logsRoot: join(root!, "logs"), liveness: async () => "", debounceMs: 20, pollMs: 50, watchFiles: false }),
      ),
    );
    const changes: Change[] = [];
    feed.subscribe((c) => changes.push(c));
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(join(api, "runs", "84", "session.json"), "{}");
    const deadline = Date.now() + 3000;
    while (!changes.some((c) => c.issue === "84")) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(changes.find((c) => c.issue === "84")).toEqual({ issue: "84", repo: "api" });
  });
});
