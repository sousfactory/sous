import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileEventLog } from "../../src/adapters/eventlog.js";
import { formatDuration, laneName, renderStatus, statusCommand, type StatusPaths } from "../../src/commands/status.js";
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
    run("r2", at(11, 0, 0), { resumedFrom: { step: "review", iteration: 0 } }),
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
        "  run r2  11:00:00  blocked  (idle 1h54m)  resumed at review",
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

  it("reads the run folder under the settings' runsDir and renders session and timeline", async () => {
    await writeFile(join(root, "sous.yaml"), "runsDir: ../state/runs\n");
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

  it("exits 2 on a missing, invalid or extra argument", async () => {
    const { deps, err } = io();
    expect(await statusCommand([], deps)).toBe(2);
    expect(await statusCommand(["#"], deps)).toBe(2);
    expect(await statusCommand(["1", "2"], deps)).toBe(2);
    expect(err).toEqual(["usage: sous status <issue>", "usage: sous status <issue>", "usage: sous status <issue>"]);
  });
});
