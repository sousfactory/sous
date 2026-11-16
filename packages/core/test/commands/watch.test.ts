import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveLocks, lockPath, locksDir } from "../../src/commands/lock.js";
import type { SignalHandler } from "../../src/commands/run.js";
import { createWatcher, parseWatchArgs, spawnChild, watchCommand, watchLockPath, watchReposOf, type ChildExit, type Spawn, type WatchDeps, type WatchRepo } from "../../src/commands/watch.js";
import type { Issue } from "../../src/ports/tracker.js";
import { fakeTracker, issue, type FakeTracker } from "../fakes/tracker.js";

type FakeChild = {
  command: string;
  args: string[];
  cwd: string;
  pid: number;
  signals: string[];
  output: (line: string) => void;
  exit: (result: Partial<ChildExit>) => void;
};

/** Records every start; a test ends a child with `exit`, as the run process would. */
const fakeSpawn = () => {
  const children: FakeChild[] = [];
  const spawn: Spawn = (command, args, options) => {
    let resolve!: (result: ChildExit) => void;
    const exited = new Promise<ChildExit>((r) => (resolve = r));
    const child: FakeChild = {
      command,
      args: [...args],
      cwd: options.cwd,
      pid: 1000 + children.length,
      signals: [],
      output: options.onOutput,
      exit: (result) => resolve({ code: 0, signal: null, stderr: "", ...result }),
    };
    children.push(child);
    return { pid: child.pid, exited, kill: (signal) => void child.signals.push(signal) };
  };
  return { spawn, children };
};

const FLOWS = {
  "task.yaml": "entry: implement\nallowedLabels: [type:task, type:bug]\nsteps:\n  - id: implement\n    uses: implement\n",
  "feature.yaml": "entry: plan\nallowedLabels: [type:feature]\nsteps:\n  - id: plan\n    uses: plan\n",
};

const ready = (id: string, labels: string[] = ["type:task"], body?: string): Issue => issue({ id, labels: [...labels, "sous:ready"], ...(body !== undefined ? { body } : {}) });

/** Lets the promise callbacks queued by an exit run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("parseWatchArgs", () => {
  it("defaults to a 60 second interval and takes --interval and --once", () => {
    expect(parseWatchArgs([])).toEqual({ once: false, intervalSeconds: 60 });
    expect(parseWatchArgs(["--interval", "5", "--once"])).toEqual({ once: true, intervalSeconds: 5 });
  });

  it("refuses a non-positive interval, a stray argument and unknown options", () => {
    for (const args of [["--interval", "0"], ["--interval"], ["--interval", "x"], ["7"], ["--fast"]]) expect(parseWatchArgs(args)).toHaveProperty("error");
  });
});

describe("spawnChild", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("starts a run without the daemon's SOUS_ROOT, so the run finds its own .sous; passes its stdout lines on", async () => {
    vi.stubEnv("SOUS_ROOT", "/the/daemon/.sous");
    vi.stubEnv("SOUS_WATCH_TEST", "kept");
    const lines: string[] = [];
    const child = spawnChild(process.execPath, ["-e", "console.log(`root=${process.env.SOUS_ROOT ?? 'unset'}`); console.log(`other=${process.env.SOUS_WATCH_TEST}`)"], { cwd: tmpdir(), onOutput: (line) => lines.push(line) });
    expect(await child.exited).toMatchObject({ code: 0 });
    expect(lines).toEqual(["root=unset", "other=kept"]);
  });
});

describe("sous watch", () => {
  let repoRoot: string;
  let root: string;
  let tracker: FakeTracker;
  let spawned: ReturnType<typeof fakeSpawn>;
  let out: string[];
  let err: string[];
  let alive: Set<number>;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "sous-watch-"));
    root = join(repoRoot, ".sous");
    await mkdir(join(root, "flows"), { recursive: true });
    for (const [name, text] of Object.entries(FLOWS)) await writeFile(join(root, "flows", name), text);
    tracker = fakeTracker();
    spawned = fakeSpawn();
    out = [];
    err = [];
    alive = new Set([process.pid]);
  });
  afterEach(() => rm(repoRoot, { recursive: true, force: true }));

  const deps = (overrides: Partial<WatchDeps> = {}): WatchDeps => ({
    root,
    repos: [{ name: "app", root, repoRoot, tracker, sous: [join(root, "sous")] }],
    listed: false,
    spawn: spawned.spawn,
    isAlive: (pid) => alive.has(pid),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...overrides,
  });

  const seed = (...issues: Issue[]) => {
    for (const i of issues) tracker.issues.set(i.id, i);
  };

  const holdLock = async (issueId: string, pid: number) => {
    await mkdir(locksDir(root), { recursive: true });
    await writeFile(lockPath(root, issueId), JSON.stringify({ pid, issue: issueId }));
  };

  it("starts the one flow accepting a ready, unblocked issue as that repository's sous run, in the repository", async () => {
    seed(ready("7"));
    const watcher = createWatcher(deps());
    await watcher.pass();
    expect(spawned.children.map(({ command, args, cwd }) => ({ command, args, cwd }))).toEqual([{ command: join(root, "sous"), args: ["run", "task", "7"], cwd: repoRoot }]);
    expect(out).toEqual(["#7: started sous run task 7 (pid 1000)"]);
  });

  it("leaves the label swap to the run: its claim turns sous:ready into sous:running", async () => {
    seed(ready("7"));
    await createWatcher(deps()).pass();
    await tracker.claim("7", { branch: "feature/7-x" });
    expect(tracker.issues.get("7")?.labels).toEqual(["type:task", "sous:running"]);
  });

  it("skips an issue with an open blocker, an unknown kind, an ambiguous kind or its own live lock, saying so once", async () => {
    seed(issue({ id: "5" }), ready("8", ["type:task"], "## Blocked by\n- #5\n"), ready("9", ["type:epic"]), ready("10", ["type:task", "type:feature"]));
    alive.add(4242);
    await holdLock("11", 4242);
    seed(ready("11"));
    const watcher = createWatcher(deps());
    await watcher.pass();
    await watcher.pass();
    expect(spawned.children).toEqual([]);
    expect(out).toEqual([
      "#8 skipped: blocked by #5",
      "#9 skipped: no flow accepts type:epic",
      "#10 skipped: flows feature, task all accept type:task, type:feature; keep one type:* label",
      "#11 skipped: a run holds its lock (pid 4242)",
    ]);
  });

  it("reports a blocker the tracker cannot follow once and skips the issue", async () => {
    seed(ready("8", ["type:task"], "## Blocked by\n- acme/api#4\n"));
    tracker.blockers = async () => {
      throw new Error("local issues: blocker acme/api#4 names an issue in another repository");
    };
    const watcher = createWatcher(deps());
    await watcher.pass();
    await watcher.pass();
    expect(spawned.children).toEqual([]);
    expect(out).toEqual(["#8 skipped: local issues: blocker acme/api#4 names an issue in another repository"]);
  });

  it("starts ready issues lowest number first, the next only after the run before it ended", async () => {
    seed(ready("12"), ready("3"));
    const watcher = createWatcher(deps());
    await watcher.pass();
    await watcher.pass();
    expect(spawned.children.map((c) => c.args)).toEqual([["run", "task", "3"]]);
    tracker.issues.set("3", { ...tracker.issues.get("3")!, state: "closed" });
    spawned.children[0]?.exit({ code: 0 });
    await watcher.idle();
    await watcher.pass();
    expect(spawned.children.map((c) => c.args)).toEqual([
      ["run", "task", "3"],
      ["run", "task", "12"],
    ]);
  });

  it("starts nothing while a run started by hand holds a live lock in the repository", async () => {
    seed(ready("7"));
    alive.add(4242);
    await holdLock("5", 4242);
    const watcher = createWatcher(deps());
    await watcher.pass();
    expect(spawned.children).toEqual([]);
    alive.delete(4242);
    await rm(lockPath(root, "5"));
    await watcher.pass();
    expect(spawned.children.map((c) => c.args)).toEqual([["run", "task", "7"]]);
  });

  it("leaves a blocked issue alone until it also carries ready, then runs the same command", async () => {
    seed(issue({ id: "7", labels: ["type:task", "sous:blocked"] }));
    const watcher = createWatcher(deps());
    await watcher.pass();
    expect(spawned.children).toEqual([]);
    tracker.issues.set("7", issue({ id: "7", labels: ["type:task", "sous:blocked", "sous:ready"] }));
    await watcher.pass();
    expect(spawned.children.map((c) => c.args)).toEqual([["run", "task", "7"]]);
  });

  it("does not start an issue again whose run it started left sous:ready on it, until its labels change", async () => {
    seed(ready("7"));
    const watcher = createWatcher(deps());
    await watcher.pass();
    spawned.children[0]?.exit({ code: 2, stderr: "sous run: 1 validation error(s)\n" });
    await watcher.idle();
    await watcher.pass();
    await watcher.pass();
    expect(spawned.children).toHaveLength(1);
    expect(out).toEqual([
      "#7: started sous run task 7 (pid 1000)",
      "#7: sous run task 7 exited with 2: sous run: 1 validation error(s)",
      "#7 skipped: still sous:ready after its run exited; change its labels to start it again",
    ]);
  });

  it("forwards a run's push line", async () => {
    seed(ready("7"));
    await createWatcher(deps()).pass();
    spawned.children[0]?.output("merge: squashed feature/7-x into main as abc1234, pushed main to origin");
    spawned.children[0]?.output("implement: iteration 1");
    expect(out.slice(1)).toEqual(["#7: merge: squashed feature/7-x into main as abc1234, pushed main to origin"]);
  });

  it("reruns a running issue with a stale lock once, removing the lock; a second crash blocks it with the log folder", async () => {
    seed(issue({ id: "7", labels: ["type:task", "sous:running"] }));
    await holdLock("7", 999999);
    const watcher = createWatcher(deps());
    await watcher.pass();
    expect(existsSync(lockPath(root, "7"))).toBe(false);
    expect(spawned.children.map((c) => c.args)).toEqual([["run", "task", "7"]]);
    expect(out).toEqual(["#7: removed the stale lock of pid 999999; rerunning sous run task 7 after a crash (pid 1000)"]);

    spawned.children[0]?.exit({ code: 1, stderr: "boom\n" });
    await watcher.idle();
    expect(tracker.issues.get("7")?.labels).toEqual(["type:task", "sous:blocked"]);
    expect(tracker.comments).toEqual([{ issue: "7", body: expect.stringContaining(join(".sous", "logs", "7")) }]);
    expect(out.at(-1)).toBe("#7: crashed again; set sous:blocked, logs in .sous/logs/7");

    tracker.issues.set("7", issue({ id: "7", labels: ["type:task", "sous:running", "sous:ready"] }));
    await watcher.pass();
    expect(spawned.children).toHaveLength(1);
  });

  it("removes the stale lock a second crash left, so the hand-back with ready starts in a new daemon", async () => {
    seed(issue({ id: "7", labels: ["type:task", "sous:running"] }));
    await holdLock("7", 999999);
    const watcher = createWatcher(deps());
    await watcher.pass();
    await holdLock("7", 999998);
    spawned.children[0]?.exit({ code: 1, stderr: "boom\n" });
    await watcher.idle();
    expect(tracker.issues.get("7")?.labels).toEqual(["type:task", "sous:blocked"]);
    expect(existsSync(lockPath(root, "7"))).toBe(false);

    tracker.issues.set("7", issue({ id: "7", labels: ["type:task", "sous:blocked", "sous:ready"] }));
    await createWatcher(deps()).pass();
    expect(spawned.children.map((c) => c.args)).toEqual([
      ["run", "task", "7"],
      ["run", "task", "7"],
    ]);
  });

  it("removes a stale lock before starting a ready issue, so a crashed run a human hands back starts", async () => {
    seed(issue({ id: "7", labels: ["type:task", "sous:running", "sous:ready"] }));
    await holdLock("7", 999999);
    await createWatcher(deps()).pass();
    expect(existsSync(lockPath(root, "7"))).toBe(false);
    expect(spawned.children.map((c) => c.args)).toEqual([["run", "task", "7"]]);
    expect(out).toEqual(["#7: removed the stale lock of pid 999999; started sous run task 7 (pid 1000)"]);
  });

  it("leaves a running issue without a lock alone: its run may be on another machine", async () => {
    seed(issue({ id: "7", labels: ["type:task", "sous:running"] }));
    await createWatcher(deps()).pass();
    expect(spawned.children).toEqual([]);
    expect(out).toEqual([]);
  });

  it("does not block a rerun that ended blocked or done", async () => {
    seed(issue({ id: "7", labels: ["type:task", "sous:running"] }));
    await holdLock("7", 999999);
    const watcher = createWatcher(deps());
    await watcher.pass();
    tracker.issues.set("7", issue({ id: "7", labels: ["type:task", "sous:blocked"] }));
    spawned.children[0]?.exit({ code: 1 });
    await watcher.idle();
    expect(tracker.comments).toEqual([]);
  });

  it("--once makes one pass, waits for the run it started, and exits 0", async () => {
    seed(ready("7"), ready("8"));
    let done = false;
    const command = watchCommand(["--once"], deps({ sleep: () => Promise.reject(new Error("--once never sleeps")) })).then((code) => {
      done = true;
      return code;
    });
    await vi.waitFor(() => expect(spawned.children).toHaveLength(1));
    await settle();
    expect(done).toBe(false);
    spawned.children[0]?.exit({ code: 0 });
    expect(await command).toBe(0);
    expect(spawned.children).toHaveLength(1);
    expect(existsSync(watchLockPath(root))).toBe(false);
  });

  it("--once exits 1 when its pass could not ask the tracker", async () => {
    tracker.list = async () => {
      throw new Error("gh issue list failed");
    };
    expect(await watchCommand(["--once"], deps())).toBe(1);
    expect(err).toEqual(["sous watch: gh issue list failed"]);
  });

  it("--interval 5 polls every five seconds until stopped", async () => {
    const slept: number[] = [];
    let handler: SignalHandler | undefined;
    const command = watchCommand(
      ["--interval", "5"],
      deps({
        onSignal: (h) => ((handler = h), () => undefined),
        sleep: async (ms) => {
          slept.push(ms);
          if (slept.length === 2) await handler?.("SIGINT");
        },
      }),
    );
    expect(await command).toBe(130);
    expect(slept).toEqual([5000, 5000]);
  });

  it("forwards SIGINT and SIGTERM to the run it started and exits once that run has recorded the interrupt", async () => {
    seed(ready("7"));
    let handler: SignalHandler | undefined;
    const command = watchCommand(["--interval", "60"], deps({ onSignal: (h) => ((handler = h), () => undefined), sleep: () => new Promise(() => undefined) }));
    await vi.waitFor(() => expect(spawned.children).toHaveLength(1));
    let handled = false;
    const handling = handler!("SIGTERM").then(() => (handled = true));
    await settle();
    expect(spawned.children[0]?.signals).toEqual(["SIGTERM"]);
    expect(handled).toBe(false);
    spawned.children[0]?.exit({ code: 143 });
    await handling;
    expect(await command).toBe(143);
    expect(existsSync(watchLockPath(root))).toBe(false);
  });

  it("refuses a second watch on the project, naming the live one, and is not listed as a run", async () => {
    alive.add(4242);
    await mkdir(locksDir(root), { recursive: true });
    await writeFile(watchLockPath(root), JSON.stringify({ pid: 4242, issue: "watch" }));
    expect(await watchCommand(["--once"], deps())).toBe(1);
    expect(err).toEqual([`sous watch: another sous watch is live for this project (pid 4242, ${watchLockPath(root)})`]);
    expect(await liveLocks(root, () => true)).toEqual([]);
  });

  it("takes over a watch lock whose daemon is gone", async () => {
    await mkdir(locksDir(root), { recursive: true });
    await writeFile(watchLockPath(root), JSON.stringify({ pid: 999999, issue: "watch" }));
    expect(await watchCommand(["--once"], deps())).toBe(0);
  });

  describe("without repos:", () => {
    it("runs an issue labelled with this repository's name or with none, and reports one naming another repository once", async () => {
      seed(ready("7", ["type:task", "repo:app"]), ready("8", ["type:task", "repo:web"]), ready("9"));
      const watcher = createWatcher(deps());
      await watcher.pass();
      await watcher.pass();
      expect(spawned.children.map((c) => c.args)).toEqual([["run", "task", "7"]]);
      expect(out).toEqual(["#8 skipped: repo:web names another repository than app", "#7: started sous run task 7 (pid 1000)"]);
      spawned.children[0]?.exit({ code: 0 });
      tracker.issues.set("7", { ...tracker.issues.get("7")!, state: "closed" });
      await watcher.idle();
      await watcher.pass();
      expect(spawned.children.map((c) => c.args)).toEqual([["run", "task", "7"], ["run", "task", "9"]]);
    });

    it("reports an issue carrying two repo:* labels once and skips it", async () => {
      seed(ready("7", ["type:task", "repo:app", "repo:web"]));
      const watcher = createWatcher(deps());
      await watcher.pass();
      await watcher.pass();
      expect(spawned.children).toEqual([]);
      expect(out).toEqual(["#7 skipped: carries several repo:* labels (repo:app, repo:web); keep one"]);
    });
  });

  describe("with repos:", () => {
    /** A listed repository: its checkout beside the home repository, its own `.sous/` with the flows, its own tracker. */
    const listedRepo = async (name: string, own: FakeTracker = fakeTracker()): Promise<WatchRepo & { tracker: FakeTracker }> => {
      const checkout = join(repoRoot, "..", `${repoRoot.split("/").at(-1)}-${name}`);
      const projectRoot = join(checkout, ".sous");
      await mkdir(join(projectRoot, "flows"), { recursive: true });
      for (const [file, text] of Object.entries(FLOWS)) await writeFile(join(projectRoot, "flows", file), text);
      cleanup.push(checkout);
      return { name, root: projectRoot, repoRoot: checkout, tracker: own, sous: [join(projectRoot, "sous")] };
    };
    const cleanup: string[] = [];
    afterEach(async () => {
      for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
    });

    const starts = () => spawned.children.map(({ command, args, cwd }) => ({ command, args, cwd }));

    it("starts one run in each repository at once, as its own .sous/sous in its checkout", async () => {
      const a = await listedRepo("a");
      const b = await listedRepo("b");
      a.tracker.issues.set("3", ready("3", ["type:task", "repo:a"]));
      a.tracker.issues.set("4", ready("4", ["type:task", "repo:a"]));
      b.tracker.issues.set("5", ready("5", ["type:feature", "repo:b"]));
      const watcher = createWatcher(deps({ repos: [a, b], listed: true }));
      await watcher.pass();
      expect(starts()).toEqual([
        { command: join(a.root, "sous"), args: ["run", "task", "3"], cwd: a.repoRoot },
        { command: join(b.root, "sous"), args: ["run", "feature", "5"], cwd: b.repoRoot },
      ]);
      expect(out).toEqual(["a #3: started sous run task 3 (pid 1000)", "b #5: started sous run feature 5 (pid 1001)"]);
    });

    it("runs an issue of a shared tracker in the entry its repo label names, once", async () => {
      const shared = fakeTracker();
      const a = await listedRepo("a", shared);
      const b = await listedRepo("b", shared);
      shared.issues.set("7", ready("7", ["type:task", "repo:b"]));
      const watcher = createWatcher(deps({ repos: [a, b], listed: true }));
      await watcher.pass();
      await watcher.pass();
      expect(starts()).toEqual([{ command: join(b.root, "sous"), args: ["run", "task", "7"], cwd: b.repoRoot }]);
    });

    it("reports an unknown repo label and a missing one once each and skips them, even when two trackers list them", async () => {
      const shared = fakeTracker();
      const a = await listedRepo("a", shared);
      const b = await listedRepo("b", shared);
      shared.issues.set("7", ready("7", ["type:task", "repo:zzz"]));
      shared.issues.set("8", ready("8"));
      const watcher = createWatcher(deps({ repos: [a, b], listed: true }));
      await watcher.pass();
      await watcher.pass();
      expect(spawned.children).toEqual([]);
      expect(out).toEqual(["#7 skipped: repo:zzz names no entry of repos: (a, b)", "#8 skipped: no repo:* label names its repository"]);
    });

    it("reports an issue labelled for an entry whose own tracker does not list it", async () => {
      const a = await listedRepo("a");
      const b = await listedRepo("b");
      a.tracker.issues.set("7", ready("7", ["type:task", "repo:b"]));
      const watcher = createWatcher(deps({ repos: [a, b], listed: true }));
      await watcher.pass();
      await watcher.pass();
      expect(spawned.children).toEqual([]);
      expect(out).toEqual(["#7 skipped: repo:b, but the tracker of b does not list it; a run in b could not find it"]);
    });

    it("runs nothing in the home repository unless the list names it", async () => {
      seed(ready("1"));
      const a = await listedRepo("a");
      await createWatcher(deps({ repos: [a], listed: true })).pass();
      expect(spawned.children).toEqual([]);
    });

    it("keeps one run per repository: a repository's next issue waits for its own run, not for the other's", async () => {
      const a = await listedRepo("a");
      const b = await listedRepo("b");
      a.tracker.issues.set("3", ready("3", ["type:task", "repo:a"]));
      b.tracker.issues.set("5", ready("5", ["type:task", "repo:b"]));
      b.tracker.issues.set("6", ready("6", ["type:task", "repo:b"]));
      const watcher = createWatcher(deps({ repos: [a, b], listed: true }));
      await watcher.pass();
      b.tracker.issues.set("5", { ...b.tracker.issues.get("5")!, state: "closed" });
      spawned.children[1]?.exit({ code: 0 });
      await settle();
      await watcher.pass();
      expect(starts().map((c) => c.args)).toEqual([["run", "task", "3"], ["run", "task", "5"], ["run", "task", "6"]]);
    });

    it("builds each entry from its own .sous: its tracker, its sous, its checkout", async () => {
      const home = join(repoRoot, ".sous");
      const a = await listedRepo("a");
      await writeFile(join(a.root, "sous.yaml"), "tracker: local\ntrackerOptions: { dir: issues }\n");
      await writeFile(join(a.root, "sous"), "#!/bin/sh\n");
      await writeFile(join(home, "sous.yaml"), `repos: { a: ${a.repoRoot} }\n`);
      const built = await watchReposOf(home, "/engine/cli.js");
      expect(built.listed).toBe(true);
      expect(built.repos.map(({ name, root, repoRoot, sous }) => ({ name, root, repoRoot, sous }))).toEqual([{ name: "a", root: a.root, repoRoot: a.repoRoot, sous: [join(a.root, "sous")] }]);
      expect(await built.repos[0]?.tracker.list({ labels: ["sous:ready"] })).toEqual([]);
    });

    it("refuses to build an entry whose path holds no project", async () => {
      const home = join(repoRoot, ".sous");
      await writeFile(join(home, "sous.yaml"), `repos: { gone: ../nowhere-${Date.now()} }\n`);
      await expect(watchReposOf(home, "/engine/cli.js")).rejects.toThrow(/repos\.gone: .* holds no \.sous\/sous\.yaml/);
    });
  });
});
