import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileEventLog } from "../../src/adapters/eventlog.js";
import { worktreePathFor, type OpenSandbox, type OpenSandboxOptions } from "../../src/adapters/sandcastle.js";
import { lockPath } from "../../src/commands/lock.js";
import { existingSpecDirName, onProcessSignal, parseRunArgs, runCommand, type RunDeps, type SignalHandler, type StopSignal } from "../../src/commands/run.js";
import { AgentProcessError } from "../../src/exec/errors.js";
import { recordVisit, type Session } from "../../src/exec/scope.js";
import type { Event } from "../../src/session/events.js";
import { eventsFile, runDir, sessionFile } from "../../src/session/paths.js";
import { loadSession, saveSession } from "../../src/session/store.js";
import { foldTimeline } from "../../src/session/timeline.js";
import { createSession, setWork } from "../../src/session/update.js";
import { answer, execRoot, fakeClock } from "../fakes/executor.js";
import { fakeGit, type FakeGit } from "../fakes/git.js";
import { fakeTracker, issue, type FakeTracker } from "../fakes/tracker.js";
import { fakeSandbox, untilAborted, type AgentScript, type FakeSandbox } from "../fakes/sandbox.js";

describe("parseRunArgs", () => {
  it("accepts flow, issue and --restart in any order", () => {
    expect(parseRunArgs(["task", "12"])).toEqual({ flow: "task", issue: "12", restart: false });
    expect(parseRunArgs(["--restart", "feature", "3"])).toEqual({ flow: "feature", issue: "3", restart: true });
  });

  it("keeps anything that is not a run number as a tracker reference for the adapter to resolve", () => {
    expect(parseRunArgs(["task", "proj-a.1"])).toEqual({ flow: "task", issue: "proj-a.1", restart: false });
    expect(parseRunArgs(["task", "1.5"])).toEqual({ flow: "task", issue: "1.5", restart: false });
  });

  it("rejects missing or invalid arguments and unknown options", () => {
    for (const args of [[], ["task"], ["task", "#"], ["task", "007x", "extra"], ["task", "1", "extra"]]) {
      expect(parseRunArgs(args)).toEqual({ error: "usage: sous run <flow> <issue> [--restart]" });
    }
    expect(parseRunArgs(["task", "1", "--force"])).toMatchObject({ error: expect.stringContaining("unknown option --force") });
  });
});

describe("existingSpecDirName", () => {
  it("prefers the planned spec folder on main, by prefix", () => {
    expect(existingSpecDirName(["1-other", "12-planned-name", "120-no"], "12")).toBe("12-planned-name");
    expect(existingSpecDirName(["1-other"], "12")).toBeUndefined();
  });
});

describe("runCommand", () => {
  const BRANCH = "feature/7-cap-asset-slug-length";
  let repoRoot: string;
  let root: string;
  let worktree: string;
  let git: FakeGit;
  let tracker: FakeTracker;
  let sandbox: FakeSandbox | undefined;
  /** What the next opened sandbox's agent answers; a full walk by default. */
  let agent: AgentScript[];
  let opened: OpenSandboxOptions[];
  let out: string[];
  let err: string[];
  let confirmed: boolean;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "sous-run-"));
    root = join(repoRoot, ".sous");
    await cp(execRoot, root, { recursive: true });
    // As the workspace root: without it tsx would load the copied step modules as CommonJS.
    await writeFile(join(repoRoot, "package.json"), '{ "type": "module" }\n');
    worktree = join(repoRoot, "wt");
    git = fakeGit();
    tracker = fakeTracker({ issues: [issue({ id: "7", title: "Cap asset slug length", labels: ["type:task"] })] });
    sandbox = undefined;
    agent = [answer("w1")];
    opened = [];
    out = [];
    err = [];
    confirmed = true;
  });
  afterEach(() => rm(repoRoot, { recursive: true, force: true }));

  /** Like sandcastle: creates the branch when missing, reuses it otherwise. */
  const openSandbox: OpenSandbox = async (options) => {
    opened.push(options);
    git.existing.add(options.branch);
    sandbox = fakeSandbox({ worktreePath: worktree, branch: options.branch, agent, ...(options.signal !== undefined ? { signal: options.signal } : {}) });
    return sandbox;
  };

  const deps = (overrides: Partial<RunDeps> = {}): RunDeps => ({
    root,
    repoRoot,
    git,
    tracker,
    openSandbox,
    confirm: async () => confirmed,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    clock: fakeClock(),
    pid: 4242,
    isAlive: () => false,
    host: "box",
    sha: async () => "abc1234",
    newId: () => "r1",
    ...overrides,
  });

  const runs = () => join(repoRoot, ".sous", "runs");
  const lockExists = () =>
    stat(lockPath(root)).then(
      () => true,
      () => false,
    );
  const savedSession = async (): Promise<Session> => {
    const session = await loadSession(sessionFile(runs(), "7"));
    if (session === undefined) throw new Error("no session saved");
    return session;
  };
  const savedEvents = (): Promise<Event[]> => createFileEventLog(eventsFile(runs(), "7")).readAll();

  it("takes the issue id as the tracker spells it, and drops a leading #", async () => {
    tracker.issues.set("proj-a.1", issue({ id: "proj-a.1", ref: "proj-a.1", title: "A bead", labels: ["type:task"] }));
    expect(await runCommand(["walk", "proj-a.1"], deps())).toBe(0);
    expect(out[0]).toBe(`starting proj-a.1 at start in ${worktree}`);
    expect(await loadSession(sessionFile(runs(), "proj-a.1"))).toMatchObject({ issue: "proj-a.1", work: "proj-a.1" });
    out.length = 0;
    expect(await runCommand(["walk", "#7"], deps())).toBe(0);
    expect(out[0]).toBe(`starting #7 at start in ${worktree}`);
  });

  it("walks the flow end to end: validate, lock, sandbox, run record outside git, exit 0", async () => {
    expect(await runCommand(["walk", "7"], deps())).toBe(0);

    expect(err).toEqual([]);
    expect(opened).toEqual([{ repoRoot, branch: BRANCH, settings: expect.objectContaining({ baseBranch: "main", idleTimeoutSeconds: 60 }), signal: expect.any(AbortSignal) }]);
    expect(opened[0]?.signal?.aborted).toBe(false);
    expect(out[0]).toBe(`starting #7 at start in ${worktree}`);
    expect(out.at(-1)).toBe("#7: done");
    expect(git.calls.filter((c) => c.includes("session.json") || c.includes("events.jsonl"))).toEqual([]);

    const session = await savedSession();
    expect(session).toMatchObject({
      schemaVersion: 6,
      flow: "walk",
      issue: "7",
      title: "Cap asset slug length",
      branch: BRANCH,
      specDir: "specs/7-cap-asset-slug-length",
      current: "done",
      previous: "finish",
      work: "7",
      blocked: false,
    });
    expect(session.history.map((h) => [h.step, h.next])).toEqual([
      ["start", "work"],
      ["work", "finish"],
      ["finish", "done"],
    ]);
    expect(session.scopes["7"]?.["finish"]?.output).toMatchObject({ inputs: { a: "c-w1" } });
    expect(sandbox?.requests.map((r) => r.prompt.split("\n")[0])).toEqual([`Do Cap asset slug length in ${worktree} for #7.`]);
    expect(sandbox?.requests[0]?.logPath).toBe(join(root, "logs", "7", "r1-2-7-work-1.log"));

    const { runs: segments, spans } = foldTimeline(await savedEvents());
    expect(segments).toEqual([{ id: "r1", startedAt: expect.any(String), endedAt: expect.any(String), outcome: "done", pid: 4242, host: "box", sha: "abc1234", flow: "walk" }]);
    expect(spans.map((s) => [s.step, s.scope, s.next])).toEqual([
      ["start", "7", "work"],
      ["work", "7", "finish"],
      ["finish", "7", "done"],
    ]);
    // The lifecycle claimed the issue at the start and closed it on done.
    expect(tracker.claims).toEqual([{ issue: "7", branch: BRANCH }]);
    expect(tracker.issues.get("7")).toMatchObject({ state: "closed", labels: ["type:task", "sous:running"] });
    expect(await lockExists()).toBe(false);
  });

  it("writes nothing to the tracker under lifecycle: steps, from the settings or from the flow", async () => {
    await writeFile(join(root, "sous.yaml"), "lifecycle: steps\n");
    expect(await runCommand(["walk", "7"], deps())).toBe(0);
    expect(tracker.claims).toEqual([]);
    expect(tracker.issues.get("7")).toMatchObject({ state: "open", labels: ["type:task"] });

    await rm(join(root, "sous.yaml"));
    const flowFile = join(root, "flows", "walk.yaml");
    await writeFile(flowFile, `lifecycle: steps\n${await readFile(flowFile, "utf8")}`);
    expect(await runCommand(["walk", "7", "--restart"], deps())).toBe(0);
    expect(tracker.claims).toEqual([]);
    expect(tracker.issues.get("7")).toMatchObject({ state: "open", labels: ["type:task"] });
  });

  it("exits 1, mirrors blocked and closes the run as blocked when the agent exhausts its iterations", async () => {
    agent = [answer("w1", false, "red"), answer("w2", false, "red"), answer("w3", false, "red")];

    expect(await runCommand(["walk", "7"], deps())).toBe(1);

    expect(out.at(-1)).toBe("#7 blocked in work; see the issue comment");
    expect(tracker.issues.get("7")?.labels).toEqual(["type:task", "sous:blocked"]);
    expect(tracker.comments[0]?.body).toContain("Blocked in `work` after 3 iterations.");
    expect(tracker.comments[0]?.body).toContain(`sous run walk 7`);
    expect((await savedEvents()).at(-1)).toMatchObject({ type: "run.end", outcome: "blocked" });
    expect(await savedSession()).toMatchObject({ current: "work", blocked: true });
    expect(await lockExists()).toBe(false);
  });

  it("resumes an existing session at its current step, resolving the work item for ctx, and refuses another flow", async () => {
    let resumed = setWork(createSession({ flow: "walk", issue: "7", title: "t", branch: BRANCH, specDir: "specs/7-x", entry: "finish" }), "14");
    resumed = recordVisit(resumed, "work", { ok: true, log: "", output: { ok: true }, commits: ["w0"], session: "w0" });
    await saveSession(sessionFile(runs(), "7"), { ...resumed, previous: "work" });
    tracker.issues.set("14", issue({ id: "14", title: "Work 14" }));

    expect(await runCommand(["walk", "7"], deps({ newId: () => "r2" }))).toBe(0);
    expect(out[0]).toBe(`resuming #7 at finish in ${worktree}`);
    expect(opened[0]?.branch).toBe(BRANCH);
    const session = await savedSession();
    expect(session.history.map((h) => h.step)).toEqual(["finish"]);
    expect(session.scopes["14"]?.["finish"]?.output).toMatchObject({ inputs: { a: "w0" }, work: { id: "14", ref: "#14", title: "Work 14" }, previous: "work" });
    expect(foldTimeline(await savedEvents()).runs[0]).toMatchObject({ id: "r2", outcome: "done", resumedFrom: { step: "finish", iteration: 0 } });

    await saveSession(sessionFile(runs(), "7"), createSession({ flow: "other", issue: "7", title: "t", branch: "x", specDir: "s", entry: "start" }));
    expect(await runCommand(["walk", "7"], deps())).toBe(1);
    expect(err).toEqual(['sous run: #7 was started with flow "other"; run that flow or pass --restart']);
  });

  it("reports a finished session without opening a sandbox", async () => {
    await saveSession(sessionFile(runs(), "7"), createSession({ flow: "walk", issue: "7", title: "t", branch: "b", specDir: "s", entry: "done" }));
    expect(await runCommand(["walk", "7"], deps())).toBe(0);
    expect(out).toEqual(["#7 is already done (pass --restart to run it again)"]);
    expect(opened).toEqual([]);
  });

  it("closes the segment as crashed when the run throws, keeping the session where it was", async () => {
    agent = [new Error("sandcastle exploded")];

    await expect(runCommand(["walk", "7"], deps())).rejects.toThrow("sandcastle exploded");

    expect((await savedEvents()).at(-1)).toMatchObject({ type: "run.end", runId: "r1", outcome: "crashed", error: "sandcastle exploded" });
    expect((await savedSession()).current).toBe("work");
    expect(await lockExists()).toBe(false);
  });

  /** An `onSignal` dep that hands the installed handler to the test. */
  const signalTrap = () => {
    const trap: { handler?: SignalHandler; uninstalled: boolean; fire: (signal: StopSignal) => Promise<void> } = {
      uninstalled: false,
      fire: (signal) => trap.handler?.(signal) ?? Promise.reject(new Error("no handler installed")),
    };
    const onSignal = (handler: SignalHandler) => {
      trap.handler = handler;
      return () => {
        trap.uninstalled = true;
      };
    };
    return { trap, onSignal };
  };

  it("records an interrupted run, releases the lock and exits 130 when SIGINT arrives", async () => {
    const { trap, onSignal } = signalTrap();
    agent = [
      async () => {
        await trap.fire("SIGINT");
        throw new Error("process exited");
      },
    ] as unknown as AgentScript[];

    expect(await runCommand(["walk", "7"], deps({ onSignal }))).toBe(130);

    const events = await savedEvents();
    expect(events.map((e) => e.type).slice(0, 2)).toEqual(["run.start", "span.open"]);
    expect(events.filter((e) => e.type === "run.end")).toEqual([expect.objectContaining({ runId: "r1", outcome: "interrupted" })]);
    expect(trap.uninstalled).toBe(true);
    expect(await lockExists()).toBe(false);
  });

  it("lets the interrupt own the segment's end when the run loop sees the agent the signal killed", async () => {
    // The agent dies with the signal but the fake ignores the abort, so the
    // executor walks on to done; the signal must still win: no `done` or
    // `crashed` recorded, and the signal's exit code.
    const { trap, onSignal } = signalTrap();
    let handled: Promise<void> | undefined;
    agent = [
      () => {
        handled = trap.fire("SIGTERM");
        throw new AgentProcessError("claude exited with code 143", { exitCode: 143 });
      },
      answer("w1"),
    ] as unknown as AgentScript[];

    expect(await runCommand(["walk", "7"], deps({ onSignal }))).toBe(143);
    await handled;

    const ends = (await savedEvents()).filter((e) => e.type === "run.end");
    expect(ends).toEqual([expect.objectContaining({ outcome: "interrupted" })]);
    expect(await lockExists()).toBe(false);
  });

  it("terminates the agent call in flight: no failed iteration, the budget kept, run.end interrupted, the lock released", async () => {
    const { trap, onSignal } = signalTrap();
    let handled: Promise<void> | undefined;
    agent = [
      untilAborted(() => {
        handled = trap.fire("SIGTERM");
      }),
      answer("w1"),
    ];

    expect(await runCommand(["walk", "7"], deps({ onSignal }))).toBe(143);
    await handled;

    expect(opened[0]?.signal?.aborted).toBe(true);
    expect(sandbox?.abortedCalls).toBe(1);
    // The run ended at the abort: no retry, no second call.
    expect(sandbox?.requests).toHaveLength(1);
    // The aborted call is no iteration: announced, never ended, no eval, no output.
    const events = await savedEvents();
    const work = events.filter((e) => e.type !== "run.start" && e.type !== "run.end").slice(-2);
    expect(work).toEqual([expect.objectContaining({ type: "span.open", step: "work" }), expect.objectContaining({ type: "iteration.agent.start", n: 1 })]);
    expect(events.at(-1)).toMatchObject({ type: "run.end", runId: "r1", outcome: "interrupted" });
    expect(events.filter((e) => e.type === "run.end")).toHaveLength(1);
    const session = await savedSession();
    expect(session.current).toBe("work");
    expect(session.iterations["work"] ?? 0).toBe(0);
    expect(await lockExists()).toBe(false);
  });

  it("opens no segment when the signal arrives before the sandbox is open, and still releases the lock", async () => {
    const { trap, onSignal } = signalTrap();
    const interrupted: OpenSandbox = async (options) => {
      await trap.fire("SIGINT");
      return openSandbox(options);
    };

    expect(await runCommand(["walk", "7"], deps({ onSignal, openSandbox: interrupted }))).toBe(130);

    expect(await savedEvents()).toEqual([]);
    expect(await lockExists()).toBe(false);
  });

  it("drops the lock and stops the agent from a synchronous exit listener for as long as the lock is held", async () => {
    let onExitListener: (() => void) | undefined;
    let removed = false;
    const onExit = (listener: () => void) => {
      onExitListener = listener;
      return () => {
        removed = true;
      };
    };
    const probing: OpenSandbox = async (options) => {
      expect(await lockExists()).toBe(true);
      expect(options.signal?.aborted).toBe(false);
      onExitListener?.();
      // The process is on its way out: the lock is gone and the agent is stopped.
      expect(await lockExists()).toBe(false);
      expect(options.signal?.aborted).toBe(true);
      throw new Error("exiting");
    };

    await expect(runCommand(["walk", "7"], deps({ onExit, openSandbox: probing }))).rejects.toThrow("exiting");
    expect(removed).toBe(true);
  });

  it("removes the exit listener after a normal run without aborting the sandbox", async () => {
    let removed = false;
    const onExit = () => () => {
      removed = true;
    };

    expect(await runCommand(["walk", "7"], deps({ onExit }))).toBe(0);
    expect(removed).toBe(true);
    expect(opened[0]?.signal?.aborted).toBe(false);
  });

  it("uses the spec folder already planned on main; the branch follows the settings template", async () => {
    await mkdir(join(repoRoot, "specs", "7-planned-slug"), { recursive: true });
    await runCommand(["walk", "7"], deps());
    expect((await savedSession()).specDir).toBe("specs/7-planned-slug");
    expect(opened[0]?.branch).toBe(BRANCH);
  });

  it("validates the project first and exits 2 on errors, before taking the lock", async () => {
    await writeFile(join(root, "flows", "broken.yaml"), "entry: nowhere\nsteps:\n  - id: a\n    uses: void\n    routes:\n      - to: done\n");
    expect(await runCommand(["walk", "7"], deps())).toBe(2);
    expect(err[0]).toBe('flows/broken.yaml: entry: entry "nowhere" names no step id');
    expect(err.at(-1)).toBe("sous run: 1 validation error(s)");
    expect(opened).toEqual([]);
    expect(await lockExists()).toBe(false);
  });

  it("refuses an issue without one of the flow's allowedLabels with exit 2, before opening a sandbox", async () => {
    const flowFile = join(root, "flows", "walk.yaml");
    await writeFile(flowFile, `allowedLabels: [type:feature]\n${await readFile(flowFile, "utf8")}`);

    expect(await runCommand(["walk", "7"], deps())).toBe(2);
    expect(err).toEqual(['sous run: #7 has none of the labels flow "walk" accepts (type:feature); label the issue or run another flow']);
    expect(opened).toEqual([]);
    expect(await lockExists()).toBe(false);

    await writeFile(flowFile, (await readFile(flowFile, "utf8")).replace("[type:feature]", "[type:feature, type:task]"));
    expect(await runCommand(["walk", "7"], deps())).toBe(0);
  });

  it("refuses an unknown flow and bad arguments with exit 2", async () => {
    expect(await runCommand(["nope", "7"], deps())).toBe(2);
    expect(err[0]).toBe('sous run: unknown flow "nope" (known: walk)');
    expect(await runCommand(["walk"], deps())).toBe(2);
    expect(opened).toEqual([]);
  });

  it("refuses while another run holds the lock and reports a stale one", async () => {
    await writeFile(lockPath(root), '{"pid":99,"issue":"3"}\n');

    expect(await runCommand(["walk", "7"], deps({ isAlive: () => true }))).toBe(1);
    expect(err).toEqual([`sous run: another sous run holds ${lockPath(root)} (pid 99, issue 3)`]);

    expect(await runCommand(["walk", "7"], deps({ isAlive: () => false }))).toBe(1);
    expect(err[1]).toBe(`sous run: stale lock ${lockPath(root)}: pid 99 (issue 3) is not running; remove the file and retry`);
    expect(opened).toEqual([]);
    expect(await lockExists()).toBe(true);
  });

  it("releases the lock when the tracker fails before anything else happens", async () => {
    await expect(runCommand(["walk", "999"], deps())).rejects.toThrow("fakeTracker: no issue 999");
    expect(await lockExists()).toBe(false);
    expect(opened).toEqual([]);
  });

  it("--restart asks first, then removes the run folder, worktree and branch before running", async () => {
    git.existing.add(BRANCH);
    await saveSession(sessionFile(runs(), "7"), createSession({ flow: "walk", issue: "7", title: "t", branch: BRANCH, specDir: "s", entry: "finish" }));
    await createFileEventLog(eventsFile(runs(), "7")).append({ type: "run.end", at: "t", runId: "r0", outcome: "crashed" });
    confirmed = false;
    expect(await runCommand(["walk", "7", "--restart"], deps())).toBe(1);
    expect(err).toEqual(["sous run: restart cancelled"]);
    expect(git.calls).toEqual([]);
    expect((await savedSession()).current).toBe("finish");

    confirmed = true;
    expect(await runCommand(["walk", "7", "--restart"], deps())).toBe(0);
    expect(git.calls.slice(0, 3)).toEqual([
      `removeWorktree(${repoRoot}, ${worktreePathFor(repoRoot, BRANCH)})`,
      `branchExists(${repoRoot}, ${BRANCH})`,
      `deleteBranch(${repoRoot}, ${BRANCH}, true)`,
    ]);
    expect(out[0]).toBe(`restart: removed ${runDir(runs(), "7")}, the worktree and branch ${BRANCH}`);
    expect(out[1]).toBe(`starting #7 at start in ${worktree}`);
    expect(out.at(-1)).toBe("#7: done");
    expect((await savedEvents())[0]).toMatchObject({ type: "run.start", runId: "r1" });
    expect((await savedSession()).history[0]?.step).toBe("start");
  });

  it("--restart with nothing recorded yet behaves like a first run", async () => {
    expect(await runCommand(["walk", "7", "--restart"], deps())).toBe(0);
    expect((await savedSession()).current).toBe("done");
  });
});

describe("onProcessSignal", () => {
  const SIGNALS = ["SIGINT", "SIGTERM"] as const;
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  /** Like Node's own delivery: the signal name is the listener's argument. */
  const deliver = (signal: StopSignal) => process.emit(signal, signal);

  it("runs the handler, then exits with 130/143; other listeners, before or after, are set aside and put back", async () => {
    // Stands in for sandcastle's shutdown registry: process.exit(1) at once.
    const before = vi.fn();
    const after = vi.fn();
    process.on("SIGTERM", before);
    const exits: number[] = [];
    let release!: () => void;
    const handled: StopSignal[] = [];
    uninstall = onProcessSignal(
      (signal) => {
        handled.push(signal);
        return new Promise<void>((resolve) => (release = resolve));
      },
      { exit: (code) => exits.push(code) },
    );
    process.on("SIGTERM", after);
    await Promise.resolve();

    deliver("SIGTERM");
    await new Promise((r) => setTimeout(r, 5));
    expect(handled).toEqual(["SIGTERM"]);
    expect(exits).toEqual([]);
    release();
    await vi.waitFor(() => expect(exits).toEqual([143]));
    expect(before).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();

    uninstall();
    uninstall = undefined;
    for (const signal of SIGNALS) expect(process.listeners(signal).filter((l) => l === before || l === after)).toHaveLength(signal === "SIGTERM" ? 2 : 0);
    process.off("SIGTERM", before);
    process.off("SIGTERM", after);
  });

  it("exits after the grace period when the handler does not settle, and at once on a second signal", async () => {
    const exits: number[] = [];
    uninstall = onProcessSignal(() => new Promise<void>(() => undefined), { exit: (code) => exits.push(code), graceMs: 20 });

    deliver("SIGINT");
    deliver("SIGINT");
    expect(exits).toEqual([130]);
    await vi.waitFor(() => expect(exits).toEqual([130, 130]));
  });
});
