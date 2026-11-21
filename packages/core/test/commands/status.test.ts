import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileEventLog } from "../../src/adapters/eventlog.js";
import { formatCost } from "../../src/session/cost.js";
import { formatDuration, laneName, renderStatus, statusCommand, type StatusDeps, type StatusPaths } from "../../src/commands/status.js";
import { overviewLookupOf, type Lookup } from "../../src/lookup.js";
import { fakeTracker, issue, type FakeTracker } from "../fakes/tracker.js";
import { recordVisit, type Session } from "../../src/exec/scope.js";
import type { Event } from "../../src/session/events.js";
import { eventsFile, runDir, sessionFile } from "../../src/session/paths.js";
import { saveSession } from "../../src/session/store.js";
import { foldTimeline } from "../../src/session/timeline.js";
import { trail89 } from "../helpers/trail.js";
import { bumpIteration, createSession, markBlocked, markWorkDone, setCurrent, setWork } from "../../src/session/update.js";

const fresh = (entry: string, flow = "feature"): Session =>
  createSession({ flow, issue: "12", title: "Some slug", branch: "feature/12-some-slug", specDir: "specs/12-some-slug", entry });

/** #14 done, #15 on the bench, in build's second iteration after a failed review in this scope. */
const sample = (): Session => {
  let s = fresh("init");
  s = markWorkDone(setWork(s, "14"), "14", ["abc1234567890", "def4567890123"]);
  s = setWork(s, "15");
  s = setCurrent(setCurrent(s, "review"), "build");
  s = recordVisit(s, "review", { ok: false, log: "FAILED tests\n> Task :test FAILED", output: {}, commits: [] });
  s = recordVisit(s, "build", { ok: true, log: "", output: {}, commits: ["c1"], session: "b1" });
  s = bumpIteration(bumpIteration(s, "build"), "build");
  return {
    ...s,
    history: [
      { step: "init", at: "t", ok: true, next: "next-work" },
      { step: "next-work", at: "t", ok: true, next: "build" },
    ],
  };
};

const paths: StatusPaths = { runDir: "/repo/.sous/runs/12", logDir: "/repo/.sous/logs/12" };
const none = foldTimeline([]);

describe("renderStatus", () => {
  it("renders facts, the work progress table and the last eval tail with aligned columns", () => {
    expect(renderStatus(sample(), none, paths)).toBe(
      [
        "issue        12",
        "flow         feature",
        "branch       feature/12-some-slug",
        "current      build",
        "previous     review",
        "work         15",
        "visits       1",
        "iteration    2",
        "blocked      no",
        "transitions  2",
        "spec         specs/12-some-slug",
        "run          /repo/.sous/runs/12",
        "logs         /repo/.sous/logs/12",
        "engine       -",
        "",
        "work progress",
        "  work  state  commits",
        "  12    open   -",
        "  14    done   abc1234, def4567",
        "  15    open   -",
        "",
        "last eval  review: FAILED",
        "  FAILED tests",
        "  > Task :test FAILED",
      ].join("\n"),
    );
  });

  it("shows the blocked flag, the issue's own work and omits empty sections", () => {
    const blocked = markBlocked(fresh("fix", "task"));
    const text = renderStatus(blocked, none, paths);
    expect(text).toContain("blocked      yes");
    expect(text).toContain("current      fix");
    expect(text).toContain("previous     -");
    expect(text).toContain("work         12");
    expect(text).toContain("visits       0");
    expect(text).toContain("work progress\n  work  state  commits\n  12    open   -");
    expect(text).not.toContain("last eval");
    expect(text).not.toContain("timeline");
  });

  it("names the engine that last started the run, and - for a session from before it was recorded", () => {
    expect(renderStatus({ ...fresh("fix", "task"), engine: "0.9.1" }, none, paths)).toContain("engine       0.9.1");
    expect(renderStatus(fresh("fix", "task"), none, paths)).toContain("engine       -");
  });

  it("shows the last eval only when the step just left has a record in the current scope", () => {
    const s = setCurrent(recordVisit(setWork(fresh("build"), "14"), "build", { ok: true, log: "green", output: {}, commits: [] }), "sync");
    expect(renderStatus(s, none, paths)).toContain("last eval  build: ok\n  green");
    expect(renderStatus(setWork(s, "12"), none, paths)).not.toContain("last eval");
  });
});

describe("renderStatus: timeline", () => {
  const at = (h: number, m: number, s: number) => new Date(Date.UTC(2026, 9, 2, h, m, s)).toISOString();
  const run = (runId: string, start: string, extra: Partial<Extract<Event, { type: "run.start" }>> = {}): Event => ({
    type: "run.start",
    at: start,
    runId,
    pid: 1,
    host: "h",
    sha: "x",
    flow: "feature",
    ...extra,
  });

  /** r1 died in a review agent call; r2 resumed there and ended blocked. */
  const timed = (): Event[] => [
    run("r1", at(9, 0, 0)),
    { type: "span.open", at: at(9, 0, 1), runId: "r1", spanId: "r1-1", step: "init", scope: "12" },
    { type: "span.close", at: at(9, 0, 3), spanId: "r1-1", ok: true, next: "build", scopeAfter: "12" },
    { type: "span.open", at: at(9, 0, 3), runId: "r1", spanId: "r1-2", step: "build", scope: "13" },
    { type: "iteration.agent.start", at: at(9, 0, 3), spanId: "r1-2", n: 1, kind: "claude", model: "b" },
    { type: "iteration.agent.end", at: at(9, 2, 3), spanId: "r1-2", n: 1, outcome: "ok", commits: ["c1"] },
    { type: "iteration.eval.start", at: at(9, 2, 3), spanId: "r1-2", n: 1 },
    { type: "iteration.eval.end", at: at(9, 2, 33), spanId: "r1-2", n: 1, ok: false },
    { type: "iteration.agent.start", at: at(9, 2, 33), spanId: "r1-2", n: 2, kind: "claude", model: "b" },
    { type: "iteration.agent.end", at: at(9, 4, 45), spanId: "r1-2", n: 2, outcome: "ok", commits: ["c2"] },
    { type: "iteration.eval.start", at: at(9, 4, 45), spanId: "r1-2", n: 2 },
    { type: "iteration.eval.end", at: at(9, 5, 18), spanId: "r1-2", n: 2, ok: true },
    { type: "span.close", at: at(9, 5, 18), spanId: "r1-2", ok: true, next: "review" },
    { type: "span.open", at: at(9, 5, 18), runId: "r1", spanId: "r1-3", step: "review", scope: "13" },
    { type: "iteration.agent.start", at: at(9, 5, 19), spanId: "r1-3", n: 1, kind: "codex", model: "r" },
    run("r2", at(11, 0, 0), { resumedFrom: { step: "review", iteration: 0 }, spec: "issue" }),
    { type: "span.open", at: at(11, 0, 1), runId: "r2", spanId: "r2-1", step: "review", scope: "13" },
    { type: "span.close", at: at(11, 0, 9), spanId: "r2-1", ok: false, next: "fix" },
    { type: "run.end", at: at(11, 0, 10), runId: "r2", outcome: "blocked" },
  ];

  const session = (): Session => ({
    ...fresh("review"),
    history: [
      { step: "init", at: at(9, 0, 3), ok: true, next: "build" },
      { step: "build", at: at(9, 5, 18), ok: true, next: "review" },
      { step: "review", at: at(11, 0, 9), ok: false, next: "fix" },
    ],
  });

  it("lists spans per run segment in one lane per scope, with durations, results and the iteration breakdown", () => {
    const text = renderStatus(session(), foldTimeline(timed()), paths);
    expect(text.slice(text.indexOf("timeline"))).toBe(
      [
        "timeline",
        "  ✓ complete  … in progress  ? incomplete (end estimated)  - untracked",
        "  run r1  09:00:00  crashed",
        "    work 12",
        "      ✓ 09:00:01  init 2s  ok",
        "    work 13",
        "      ✓ 09:00:03  build 5m15s  ok  (2 iter: agent 4m12s, eval 1m03s)",
        "      ? 09:05:18  review ~1s  incomplete (est. end 09:05:19)  (1 iter)",
        "  run r2  11:00:00  blocked  (idle 1h54m)  resumed at review  spec: issue",
        "    work 13",
        "      ✓ 11:00:01  review 8s  fail",
      ].join("\n"),
    );
  });

  it("marks a span of the open run in progress and a transition without a span untracked", () => {
    const events: Event[] = [
      run("r1", at(9, 0, 0)),
      { type: "span.open", at: at(9, 0, 1), runId: "r1", spanId: "r1-1", step: "build", scope: "12" },
      { type: "iteration.agent.start", at: at(9, 0, 1), spanId: "r1-1", n: 1, kind: "claude", model: "b" },
    ];
    const s: Session = { ...fresh("build", "task"), history: [{ step: "init", at: "t", ok: true, next: "build" }] };

    const text = renderStatus(s, foldTimeline(events), paths);

    expect(text.slice(text.indexOf("timeline"))).toBe(
      [
        "timeline",
        "  ✓ complete  … in progress  ? incomplete (end estimated)  - untracked",
        "  untracked",
        "    - init  ok",
        "  run r1  09:00:00  running",
        "    work 12",
        "      … 09:00:01  build running  open  (1 iter)",
      ].join("\n"),
    );
  });

  it("groups spans whose run segment is missing from the log under `run -`", () => {
    const events: Event[] = [
      { type: "span.open", at: at(9, 0, 1), runId: "gone", spanId: "gone-1", step: "verify", scope: "12" },
      { type: "span.close", at: at(9, 0, 4), spanId: "gone-1", ok: true, next: "review" },
    ];
    expect(renderStatus(fresh("review", "task"), foldTimeline(events), paths)).toContain("  run -\n    work 12\n      ✓ 09:00:01  verify 3s  ok");
  });

  it("lanes a visit by the work item it operated on: sync and the full-branch steps under the issue, next-work under the sub-issue it picked", () => {
    const s: Session = { ...createSession({ flow: "feature", issue: "89", title: "t", branch: "b", specDir: "", entry: "init" }), current: "done" };
    for (const withScopeAfter of [true, false]) {
      const text = renderStatus(s, foldTimeline(trail89(withScopeAfter)), paths);
      const lines = text.slice(text.indexOf("  run r1")).split("\n").map((l) => l.trim().replace(/^✓ \S+  (\S+) .*$/, "$1"));
      expect(lines.slice(1)).toEqual([
        "work 89", "init", "sync", "review-full", "merge",
        "work 90", "next-work", "implement", "review", "close-work",
        "work 91", "next-work", "implement", "review", "close-work", "next-work",
      ]);
    }
  });

  it("shows each step's cost beside its durations and the run's after its outcome, with + when a call reported none", () => {
    const costed = (events: Event[], costs: Record<string, number>): Event[] =>
      events.map((e): Event => {
        const costUsd = e.type === "iteration.agent.end" ? costs[`${e.spanId}/${e.n}`] : undefined;
        return e.type === "iteration.agent.end" && costUsd !== undefined ? { ...e, costUsd } : e;
      });
    const r1 = (costs: Record<string, number>) => {
      const text = renderStatus(session(), foldTimeline(costed(timed(), costs)), paths);
      return text.split("\n").filter((l) => l.includes("run r1") || l.includes(" build "));
    };
    const reviewCall: Event = { type: "iteration.agent.end", at: at(9, 5, 20), spanId: "r1-3", n: 1, outcome: "ok", commits: [], costUsd: 0.25 };

    expect(r1({ "r1-2/1": 1, "r1-2/2": 2.5 })).toEqual([
      "  run r1  09:00:00  crashed  cost $3.50+",
      "      ✓ 09:00:03  build 5m15s  ok  (2 iter: agent 4m12s, eval 1m03s, cost $3.50)",
    ]);
    expect(r1({ "r1-2/1": 1 })[1]).toBe("      ✓ 09:00:03  build 5m15s  ok  (2 iter: agent 4m12s, eval 1m03s, cost $1.00+)");
    expect(r1({})).toEqual(["  run r1  09:00:00  crashed", "      ✓ 09:00:03  build 5m15s  ok  (2 iter: agent 4m12s, eval 1m03s)"]);

    const fullyCosted = [...costed(timed(), { "r1-2/1": 1, "r1-2/2": 2.5 })];
    fullyCosted.splice(fullyCosted.findIndex((e) => e.type === "run.start" && e.runId === "r2"), 0, reviewCall);
    expect(renderStatus(session(), foldTimeline(fullyCosted), paths)).toContain("  run r1  09:00:00  crashed  cost $3.75\n");
  });

  it("formats a cost with two decimals, a + for a lower bound, <$0.01 for a fraction of a cent, and nothing when none is known", () => {
    expect(formatCost(0.5, 0)).toBe("$0.50");
    expect(formatCost(0.5, 2)).toBe("$0.50+");
    expect(formatCost(0.004, 0)).toBe("<$0.01");
    expect(formatCost(undefined, 0)).toBe("");
    expect(formatCost(undefined, 3)).toBe("");
  });

  it("formats durations and lane names", () => {
    expect([0, 42_400, 252_000, 7_380_000].map(formatDuration)).toEqual(["0s", "42s", "4m12s", "2h03m"]);
    expect([laneName("12"), laneName("14")]).toEqual(["work 12", "work 14"]);
  });
});

describe("statusCommand", () => {
  let repoRoot: string;
  let root: string;
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { deps: { root, out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
  };

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "sous-status-"));
    root = join(repoRoot, ".sous");
    await mkdir(root);
  });
  afterEach(() => rm(repoRoot, { recursive: true, force: true }));

  it("reads the run folder under the settings' runsDir of a project written with the tracker block and renders session and timeline", async () => {
    await writeFile(join(root, "sous.yaml"), "runsDir: ../state/runs\ntracker: { type: github, repo: acme/web, shared: false, labels: sous }\n");
    const runs = join(repoRoot, "state", "runs");
    await saveSession(sessionFile(runs, "12"), sample());
    const log = createFileEventLog(eventsFile(runs, "12"));
    await log.append({ type: "run.start", at: "2026-10-02T09:00:00.000Z", runId: "r1", pid: 1, host: "h", sha: "x", flow: "feature" });
    await log.append({ type: "span.open", at: "2026-10-02T09:00:01.000Z", runId: "r1", spanId: "r1-1", step: "build", scope: "15" });

    const { deps, out, err } = io();
    expect(await statusCommand(["12"], deps)).toBe(0);
    expect(err).toEqual([]);
    const text = out.join("\n");
    expect(text).toContain(`run          ${runDir(runs, "12")}`);
    expect(text).toContain(`logs         ${join(root, "logs", "12")}`);
    expect(text).toContain("current      build");
    expect(text).toContain("  run r1  09:00:00  running\n    work 15\n      … 09:00:01  build running  open");
  });

  it("renders a session without an events file", async () => {
    await saveSession(sessionFile(join(repoRoot, ".sous", "runs"), "12"), sample());
    const { deps, out } = io();
    expect(await statusCommand(["12"], deps)).toBe(0);
    expect(out.join("\n")).not.toContain("timeline");
  });

  it("exits 1 with a clear message when there is no run folder", async () => {
    const { deps, out, err } = io();
    expect(await statusCommand(["999"], deps)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["sous status: no session for 999"]);
  });

  it("exits 2 naming sous status [<issue>] [--json] on an invalid, extra or unknown argument", async () => {
    const { deps, out, err } = io();
    const bad = [["#"], ["1", "2"], ["--yaml"], ["1", "--json", "--json"], ["--json", "1", "2"]];
    for (const args of bad) expect(await statusCommand(args, deps)).toBe(2);
    expect(out).toEqual([]);
    expect(err).toEqual(bad.map(() => "usage: sous status [<issue>] [--json]"));
  });

  it("prints the per-issue facts and the timeline's runs and spans as one JSON document with --json, before or after the issue", async () => {
    const runs = join(root, "runs");
    await saveSession(sessionFile(runs, "12"), { ...sample(), engine: "0.9.1" });
    const log = createFileEventLog(eventsFile(runs, "12"));
    await log.append({ type: "run.start", at: "2026-10-02T09:00:00.000Z", runId: "r1", pid: 1, host: "h", sha: "x", flow: "feature" });
    await log.append({ type: "span.open", at: "2026-10-02T09:00:01.000Z", runId: "r1", spanId: "r1-1", step: "build", scope: "15" });

    for (const args of [["12", "--json"], ["--json", "#12"]]) {
      const { deps, out } = io();
      expect(await statusCommand(args, deps)).toBe(0);
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0]!)).toEqual({
        issue: "12",
        flow: "feature",
        branch: "feature/12-some-slug",
        current: "build",
        previous: "review",
        work: "15",
        visits: 1,
        iteration: 2,
        blocked: false,
        transitions: 2,
        spec: "specs/12-some-slug",
        run: runDir(runs, "12"),
        logs: join(root, "logs", "12"),
        engine: "0.9.1",
        workProgress: [
          { work: "12", state: "open", commits: [] },
          { work: "14", state: "done", commits: ["abc1234567890", "def4567890123"] },
          { work: "15", state: "open", commits: [] },
        ],
        lastEval: { step: "review", ok: false, log: "FAILED tests\n> Task :test FAILED" },
        runs: [{ id: "r1", startedAt: "2026-10-02T09:00:00.000Z", pid: 1, host: "h", sha: "x", flow: "feature", costUnknown: 0 }],
        spans: [{ id: "r1-1", runId: "r1", step: "build", scope: "15", startedAt: "2026-10-02T09:00:01.000Z", iterations: [], costUnknown: 0 }],
      });
    }
  });
});

describe("sous status: the overview", () => {
  const T0 = Date.parse("2026-11-21T10:00:00.000Z");
  const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
  const LIVE = 100;
  const TRACKER = "tracker: { type: local, dir: issues, shared: false, labels: sous }";

  let dir: string;
  /** The fake behind each entry, by name. */
  let trackers: Map<string, FakeTracker>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sous-overview-"));
    trackers = new Map();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  /** A repository `name` under the temp dir with its own `.sous/sous.yaml`. */
  const repository = async (name: string, extra = ""): Promise<string> => {
    const root = join(dir, name, ".sous");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "sous.yaml"), `engine: ^0.9.0\nname: ${name}\n${TRACKER}\n${extra}`);
    return root;
  };

  /** A session of issue `id` at `current`, its run segments as `events`. */
  const run = async (root: string, id: string, current: string, events: Event[], blocked = false): Promise<void> => {
    const runs = join(root, "runs");
    const s = createSession({ flow: "task", issue: id, title: `stored ${id}`, branch: `task/${id}-x`, specDir: "", entry: current });
    await saveSession(sessionFile(runs, id), { ...s, blocked });
    const log = createFileEventLog(eventsFile(runs, id));
    for (const event of events) await log.append(event);
  };
  const start = (runId: string, at: string, pid = 1): Event => ({ type: "run.start", at, runId, pid, host: "h", sha: "x", flow: "task" });
  const end = (runId: string, at: string, outcome: "done" | "blocked" | "crashed" | "interrupted"): Event => ({ type: "run.end", at, runId, outcome });
  const open = (runId: string, spanId: string, at: string, step: string): Event => ({ type: "span.open", at, runId, spanId, step, scope: "x" });
  const lock = async (root: string, name: string, pid: number, issueId: string): Promise<void> => {
    await mkdir(join(root, "locks"), { recursive: true });
    await writeFile(join(root, "locks", name), `${JSON.stringify({ pid, issue: issueId })}\n`);
  };

  /** The lookup the overview builds, each entry's tracker swapped for its fake. */
  const lookup = (root: string) => async (): Promise<Lookup> => {
    const built = await overviewLookupOf(root, undefined, "0.9.1");
    return { ...built, repos: built.repos.map((r) => ({ ...r, tracker: trackers.get(r.name) ?? r.tracker })) };
  };

  const deps = (root: string, extra: Partial<StatusDeps> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const probed: string[] = [];
    return {
      out,
      err,
      probed,
      deps: {
        root,
        out: (l: string) => out.push(l),
        err: (l: string) => err.push(l),
        lookup: lookup(root),
        isAlive: (pid: number) => pid === LIVE,
        probe: async (url: string) => (probed.push(url), false),
        engineVersion: "0.9.1",
        now: () => T0 + 60 * 60_000,
        ...extra,
      } satisfies StatusDeps,
    };
  };

  /** One issue of each state in repository `web`: 1 running, 2 blocked, 3 crashed, 4 interrupted, 5 and 6 done, 9 ready. */
  const fixtureRepo = async (): Promise<string> => {
    const root = await repository("web");
    await run(root, "1", "build", [start("r1", iso(10), LIVE), open("r1", "s1", iso(12), "build")]);
    await lock(root, "1.lock", LIVE, "1");
    await run(root, "2", "review", [start("r1", iso(0)), end("r1", iso(20), "blocked")], true);
    await run(root, "3", "build", [start("r1", iso(0)), end("r1", iso(30), "crashed")]);
    await run(root, "4", "implement", [start("r1", iso(0)), end("r1", iso(40), "interrupted")]);
    await run(root, "5", "done", [start("r1", iso(0)), end("r1", iso(5), "done")]);
    await run(root, "6", "done", [start("r1", iso(0)), end("r1", iso(6), "done")]);
    trackers.set(
      "web",
      fakeTracker({
        issues: [
          issue({ id: "1", title: "Running one" }),
          issue({ id: "2", title: "Blocked one" }),
          issue({ id: "3", title: "Crashed one" }),
          issue({ id: "4", title: "Interrupted one" }),
          issue({ id: "9", title: "Ready one", labels: ["sous:ready"] }),
          issue({ id: "2b", title: "Not ready" }),
        ],
      }),
    );
    return root;
  };

  it("prints the single repository, its tracker, no daemon, no UI and one row per issue needing attention, in state order", async () => {
    const root = await fixtureRepo();
    const { deps: d, out, err, probed } = deps(root);

    expect(await statusCommand([], d)).toBe(0);

    expect(err).toEqual([]);
    expect(probed).toEqual(["http://127.0.0.1:4680/"]);
    expect(out.join("\n")).toBe(
      [
        "single repository web",
        "engine 0.9.1",
        `tracker local ${join(root, "issues")}, shared: false`,
        "daemon: none",
        "ui: not running (sous ui)",
        "",
        "issue  title            state        step       since",
        "1      Running one      running      build      48m00s",
        "2      Blocked one      blocked      review     40m00s",
        "3      Crashed one      crashed      build      30m00s",
        "4      Interrupted one  interrupted  implement  20m00s",
        "9      Ready one        ready        -          -",
        "2 done, see sous ui",
      ].join("\n"),
    );
  });

  it("names a daemon whose watch lock holds a live pid, with its start, and a stale watch lock as stale", async () => {
    const root = await repository("web");
    await lock(root, "watch.pid", LIVE, "watch");
    const since = new Date(Date.parse("2026-11-21T09:30:00.000Z"));
    await utimes(join(root, "locks", "watch.pid"), since, since);
    const live = deps(root);
    expect(await statusCommand([], live.deps)).toBe(0);
    expect(live.out.join("\n")).toContain("\ndaemon: running (pid 100, since 2026-11-21 09:30:00 UTC)\n");

    await lock(root, "watch.pid", 999, "watch");
    const stale = deps(root);
    expect(await statusCommand([], stale.deps)).toBe(0);
    expect(stale.out.join("\n")).toContain("\ndaemon: none (stale locks/watch.pid, pid 999 is not running)\n");
    expect(stale.out.join("\n")).toContain("\nno issue needs attention");
  });

  it("prints the run viewer's link on a line of its own when something answers on the project's uiPort", async () => {
    const root = await repository("web", "uiPort: 4999\n");
    const { deps: d, out, probed } = deps(root, { probe: async (url) => (probed.push(url), true) });
    expect(await statusCommand([], d)).toBe(0);
    expect(probed).toEqual(["http://127.0.0.1:4999/"]);
    expect(out.join("\n").split("\n")).toContain("ui: http://127.0.0.1:4999");
  });

  it("prints the same facts as one JSON document with --json", async () => {
    const root = await fixtureRepo();
    await lock(root, "watch.pid", LIVE, "watch");
    const since = new Date(Date.parse("2026-11-21T09:30:00.000Z"));
    await utimes(join(root, "locks", "watch.pid"), since, since);
    const { deps: d, out } = deps(root, { probe: async () => true });

    expect(await statusCommand(["--json"], d)).toBe(0);

    expect(out).toHaveLength(1);
    const repoRoot = join(dir, "web");
    const row = (issueId: string, title: string, state: string, step: string, since: string) => ({
      issue: issueId,
      title,
      state,
      step,
      since,
      branch: `task/${issueId}-x`,
      worktree: join(repoRoot, ".sous", "worktrees", `task-${issueId}-x`),
    });
    expect(JSON.parse(out[0]!)).toEqual({
      mode: "single",
      engine: "0.9.1",
      entries: [
        {
          name: "web",
          path: repoRoot,
          tracker: { type: "local", location: join(root, "issues"), shared: false },
          unrunnable: null,
          runs: [
            row("1", "Running one", "running", "build", iso(12)),
            row("2", "Blocked one", "blocked", "review", iso(20)),
            row("3", "Crashed one", "crashed", "build", iso(30)),
            row("4", "Interrupted one", "interrupted", "implement", iso(40)),
          ],
          ready: [{ issue: "9", title: "Ready one", branch: null, worktree: null }],
          done: 2,
          note: null,
        },
      ],
      daemon: { running: true, pid: 100, since: "2026-11-21T09:30:00.000Z", stale: false },
      ui: { port: 4680, url: "http://127.0.0.1:4680/", up: true },
    });
  });

  it("leaves - titles, no ready rows and one note when the tracker does not answer, and still exits 0", async () => {
    const root = await fixtureRepo();
    const broken = trackers.get("web")!;
    broken.list = async () => {
      throw new Error("gh: connection refused");
    };
    const { deps: d, out, err } = deps(root);

    expect(await statusCommand([], d)).toBe(0);

    expect(err).toEqual([]);
    expect(out.join("\n").split("\n").slice(6)).toEqual([
      "issue  title  state        step       since",
      "1      -      running      build      48m00s",
      "2      -      blocked      review     40m00s",
      "3      -      crashed      build      30m00s",
      "4      -      interrupted  implement  20m00s",
      "2 done, see sous ui",
      `tracker ${join(root, "issues")} did not answer; ready issues not shown`,
    ]);
  });

  it("orders each entry's runs in the JSON by state, then by issue, as the table does", async () => {
    const root = await repository("web");
    await run(root, "3", "review", [start("r1", iso(0)), end("r1", iso(20), "blocked")], true);
    await run(root, "5", "build", [start("r1", iso(0)), end("r1", iso(30), "crashed")]);
    await run(root, "7", "build", [start("r1", iso(10), LIVE), open("r1", "s1", iso(12), "build")]);
    await lock(root, "7.lock", LIVE, "7");
    const { deps: d, out } = deps(root);

    expect(await statusCommand(["--json"], d)).toBe(0);

    const overview = JSON.parse(out[0]!) as { entries: { runs: { issue: string; state: string }[] }[] };
    expect(overview.entries[0]!.runs.map(({ issue, state }) => `${issue} ${state}`)).toEqual(["7 running", "3 blocked", "5 crashed"]);
  });

  it("shows the home's own runs when the list names the home", async () => {
    const home = await repository("home", "repos: { home: ., api: ../api }\n");
    await run(home, "50", "build", [start("r1", iso(0)), end("r1", iso(10), "blocked")], true);
    const api = await repository("api");
    await run(api, "7", "review", [start("r1", iso(0)), end("r1", iso(25), "blocked")], true);
    trackers.set("home", fakeTracker({ issues: [issue({ id: "50", title: "Home blocked" })] }));
    trackers.set("api", fakeTracker({ issues: [issue({ id: "7", title: "Api blocked" })] }));
    const { deps: d, out } = deps(home);

    expect(await statusCommand([], d)).toBe(0);

    expect(out.join("\n").split("\n").slice(-3)).toEqual([
      "entry  issue  title         state    step    since",
      "home   50     Home blocked  blocked  build   50m00s",
      "api    7      Api blocked   blocked  review  35m00s",
    ]);
  });

  it("covers in a home every entry sous watch would serve, an entry set aside with the daemon's reason, the home's own runs only when listed", async () => {
    const home = await repository("home", "repos: { api: ../api, web: ../web, gone: ../gone }\n");
    // The home's own run is not shown: the list does not name the home.
    await run(home, "50", "build", [start("r1", iso(0)), end("r1", iso(10), "blocked")], true);
    const api = await repository("api");
    await run(api, "7", "review", [start("r1", iso(0)), end("r1", iso(25), "blocked")], true);
    const web = await fixtureRepo();
    trackers.set("api", fakeTracker({ issues: [issue({ id: "7", title: "Api blocked" }), issue({ id: "8", title: "Api ready", labels: ["sous:ready"] })] }));
    const { deps: d, out } = deps(home);

    expect(await statusCommand([], d)).toBe(0);

    expect(out.join("\n")).toBe(
      [
        "home repository, 3 entries: api, web, gone",
        "engine 0.9.1",
        `  api   tracker local ${join(api, "issues")}, shared: false`,
        `  web   tracker local ${join(web, "issues")}, shared: false`,
        `  gone  set aside: ${join(dir, "gone")} holds no .sous/sous.yaml; sous watch starts nothing there`,
        "daemon: none",
        "ui: not running (sous ui)",
        "",
        "entry  issue  title            state        step       since",
        "web    1      Running one      running      build      48m00s",
        "api    7      Api blocked      blocked      review     35m00s",
        "web    2      Blocked one      blocked      review     40m00s",
        "web    3      Crashed one      crashed      build      30m00s",
        "web    4      Interrupted one  interrupted  implement  20m00s",
        "api    8      Api ready        ready        -          -",
        "web    9      Ready one        ready        -          -",
        "2 done, see sous ui",
      ].join("\n"),
    );

    const json = deps(home);
    expect(await statusCommand(["--json"], json.deps)).toBe(0);
    const overview = JSON.parse(json.out[0]!) as { mode: string; entries: { name: string; path: string; tracker: unknown; unrunnable: string | null; done: number }[] };
    expect(overview.mode).toBe("home");
    expect(overview.entries.map(({ name, path, tracker, done }) => ({ name, path, tracker: tracker !== null, done }))).toEqual([
      { name: "api", path: join(dir, "api"), tracker: true, done: 0 },
      { name: "web", path: join(dir, "web"), tracker: true, done: 2 },
      { name: "gone", path: join(dir, "gone"), tracker: false, done: 0 },
    ]);
  });
  it("shows a live lock without a session as running with - step and since", async () => {
    const root = await repository("web");
    await lock(root, "8.lock", LIVE, "8");
    const { deps: d, out } = deps(root);

    expect(await statusCommand([], d)).toBe(0);

    expect(out.join("\n").split("\n").slice(-2)).toEqual(["issue  title  state    step  since", "8      -      running  -     -"]);
  });

  it("shows since as - for a live lock whose run has not written run.start yet, never the previous run's start", async () => {
    const root = await repository("web");
    // The previous run ended; the new one holds the lock but has written nothing yet.
    await run(root, "7", "review", [start("r1", iso(0), LIVE), open("r1", "s1", iso(5), "review"), end("r1", iso(20), "blocked")], true);
    await lock(root, "7.lock", LIVE, "7");
    // The previous run crashed without run.end; the new one, another pid, has written nothing yet.
    await run(root, "8", "build", [start("r1", iso(0), 7), open("r1", "s1", iso(5), "build")]);
    await lock(root, "8.lock", LIVE, "8");
    const { deps: d, out } = deps(root);

    expect(await statusCommand(["--json"], d)).toBe(0);

    const overview = JSON.parse(out[0]!) as { entries: { runs: { issue: string; state: string; since: string | null }[] }[] };
    expect(overview.entries[0]!.runs.map(({ issue, state, since }) => ({ issue, state, since }))).toEqual([
      { issue: "7", state: "running", since: null },
      { issue: "8", state: "running", since: null },
    ]);
  });

  it("names an unreadable watch lock as stale without a pid", async () => {
    const root = await repository("web");
    await mkdir(join(root, "locks"), { recursive: true });
    await writeFile(join(root, "locks", "watch.pid"), "not json");
    const text = deps(root);
    expect(await statusCommand([], text.deps)).toBe(0);
    expect(text.out.join("\n")).toContain("\ndaemon: none (stale locks/watch.pid, unreadable)\n");

    const json = deps(root);
    expect(await statusCommand(["--json"], json.deps)).toBe(0);
    expect((JSON.parse(json.out[0]!) as { daemon: unknown }).daemon).toEqual({ running: false, pid: null, since: null, stale: true });
  });

  it("drops only the title a getIssue failed for to -, keeps the other titles and the ready rows, and notes it", async () => {
    const root = await fixtureRepo();
    const flaky = trackers.get("web")!;
    const getIssue = flaky.getIssue.bind(flaky);
    flaky.getIssue = async (id) => {
      if (id === "3") throw new Error("gh: rate limited");
      return getIssue(id);
    };
    const { deps: d, out } = deps(root);

    expect(await statusCommand([], d)).toBe(0);

    expect(out.join("\n").split("\n").slice(6)).toEqual([
      "issue  title            state        step       since",
      "1      Running one      running      build      48m00s",
      "2      Blocked one      blocked      review     40m00s",
      "3      -                crashed      build      30m00s",
      "4      Interrupted one  interrupted  implement  20m00s",
      "9      Ready one        ready        -          -",
      "2 done, see sous ui",
      `tracker ${join(root, "issues")} did not answer for some issues; their titles not shown`,
    ]);
  });

  it("leaves the title - and sets no note when the tracker holds no such issue", async () => {
    const root = await fixtureRepo();
    trackers.get("web")!.issues.delete("3");
    const { deps: d, out } = deps(root);

    expect(await statusCommand([], d)).toBe(0);

    const lines = out.join("\n").split("\n");
    expect(lines).toContain("3      -                crashed      build      30m00s");
    expect(lines.at(-1)).toBe("2 done, see sous ui");
  });

  it("shows an issue handed back with <labels>:ready after a block, crash or interrupt as one ready row with its session's branch and worktree", async () => {
    const root = await fixtureRepo();
    const tracker = trackers.get("web")!;
    for (const id of ["1", "2", "3", "4"]) tracker.issues.set(id, { ...tracker.issues.get(id)!, labels: ["sous:ready"] });
    const text = deps(root);

    expect(await statusCommand([], text.deps)).toBe(0);

    expect(text.out.join("\n").split("\n").slice(6)).toEqual([
      "issue  title            state    step   since",
      "1      Running one      running  build  48m00s",
      "2      Blocked one      ready    -      -",
      "3      Crashed one      ready    -      -",
      "4      Interrupted one  ready    -      -",
      "9      Ready one        ready    -      -",
      "2 done, see sous ui",
    ]);

    const json = deps(root);
    expect(await statusCommand(["--json"], json.deps)).toBe(0);
    const entry = (JSON.parse(json.out[0]!) as { entries: { runs: { issue: string }[]; ready: unknown[] }[] }).entries[0]!;
    expect(entry.runs.map((r) => r.issue)).toEqual(["1"]);
    const worktree = (id: string) => join(dir, "web", ".sous", "worktrees", `task-${id}-x`);
    expect(entry.ready).toEqual([
      { issue: "2", title: "Blocked one", branch: "task/2-x", worktree: worktree("2") },
      { issue: "3", title: "Crashed one", branch: "task/3-x", worktree: worktree("3") },
      { issue: "4", title: "Interrupted one", branch: "task/4-x", worktree: worktree("4") },
      { issue: "9", title: "Ready one", branch: null, worktree: null },
    ]);
  });

  it("notes a tracker module whose factory throws in a single repository, lists its runs with - titles and exits 0", async () => {
    const root = await repository("web");
    await writeFile(join(root, "sous.yaml"), `engine: ^0.9.0\nname: web\ntracker: { type: ./boom.mjs, shared: false, labels: sous }\n`);
    await writeFile(join(root, "boom.mjs"), `export default () => { throw new Error("no token"); };\n`);
    await run(root, "2", "review", [start("r1", iso(0)), end("r1", iso(20), "blocked")], true);
    const { deps: d, out, err } = deps(root);

    expect(await statusCommand([], d)).toBe(0);

    expect(err).toEqual([]);
    expect(out.join("\n").split("\n").slice(-3)).toEqual([
      "issue  title  state    step    since",
      "2      -      blocked  review  40m00s",
      "tracker of web not built: no token; ready issues not shown",
    ]);
  });

  it("prints the other entries of a home and a note for an entry whose tracker module throws or whose sous.yaml does not load, and exits 0", async () => {
    const home = await repository("home", "repos: { api: ../api, web: ../web, bad: ../bad }\n");
    const api = await repository("api");
    await writeFile(join(api, "sous.yaml"), `engine: ^0.9.0\nname: api\ntracker: { type: ./boom.mjs, shared: false, labels: sous }\n`);
    await writeFile(join(api, "boom.mjs"), `export default () => { throw new Error("no token"); };\n`);
    await run(api, "7", "review", [start("r1", iso(0)), end("r1", iso(25), "blocked")], true);
    const bad = await repository("bad", "uiPort: nope\n");
    await run(bad, "8", "review", [start("r1", iso(0)), end("r1", iso(25), "blocked")], true);
    const web = await fixtureRepo();
    const { deps: d, out, err } = deps(home);

    expect(await statusCommand([], d)).toBe(0);

    expect(err).toEqual([]);
    const lines = out.join("\n").split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "home repository, 3 entries: api, web, bad",
      "engine 0.9.1",
      `  api  tracker ${join(api, "boom.mjs")} {}, shared: false`,
      `  web  tracker local ${join(web, "issues")}, shared: false`,
      "  bad  tracker not built",
    ]);
    expect(lines).toContain("api    7      -                blocked      review     35m00s");
    expect(lines).toContain("web    9      Ready one        ready        -          -");
    expect(lines.some((l) => l.startsWith("bad "))).toBe(false);
    expect(lines.slice(-2)).toEqual([
      "tracker of api not built: no token; ready issues not shown",
      expect.stringMatching(/^tracker of bad not built: .*uiPort.*; ready issues not shown$/),
    ]);
  });
});
