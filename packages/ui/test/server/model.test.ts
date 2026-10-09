import { foldTimeline } from "sous-factory/read";
import { describe, expect, it } from "vitest";
import { deriveFlow, deriveRun, type RunView } from "../../server/model";
import type { Topology } from "sous-factory/read";
import { at, Log, record, session, taskTopology } from "../fixtures";

const statuses = (view: RunView) => Object.fromEntries(view.nodes.map((n) => [n.id, n.status]));

const derive = (log: Log, live: boolean, extra: Partial<Parameters<typeof deriveRun>[0]> = {}) =>
  deriveRun({ session: session(), timeline: foldTimeline(log.events), topology: taskTopology, live, ...extra });

describe("deriveRun: node status", () => {
  it("a finished run: visited steps succeed, unvisited ones are skipped", () => {
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "implement").visit("implement", 1, 5, true, "review").visit("review", 5, 6, true, "merge").visit("merge", 6, 7, true, "done").end(7, "done");
    const view = derive(log, false);
    expect(statuses(view)).toEqual({ init: "success", implement: "success", review: "success", fix: "skipped", merge: "success" });
    expect(view.summary).toMatchObject({ status: "success", outcome: "done", live: false, attempts: 1, runId: "r1", startedAt: at(0), endedAt: at(7) });
  });

  it("a live run: the open step is in progress and the steps ahead are queued", () => {
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "implement").visit("implement", 1, undefined);
    const view = derive(log, true);
    expect(statuses(view)).toEqual({ init: "success", implement: "in_progress", review: "queued", fix: "queued", merge: "queued" });
    expect(view.summary).toMatchObject({ status: "in_progress", outcome: "running", live: true });
  });

  it("a run without an end whose process is gone: the open step failed and the run reads stale", () => {
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "implement").visit("implement", 1, undefined);
    const view = derive(log, false);
    expect(statuses(view)).toMatchObject({ implement: "failure", review: "skipped" });
    expect(view.summary).toMatchObject({ status: "failure", outcome: "stale", live: false });
  });

  it("an interrupted run: the open step and the run are cancelled", () => {
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "implement").visit("implement", 1, undefined).end(3, "interrupted");
    const view = derive(log, false);
    expect(statuses(view)["implement"]).toBe("cancelled");
    expect(view.summary).toMatchObject({ status: "cancelled", outcome: "interrupted" });
  });

  it("a crashed run: the open step failed, and its visit and the summary carry the error", () => {
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "merge").visit("merge", 1, undefined).end(2, "crashed", "merge: refusing to merge");
    const view = derive(log, false);
    expect(statuses(view)).toMatchObject({ init: "success", merge: "failure" });
    expect(view.summary).toMatchObject({ status: "failure", outcome: "crashed", crash: { error: "merge: refusing to merge", step: "merge" } });
    expect(view.details["merge"]?.visits[0]?.error).toBe("merge: refusing to merge");
    expect(view.details["init"]?.visits[0]).not.toHaveProperty("error");
  });

  it("a crash recorded without an error has no crash box", () => {
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "implement").visit("implement", 1, undefined).end(2, "crashed");
    expect(derive(log, false).summary).not.toHaveProperty("crash");
  });

  it("a blocked run: the step that routed to blocked failed and the run failed", () => {
    const log = new Log()
      .start("r1", 0)
      .visit("init", 0, 1, true, "implement")
      .visit("implement", 1, 2, true, "review")
      .visit("review", 2, 3, false, "fix")
      .visit("fix", 3, 4, true, "review")
      .visit("review", 4, 5, false, "blocked")
      .end(5, "blocked");
    const view = derive(log, false, { session: session({ blocked: true, current: "review" }) });
    expect(statuses(view)).toMatchObject({ review: "failure", fix: "success", merge: "skipped" });
    expect(view.summary).toMatchObject({ status: "failure", outcome: "blocked" });
  });

  it("the latest visit decides the colour and visits are counted", () => {
    const log = new Log()
      .start("r1", 0)
      .visit("review", 2, 3, false, "fix")
      .visit("fix", 3, 4, true, "review")
      .visit("review", 4, 5, false, "fix")
      .visit("fix", 5, 6, true, "review")
      .visit("review", 6, 7, true, "merge");
    const review = derive(log, true).nodes.find((n) => n.id === "review");
    expect(review).toMatchObject({ status: "success", visits: 3, startedAt: at(6), endedAt: at(7) });
  });

  it("without any event the session's own state decides", () => {
    const view = deriveRun({ session: session({ current: "done" }), timeline: { runs: [], spans: [] }, topology: taskTopology, live: false });
    expect(view.summary).toMatchObject({ status: "success", outcome: "done", attempts: 0 });
    expect(statuses(view)["init"]).toBe("skipped");
  });
});

describe("deriveRun: edges", () => {
  it("drops terminal and exhausted edges and marks the routes taken", () => {
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "implement").visit("implement", 1, 2, true, "review").visit("review", 2, 3, false, "fix").visit("fix", 3, 4, true, "review");
    expect(derive(log, true).edges).toEqual([
      { from: "init", to: "implement", taken: true },
      { from: "implement", to: "review", taken: true },
      { from: "review", to: "merge", taken: false },
      { from: "review", to: "fix", taken: true },
      { from: "fix", to: "review", taken: true },
    ]);
  });
});

describe("deriveRun: attempts", () => {
  const log = new Log()
    .start("r1", 0)
    .visit("init", 0, 1, true, "implement")
    .visit("implement", 1, undefined)
    .start("r2", 10, { resumedFrom: { step: "implement", iteration: 1 } })
    .visit("implement", 10, 12, true, "review")
    .visit("review", 12, undefined);

  it("defaults to the latest attempt and carries the earlier visits over", () => {
    const view = derive(log, true, { session: session({ scopes: { "84": { implement: record({ log: "built" }) } } }) });
    expect(view.attempt).toBe(2);
    expect(statuses(view)).toMatchObject({ init: "success", implement: "success", review: "in_progress", merge: "queued" });
    expect(view.attemptList.map((a) => [a.n, a.runId, a.outcome])).toEqual([
      [1, "r1", "crashed"],
      [2, "r2", "running"],
    ]);
    expect(view.attemptList[1]?.resumedFrom).toEqual({ step: "implement", iteration: 1 });
    expect(view.details["implement"]?.record?.log).toBe("built");
  });

  it("an earlier attempt shows only its own segments, its outcome, and no session record", () => {
    const view = derive(log, true, { attempt: 1, session: session({ scopes: { "84": { implement: record() } } }) });
    expect(view.attempt).toBe(1);
    expect(view.summary).toMatchObject({ outcome: "crashed", status: "failure", runId: "r1" });
    expect(statuses(view)).toMatchObject({ init: "success", implement: "failure", review: "skipped" });
    expect(view.details["implement"]?.record).toBeUndefined();
  });

  it("an attempt out of range falls back to the latest", () => {
    expect(derive(log, true, { attempt: 9 }).attempt).toBe(2);
  });
});

describe("deriveRun: work items", () => {
  // Feature run on issue 50: init in the issue's scope, then implement for sub-issue 51 (done) and 52 (running).
  const log = new Log()
    .start("r1", 0)
    .visit("init", 0, 1, true, "implement", "50", false, "50")
    .visit("implement", 1, 2, true, "review", "51")
    .visit("review", 2, 3, true, "merge", "51")
    .visit("implement", 4, undefined, true, "x", "52");
  const s = session({ issue: "50", work: "52", workProgress: { "50": { state: "open", commits: [] }, "51": { state: "done", commits: ["c1"] }, "52": { state: "open", commits: [] } } });

  it("lists the work items and selects the current one", () => {
    const view = derive(log, true, { session: s });
    expect(view.scope).toBe("52");
    expect(view.work).toEqual([
      { key: "50", id: "50", isIssue: true, state: "open", current: false },
      { key: "51", id: "51", isIssue: false, state: "done", current: false },
      { key: "52", id: "52", isIssue: false, state: "open", current: true },
    ]);
  });

  it("per-work steps show the selected item's visits; shared steps keep theirs", () => {
    expect(statuses(derive(log, true, { session: s }))).toMatchObject({ init: "success", implement: "in_progress", review: "queued" });
    expect(statuses(derive(log, true, { session: s, scope: "51" }))).toMatchObject({ init: "success", implement: "success", review: "success" });
  });
});

describe("deriveRun: lanes of a feature run", () => {
  // The span trail of run #89: next-work picks 90 and 91, sync puts the issue back on the bench.
  const trail: [step: string, scope: string, next: string, scopeAfter: string][] = [
    ["init", "89", "next-work", "89"],
    ["next-work", "89", "implement", "90"],
    ["implement", "90", "review", "90"],
    ["review", "90", "close-work", "90"],
    ["close-work", "90", "next-work", "90"],
    ["next-work", "90", "implement", "91"],
    ["implement", "91", "review", "91"],
    ["review", "91", "close-work", "91"],
    ["close-work", "91", "next-work", "91"],
    ["next-work", "91", "sync", "91"],
    ["sync", "91", "review-full", "89"],
    ["review-full", "89", "merge", "89"],
    ["merge", "89", "done", "89"],
  ];
  /** The first `count` visits closed; `withScopeAfter: false` is a log written before span.close carried it. */
  const logOf = (count: number, withScopeAfter = true, end = false): Log => {
    const log = new Log().start("r1", 0, { flow: "feature" });
    trail.slice(0, count).forEach(([step, scope, next, after], i) => log.visit(step, i, i + 1, true, next, scope, false, withScopeAfter ? after : undefined));
    return end ? log.end(count, "done") : log;
  };
  const ids = ["init", "next-work", "implement", "review", "fix", "close-work", "sync", "verify", "review-full", "fix-review-full", "merge"];
  const featureTopology: Topology = {
    entry: "init",
    nodes: ids.map((id) => ({ id, uses: id })),
    edges: [
      { from: "init", to: "next-work" },
      { from: "next-work", to: "implement" },
      { from: "next-work", to: "sync" },
      { from: "implement", to: "review" },
      { from: "review", to: "close-work" },
      { from: "review", to: "fix" },
      { from: "fix", to: "review" },
      { from: "close-work", to: "next-work" },
      { from: "sync", to: "verify" },
      { from: "sync", to: "review-full" },
      { from: "verify", to: "review-full" },
      { from: "review-full", to: "merge" },
      { from: "review-full", to: "fix-review-full" },
      { from: "fix-review-full", to: "review-full" },
      { from: "merge", to: "done" },
    ],
  };
  const progress = { "89": { state: "open" as const, commits: [] }, "90": { state: "done" as const, commits: ["c1"] }, "91": { state: "done" as const, commits: ["c2"] } };
  const view = (log: Log, live: boolean, scope: string, work = "89") =>
    deriveRun({ session: session({ issue: "89", flow: "feature", work, current: live ? "merge" : "done", workProgress: progress }), timeline: foldTimeline(log.events), topology: featureTopology, live, scope });

  for (const withScopeAfter of [true, false]) {
    describe(withScopeAfter ? "with scopeAfter on span.close" : "an older log without scopeAfter", () => {
      it("an ended run: the issue's lane carries init, next-work and the full-branch steps; sub-issue lanes their own work", () => {
        const log = logOf(trail.length, withScopeAfter, true);
        expect(statuses(view(log, false, "89"))).toEqual({
          init: "success", "next-work": "success", implement: "skipped", review: "skipped", fix: "skipped", "close-work": "skipped",
          sync: "success", verify: "skipped", "review-full": "success", "fix-review-full": "skipped", merge: "success",
        });
        for (const sub of ["90", "91"]) {
          expect(statuses(view(log, false, sub))).toEqual({
            init: "success", "next-work": "success", implement: "success", review: "success", fix: "skipped", "close-work": "success",
            sync: "skipped", verify: "skipped", "review-full": "skipped", "fix-review-full": "skipped", merge: "skipped",
          });
        }
        expect(view(log, false, "89").nodes.find((n) => n.id === "next-work")?.visits).toBe(3);
        expect(view(log, false, "90").nodes.find((n) => n.id === "next-work")?.visits).toBe(1);
        expect(view(log, false, "91").nodes.find((n) => n.id === "next-work")?.visits).toBe(2);
      });

      it("a live run: next-work keeps its status after its second visit, and steps ahead are queued in every lane", () => {
        // Seven visits closed, review of 91 open: next-work ran in 89 (picking 90) and in 90 (picking 91).
        const log = logOf(6, withScopeAfter).visit("implement", 6, undefined, true, "x", "91");
        const s = (scope: string) => statuses(view(log, true, scope, "91"));
        expect(s("89")).toMatchObject({ init: "success", "next-work": "success", implement: "queued", sync: "queued", "review-full": "queued", merge: "queued" });
        expect(s("90")).toMatchObject({ init: "success", "next-work": "success", implement: "success", "close-work": "success", sync: "queued", merge: "queued" });
        expect(s("91")).toMatchObject({ init: "success", "next-work": "success", implement: "in_progress", review: "queued", "close-work": "queued", "review-full": "queued", merge: "queued" });
      });

      it("a live run at merge: review-full and merge are not drawn in the sub-issue lanes", () => {
        const log = logOf(12, withScopeAfter).visit("merge", 12, undefined, true, "x", "89");
        expect(statuses(view(log, true, "89"))).toMatchObject({ sync: "success", "review-full": "success", merge: "in_progress", "next-work": "success" });
        for (const sub of ["90", "91"]) expect(statuses(view(log, true, sub))).toMatchObject({ sync: "queued", "review-full": "queued", merge: "queued" });
      });
    });
  }

  it("marks a route taken only where its target was visited in the same lane", () => {
    const log = logOf(trail.length, true, true);
    const taken = (scope: string) => view(log, false, scope).edges.filter((e) => e.taken).map((e) => `${e.from}>${e.to}`);
    expect(taken("89")).toEqual(["init>next-work", "next-work>sync", "sync>review-full", "review-full>merge"]);
    expect(taken("90")).toEqual(["init>next-work", "next-work>implement", "implement>review", "review>close-work", "close-work>next-work"]);
  });
});

describe("deriveRun: flow drift", () => {
  it("a visited step missing from the flow file becomes an unknown node", () => {
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "build").visit("build", 1, 2, true, "merge");
    const build = derive(log, false).nodes.find((n) => n.id === "build");
    expect(build).toMatchObject({ status: "success", unknown: true, visits: 1 });
  });

  it("an unreadable flow keeps the visited steps and reports the error", () => {
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "implement");
    const view = derive(log, false, { topology: { error: "task.yaml: invalid YAML" } });
    expect(view.flowError).toBe("task.yaml: invalid YAML");
    expect(view.nodes.map((n) => n.id)).toEqual(["init"]);
    expect(view.edges).toEqual([]);
  });
});

describe("deriveRun: details", () => {
  it("lists routes with full conditions, visits with iterations and the agent log name", () => {
    const log = new Log().start("r1", 0).visit("review", 0, 3, true, "merge", "84", true);
    const detail = derive(log, false).details["review"];
    expect(detail?.routes).toEqual([
      { to: "merge", when: "res.ok" },
      { to: "blocked", when: "steps.review.visits >= 3" },
      { to: "fix" },
      { to: "blocked", exhausted: true },
    ]);
    expect(detail?.visits).toHaveLength(1);
    expect(detail?.visits[0]).toMatchObject({ status: "success", next: "merge", startedAt: at(0), endedAt: at(3) });
    expect(detail?.visits[0]?.iterations[0]?.agent).toMatchObject({ log: "r1-1-84-review-1.log", outcome: "ok" });
  });

  it("names the log an agent is still writing after the path its start event recorded", () => {
    const log = new Log().start("r1", 0).visit("implement", 0, undefined, true, "x", "84", true);
    expect(derive(log, true).details["implement"]?.visits[0]?.iterations[0]?.agent?.log).toBe("r1-1-84-implement-1.log");
  });

  it("gives each work item's and each re-visit's agent call its own log", () => {
    const log = new Log()
      .start("r1", 0)
      .visit("implement", 0, 1, true, "review", "90", true)
      .visit("review", 1, 2, false, "fix", "90", true)
      .visit("fix", 2, 3, true, "review", "90", true)
      .visit("review", 3, 4, true, "implement", "90", true, "90")
      .visit("implement", 4, 5, true, "review", "91", true);
    const logs = (scope: string, step: string) => derive(log, false, { scope }).details[step]?.visits.map((v) => v.iterations[0]?.agent?.log);
    expect(logs("90", "implement")).toEqual(["r1-1-90-implement-1.log"]);
    expect(logs("91", "implement")).toEqual(["r1-5-91-implement-1.log"]);
    expect(logs("90", "review")).toEqual(["r1-2-90-review-1.log", "r1-4-90-review-1.log"]);
  });

  it("renders a run written before span-scoped log names: the recorded flat names, the step and iteration while unrecorded", () => {
    const log = new Log().start("r1", 0);
    log.events.push(
      { type: "span.open", at: at(0), runId: "r1", spanId: "r1-1", step: "implement", scope: "84" },
      { type: "iteration.agent.start", at: at(0), spanId: "r1-1", n: 1, kind: "claude", model: "m" },
      { type: "iteration.agent.end", at: at(1), spanId: "r1-1", n: 1, outcome: "invalid-output", commits: [], logPath: "/x/logs/84/implement-1.2.log" },
      { type: "iteration.agent.start", at: at(1), spanId: "r1-1", n: 2, kind: "claude", model: "m" },
      { type: "iteration.agent.end", at: at(2), spanId: "r1-1", n: 2, outcome: "ok", commits: [], logPath: "/x/logs/84/implement-2.log" },
      { type: "span.close", at: at(2), spanId: "r1-1", ok: true, next: "review" },
      { type: "span.open", at: at(2), runId: "r1", spanId: "r1-2", step: "review", scope: "84" },
      { type: "iteration.agent.start", at: at(2), spanId: "r1-2", n: 1, kind: "codex", model: "m" },
    );
    const details = derive(log, true).details;
    expect(details["implement"]?.visits[0]?.iterations.map((it) => it.agent?.log)).toEqual(["implement-1.2.log", "implement-2.log"]);
    expect(details["review"]?.visits[0]?.iterations[0]?.agent?.log).toBe("review-1.log");
  });
});

describe("deriveRun: the running phase of an in-progress step", () => {
  // init a module, implement a prompt with an eval gate, review eval-only.
  const kinds: Topology = {
    ...taskTopology,
    nodes: taskTopology.nodes.map((n) =>
      n.id === "init" ? { ...n, kind: "module" as const, evalGate: true as const } : n.id === "implement" ? { ...n, kind: "prompt" as const, evalGate: true as const } : n.id === "review" ? { ...n, kind: "eval" as const } : n,
    ),
  };
  const phases = (log: Log, live = true) =>
    Object.fromEntries(deriveRun({ session: session(), timeline: foldTimeline(log.events), topology: kinds, live }).nodes.map((n) => [n.id, n.phase]));
  const evalStart = (log: Log, spanId: string, minute: number) => log.events.push({ type: "iteration.eval.start", at: at(minute), spanId, n: 1 });
  const evalEnd = (log: Log, spanId: string, minute: number) => log.events.push({ type: "iteration.eval.end", at: at(minute), spanId, n: 1, ok: true });
  const agentEnd = (log: Log, spanId: string, minute: number) => log.events.push({ type: "iteration.agent.end", at: at(minute), spanId, n: 1, outcome: "ok", commits: [] });

  it("a prompt step is in its work while the agent call is open, then in nothing, then in its eval until the eval ends", () => {
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "implement").visit("implement", 1, undefined, true, "x", "84", true);
    expect(phases(log)).toEqual({ init: undefined, implement: "work", review: undefined, fix: undefined, merge: undefined });
    agentEnd(log, "r1-2", 3);
    expect(phases(log).implement).toBeUndefined();
    evalStart(log, "r1-2", 3);
    expect(phases(log).implement).toBe("eval");
    evalEnd(log, "r1-2", 4);
    expect(phases(log).implement).toBeUndefined();
  });

  it("a module step is in its work until its eval starts", () => {
    const log = new Log().start("r1", 0).visit("init", 0, undefined);
    expect(phases(log).init).toBe("work");
    evalStart(log, "r1-1", 1);
    expect(phases(log).init).toBe("eval");
  });

  it("an eval-only step is in its eval only while eval() runs", () => {
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "review").visit("review", 1, undefined);
    expect(phases(log).review).toBeUndefined();
    evalStart(log, "r1-2", 2);
    expect(phases(log).review).toBe("eval");
    evalEnd(log, "r1-2", 3);
    expect(phases(log).review).toBeUndefined();
  });

  it("a step with a prepare is in its prepare until prepare returns, then in its work once the agent starts", () => {
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "implement").visit("implement", 1, undefined);
    log.events.push({ type: "prepare.start", at: at(1), spanId: "r1-2" });
    expect(phases(log).implement).toBe("prepare");
    log.events.push({ type: "prepare.end", at: at(2), spanId: "r1-2", agent: "run" });
    expect(phases(log).implement).toBeUndefined();
    log.events.push({ type: "iteration.agent.start", at: at(2), spanId: "r1-2", n: 1, kind: "claude", model: "m" });
    expect(phases(log).implement).toBe("work");
  });

  it("marks a step whose latest visit's prepare skipped the agent, and keeps the prepare on the visit", () => {
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "implement").visit("implement", 1, undefined);
    log.events.push({ type: "prepare.start", at: at(1), spanId: "r1-2" }, { type: "prepare.end", at: at(2), spanId: "r1-2", agent: "skip", reason: "nothing came in" });
    const view = deriveRun({ session: session(), timeline: foldTimeline(log.events), topology: kinds, live: true });
    expect(view.nodes.find((n) => n.id === "implement")?.agentSkipped).toEqual({ reason: "nothing came in" });
    expect(view.nodes.find((n) => n.id === "init")).not.toHaveProperty("agentSkipped");
    expect(view.details["implement"]?.visits[0]?.prepare).toEqual({ startedAt: at(1), endedAt: at(2), agent: "skip", reason: "nothing came in" });
  });

  it("a step that is not in progress has no phase: a cancelled visit with an open agent call", () => {
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "implement").visit("implement", 1, undefined, true, "x", "84", true);
    expect(phases(log, false).implement).toBeUndefined();
  });
});

describe("deriveFlow", () => {
  it("draws the flow file alone: every step queued with its shape, no route taken, terminal routes only in the details", () => {
    const view = deriveFlow("task", { ...taskTopology, nodes: taskTopology.nodes.map((n) => (n.id === "review" ? { ...n, kind: "prompt" as const, evalGate: true as const, description: "Judge the diff" } : n)) });
    expect(view.entry).toBe("init");
    expect(view.nodes.every((n) => n.status === "queued" && n.visits === 0)).toBe(true);
    expect(view.nodes.find((n) => n.id === "review")).toMatchObject({ uses: "review", kind: "prompt", evalGate: true, agent: { kind: "codex", model: "gpt-5.5" } });
    expect(view.edges.every((e) => !e.taken)).toBe(true);
    expect(view.edges.some((e) => e.to === "blocked" || e.to === "done")).toBe(false);
    expect(view.details["review"]).toMatchObject({ uses: "review", description: "Judge the diff" });
    expect(view.details["review"]?.routes.map((r) => r.to)).toEqual(taskTopology.edges.filter((e) => e.from === "review").map((e) => e.to));
  });

  it("carries the error of a flow file that does not load, and draws nothing", () => {
    expect(deriveFlow("task", { error: "bad yaml" })).toEqual({ name: "task", nodes: [], edges: [], details: {}, error: "bad yaml" });
  });
});
