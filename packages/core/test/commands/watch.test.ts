import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveLocks, lockPath, locksDir } from "../../src/commands/lock.js";
import type { SignalHandler } from "../../src/commands/run.js";
import { createWatcher, engineCommandOf, parseWatchArgs, spawnChild, watchCommand, watchLockPath, watchReposOf, type ChildExit, type Spawn, type WatchDeps, type WatchRepo } from "../../src/commands/watch.js";
import type { Issue } from "../../src/ports/tracker.js";
import { fakeTracker, issue, type FakeTracker } from "../fakes/tracker.js";

type FakeChild = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
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
      env: { ...options.env },
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

/** A tracker block whose building calls nothing; the tests hand the watcher a fake tracker anyway. */
const TRACKER = "tracker: { type: local, dir: issues, shared: false, labels: sous }\n";

/** The running engine's CLI, as `sous watch` is handed it. */
const ENGINE = ["/usr/bin/node", "/engine/cli.js"];

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

  it("starts a run with SOUS_ROOT at the repository's .sous instead of the daemon's; passes its stdout lines on", async () => {
    vi.stubEnv("SOUS_ROOT", "/the/daemon/.sous");
    vi.stubEnv("SOUS_WATCH_TEST", "kept");
    const lines: string[] = [];
    const child = spawnChild(process.execPath, ["-e", "console.log(`root=${process.env.SOUS_ROOT ?? 'unset'}`); console.log(`other=${process.env.SOUS_WATCH_TEST}`)"], { cwd: tmpdir(), env: { SOUS_ROOT: "/the/repo/.sous" }, onOutput: (line) => lines.push(line) });
    expect(await child.exited).toMatchObject({ code: 0 });
    expect(lines).toEqual(["root=/the/repo/.sous", "other=kept"]);
  });

  it("delivers the forwarded signal to the process the wrapper started, not only to the wrapper", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sous-signal-"));
    const record = join(dir, "interrupted");
    const run = `process.on("SIGINT", () => { require("node:fs").writeFileSync(${JSON.stringify(record)}, "SIGINT"); process.exit(130); }); console.log("ready"); setInterval(() => undefined, 1000);`;
    // Like `.sous/sous`: a shell that starts node without exec, so node is the wrapper's child.
    await writeFile(join(dir, "wrapper.sh"), `#!/bin/sh\n"${process.execPath}" -e '${run}'\necho "after"\n`);
    let started!: () => void;
    const isReady = new Promise<void>((resolve) => (started = resolve));
    const child = spawnChild("/bin/sh", [join(dir, "wrapper.sh")], { cwd: dir, onOutput: (line) => (line === "ready" ? started() : undefined) });
    try {
      await isReady;
      child.kill("SIGINT");
      await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      expect(existsSync(record)).toBe(true);
    } finally {
      // Without delivery the node grandchild would outlive the test.
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
      await rm(dir, { recursive: true, force: true });
    }
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
    await writeFile(join(root, "sous.yaml"), `engine: ^0.9.0\n${TRACKER}`);
    tracker = fakeTracker();
    spawned = fakeSpawn();
    out = [];
    err = [];
    alive = new Set([process.pid]);
  });
  afterEach(() => rm(repoRoot, { recursive: true, force: true }));

  const deps = (overrides: Partial<WatchDeps> = {}): WatchDeps => ({
    root,
    repos: [{ name: "app", root, repoRoot, tracker, shared: false, location: { type: "local", at: join(root, "issues") } }],
    listed: false,
    engine: ENGINE,
    spawn: spawned.spawn,
    isAlive: (pid) => alive.has(pid),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    engineVersion: "0.9.0",
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
    expect(spawned.children.map(({ command, args, cwd, env }) => ({ command, args, cwd, env }))).toEqual([{ command: "/usr/bin/node", args: ["/engine/cli.js", "run", "7", "--flow", "task"], cwd: repoRoot, env: { SOUS_ROOT: root } }]);
    expect(out).toEqual([`#7: started sous run 7 --flow task (pid 1000, /usr/bin/node /engine/cli.js in ${repoRoot})`]);
  });

  it("starts a run with the parent's loader flags only, never its inspector or memory flags", async () => {
    const parent = ["--inspect", "--import", "file:///tsx/esm/index.mjs", "--max-old-space-size=4096", "--inspect-brk=9230", "--require=/tsx/cjs.cjs", "-r", "/hooks.cjs", "--loader=/old.mjs", "--experimental-loader", "/older.mjs", "--import=/more.mjs", "--enable-source-maps"];
    const engine = engineCommandOf("/engine/cli.js", parent);
    seed(ready("7"));
    await createWatcher(deps({ engine })).pass();
    expect(spawned.children.map(({ args }) => args)).toEqual([
      ["--import", "file:///tsx/esm/index.mjs", "--require=/tsx/cjs.cjs", "-r", "/hooks.cjs", "--loader=/old.mjs", "--experimental-loader", "/older.mjs", "--import=/more.mjs", "/engine/cli.js", "run", "7", "--flow", "task"],
    ]);
    expect(spawned.children[0]?.command).toBe(process.execPath);
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
      "#9 skipped: no flow accepts its labels (type:epic, sous:ready); give it the type:* label of one flow's allowedLabels",
      "#10 skipped: flows feature, task all accept it: the issue carries labels of several flows (type:task, type:feature); keep one",
      "#11 skipped: a run holds its lock (pid 4242)",
    ]);
  });

  it("skips a kind-less ready issue as no flow accepting it, even beside a flow without allowedLabels", async () => {
    await writeFile(join(root, "flows", "bench.yaml"), "entry: hello\nlifecycle: steps\nsteps:\n  - id: hello\n    uses: hello\n");
    seed(ready("7", []));
    await createWatcher(deps()).pass();
    expect(spawned.children).toEqual([]);
    expect(out).toEqual(["#7 skipped: no flow accepts its labels (sous:ready); give it the type:* label of one flow's allowedLabels"]);
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
    expect(spawned.children.map((c) => c.args.slice(1))).toEqual([["run", "3", "--flow", "task"]]);
    tracker.issues.set("3", { ...tracker.issues.get("3")!, state: "closed" });
    spawned.children[0]?.exit({ code: 0 });
    await watcher.idle();
    await watcher.pass();
    expect(spawned.children.map((c) => c.args.slice(1))).toEqual([
      ["run", "3", "--flow", "task"],
      ["run", "12", "--flow", "task"],
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
    expect(spawned.children.map((c) => c.args.slice(1))).toEqual([["run", "7", "--flow", "task"]]);
  });

  it("leaves a blocked issue alone until it also carries ready, then runs the same command", async () => {
    seed(issue({ id: "7", labels: ["type:task", "sous:blocked"] }));
    const watcher = createWatcher(deps());
    await watcher.pass();
    expect(spawned.children).toEqual([]);
    tracker.issues.set("7", issue({ id: "7", labels: ["type:task", "sous:blocked", "sous:ready"] }));
    await watcher.pass();
    expect(spawned.children.map((c) => c.args.slice(1))).toEqual([["run", "7", "--flow", "task"]]);
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
      `#7: started sous run 7 --flow task (pid 1000, /usr/bin/node /engine/cli.js in ${repoRoot})`,
      "#7: sous run 7 --flow task exited with 2: sous run: 1 validation error(s)",
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
    expect(spawned.children.map((c) => c.args.slice(1))).toEqual([["run", "7", "--flow", "task"]]);
    expect(out).toEqual([`#7: removed the stale lock of pid 999999; rerunning sous run 7 --flow task after a crash (pid 1000, /usr/bin/node /engine/cli.js in ${repoRoot})`]);

    spawned.children[0]?.exit({ code: 1, stderr: "boom\n" });
    await watcher.idle();
    expect(tracker.issues.get("7")?.labels).toEqual(["type:task", "sous:blocked"]);
    expect(tracker.comments).toEqual([{ issue: "7", body: expect.stringContaining(join(".sous", "logs", "7")) }]);
    expect(out.at(-1)).toBe("#7: crashed again; set sous:blocked, logs in .sous/logs/7");

  });

  it("runs an issue it gave up on again in the same daemon once a human sets sous:ready, with its one rerun back", async () => {
    seed(issue({ id: "7", labels: ["type:task", "sous:running"] }));
    await holdLock("7", 999999);
    const watcher = createWatcher(deps());
    await watcher.pass();
    spawned.children[0]?.exit({ code: 1, stderr: "boom\n" });
    await watcher.idle();
    expect(tracker.issues.get("7")?.labels).toEqual(["type:task", "sous:blocked"]);
    await watcher.pass();
    expect(spawned.children).toHaveLength(1);

    tracker.issues.set("7", issue({ id: "7", labels: ["type:task", "sous:blocked", "sous:ready"] }));
    await watcher.pass();
    expect(spawned.children.map((c) => c.args.slice(1))).toEqual([
      ["run", "7", "--flow", "task"],
      ["run", "7", "--flow", "task"],
    ]);

    // The handed-back run crashes: the issue is rerun once, as a new daemon would.
    tracker.issues.set("7", issue({ id: "7", labels: ["type:task", "sous:running"] }));
    await holdLock("7", 999997);
    spawned.children[1]?.exit({ code: 1 });
    await watcher.idle();
    await watcher.pass();
    expect(spawned.children).toHaveLength(3);
    expect(out.at(-1)).toBe(`#7: removed the stale lock of pid 999997; rerunning sous run 7 --flow task after a crash (pid 1002, /usr/bin/node /engine/cli.js in ${repoRoot})`);
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
    expect(spawned.children.map((c) => c.args.slice(1))).toEqual([
      ["run", "7", "--flow", "task"],
      ["run", "7", "--flow", "task"],
    ]);
  });

  it("removes a stale lock before starting a ready issue, so a crashed run a human hands back starts", async () => {
    seed(issue({ id: "7", labels: ["type:task", "sous:running", "sous:ready"] }));
    await holdLock("7", 999999);
    await createWatcher(deps()).pass();
    expect(existsSync(lockPath(root, "7"))).toBe(false);
    expect(spawned.children.map((c) => c.args.slice(1))).toEqual([["run", "7", "--flow", "task"]]);
    expect(out).toEqual([`#7: removed the stale lock of pid 999999; started sous run 7 --flow task (pid 1000, /usr/bin/node /engine/cli.js in ${repoRoot})`]);
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

  it("starts no run after a signal that lands while the pass waits on the tracker, and exits with the signal's code", async () => {
    seed(ready("7"));
    let handler: SignalHandler | undefined;
    let listing!: () => void;
    const answered = new Promise<void>((resolve) => (listing = resolve));
    let asked = false;
    const list = tracker.list.bind(tracker);
    tracker.list = async (query) => {
      asked = true;
      await answered;
      return list(query);
    };
    const command = watchCommand(["--interval", "60"], deps({ onSignal: (h) => ((handler = h), () => undefined), sleep: () => new Promise(() => undefined) }));
    await vi.waitFor(() => expect(asked).toBe(true));
    await handler!("SIGINT");
    listing();
    expect(await command).toBe(130);
    expect(spawned.children).toEqual([]);
  });

  it("starts no run after a signal that lands while the pass waits on the blockers", async () => {
    seed(ready("7"));
    let handler: SignalHandler | undefined;
    let asking!: () => void;
    tracker.blockers = async () => {
      await new Promise<void>((resolve) => (asking = resolve));
      return [];
    };
    const command = watchCommand(["--interval", "60"], deps({ onSignal: (h) => ((handler = h), () => undefined), sleep: () => new Promise(() => undefined) }));
    await vi.waitFor(() => expect(asking).toBeDefined());
    await handler!("SIGTERM");
    asking();
    expect(await command).toBe(143);
    expect(spawned.children).toEqual([]);
  });

  it("refuses a second watch on the project, naming the live one, and is not listed as a run", async () => {
    alive.add(4242);
    await mkdir(locksDir(root), { recursive: true });
    await writeFile(watchLockPath(root), JSON.stringify({ pid: 4242, issue: "watch" }));
    expect(await watchCommand(["--once"], deps())).toBe(1);
    expect(err).toEqual([`sous watch: another sous watch is live for this project (pid 4242, ${watchLockPath(root)})`]);
    expect(await liveLocks(root, () => true)).toEqual([]);
  });

  it("refuses to start in a repository without engine:, naming the key, before taking its lock", async () => {
    await writeFile(join(root, "sous.yaml"), TRACKER);
    seed(ready("7"));
    expect(await watchCommand(["--once"], deps())).toBe(2);
    expect(err).toEqual([`sous watch: ${repoRoot} states no engine: range in sous.yaml; add engine: ^0.9.0`]);
    expect(existsSync(watchLockPath(root))).toBe(false);
    expect(spawned.children).toEqual([]);
  });

  it("refuses to start in a home repository without engine: of its own, before taking its lock", async () => {
    await writeFile(join(root, "sous.yaml"), "repos: { b: ../b }\n");
    expect(await watchCommand(["--once"], deps({ listed: true }))).toBe(2);
    expect(err).toEqual([`sous watch: ${repoRoot} states no engine: range in sous.yaml; add engine: ^0.9.0`]);
    expect(existsSync(watchLockPath(root))).toBe(false);
  });

  it("refuses to start in a repository whose engine: range this engine does not satisfy", async () => {
    await writeFile(join(root, "sous.yaml"), "engine: ^0.8.0\n");
    expect(await watchCommand(["--once"], deps())).toBe(2);
    expect(err).toEqual([`sous watch: engine 0.9.0 does not satisfy engine: ^0.8.0 of ${repoRoot}; run it with an engine in that range or widen the range`]);
    expect(existsSync(watchLockPath(root))).toBe(false);
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
      expect(spawned.children.map((c) => c.args.slice(1))).toEqual([["run", "7", "--flow", "task"]]);
      expect(out).toEqual(["#8 skipped: repo:web names another repository than app", `#7: started sous run 7 --flow task (pid 1000, /usr/bin/node /engine/cli.js in ${repoRoot})`]);
      spawned.children[0]?.exit({ code: 0 });
      tracker.issues.set("7", { ...tracker.issues.get("7")!, state: "closed" });
      await watcher.idle();
      await watcher.pass();
      expect(spawned.children.map((c) => c.args.slice(1))).toEqual([["run", "7", "--flow", "task"], ["run", "9", "--flow", "task"]]);
    });

    it("on a shared tracker runs only issues labelled with its name, skipping an unlabelled one once, and names the tracker as it starts", async () => {
      seed(ready("7", ["type:task", "repo:web"]), ready("8"), ready("9", ["type:task", "repo:app"]));
      const watcher = createWatcher(deps({ repos: [{ name: "app", root, repoRoot, tracker, shared: true, location: { type: "github", at: "acme/planning" } }] }));
      await watcher.pass();
      await watcher.pass();
      expect(spawned.children.map((c) => c.args.slice(1))).toEqual([["run", "9", "--flow", "task"]]);
      expect(out).toEqual([
        "#7 skipped: repo:web names another repository than app",
        "#8 skipped: tracker acme/planning is shared; add repo:app",
        "#9: running in app (acme/planning)",
        `#9: started sous run 9 --flow task (pid 1000, /usr/bin/node /engine/cli.js in ${repoRoot})`,
      ]);
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
    const planning = { type: "github", at: "acme/planning" };
    /** An entry on the shared planning tracker `shared`. */
    const onPlanning = async (name: string, shared: FakeTracker) => ({ ...(await listedRepo(name, shared)), shared: true, location: planning });
    const listedRepo = async (name: string, own: FakeTracker = fakeTracker()): Promise<WatchRepo & { tracker: FakeTracker }> => {
      const checkout = join(repoRoot, "..", `${repoRoot.split("/").at(-1)}-${name}`);
      const projectRoot = join(checkout, ".sous");
      await mkdir(join(projectRoot, "flows"), { recursive: true });
      for (const [file, text] of Object.entries(FLOWS)) await writeFile(join(projectRoot, "flows", file), text);
      await writeFile(join(projectRoot, "sous.yaml"), `engine: ^0.9.0\n${TRACKER}`);
      cleanup.push(checkout);
      return { name, root: projectRoot, repoRoot: checkout, tracker: own, shared: false, location: { type: "github", at: `acme/${name}` } };
    };
    const cleanup: string[] = [];
    afterEach(async () => {
      for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
    });

    /** Each start as the engine's CLI saw it: its arguments after the CLI file, its cwd and project root. */
    const starts = () =>
      spawned.children.map(({ command, args, cwd, env }) => {
        expect([command, args[0]]).toEqual(ENGINE);
        return { args: args.slice(1), cwd, root: env["SOUS_ROOT"] };
      });

    it("starts one run in each repository at once, as its own .sous/sous in its checkout", async () => {
      const a = await listedRepo("a");
      const b = await listedRepo("b");
      a.tracker.issues.set("3", ready("3", ["type:task", "repo:a"]));
      a.tracker.issues.set("4", ready("4", ["type:task", "repo:a"]));
      b.tracker.issues.set("5", ready("5", ["type:feature", "repo:b"]));
      const watcher = createWatcher(deps({ repos: [a, b], listed: true }));
      await watcher.pass();
      expect(starts()).toEqual([
        { args: ["run", "3", "--flow", "task"], cwd: a.repoRoot, root: a.root },
        { args: ["run", "5", "--flow", "feature"], cwd: b.repoRoot, root: b.root },
      ]);
      expect(out).toEqual([`a #3: started sous run 3 --flow task (pid 1000, /usr/bin/node /engine/cli.js in ${a.repoRoot})`, `b #5: started sous run 5 --flow feature (pid 1001, /usr/bin/node /engine/cli.js in ${b.repoRoot})`]);
    });

    it("runs an issue of an unshared tracker in the entry that listed it, with no label or one naming it", async () => {
      const a = await listedRepo("a");
      const b = await listedRepo("b");
      a.tracker.issues.set("3", ready("3"));
      b.tracker.issues.set("5", ready("5", ["type:task", "repo:b"]));
      const watcher = createWatcher(deps({ repos: [a, b], listed: true }));
      await watcher.pass();
      expect(starts()).toEqual([
        { args: ["run", "3", "--flow", "task"], cwd: a.repoRoot, root: a.root },
        { args: ["run", "5", "--flow", "task"], cwd: b.repoRoot, root: b.root },
      ]);
      expect(out).toEqual([`a #3: started sous run 3 --flow task (pid 1000, /usr/bin/node /engine/cli.js in ${a.repoRoot})`, `b #5: started sous run 5 --flow task (pid 1001, /usr/bin/node /engine/cli.js in ${b.repoRoot})`]);
    });

    it("runs an issue of a shared tracker listed by two entries once, in the entry its repo label names, naming the tracker", async () => {
      const shared = fakeTracker();
      const a = await onPlanning("a", shared);
      const b = await onPlanning("b", shared);
      shared.issues.set("7", ready("7", ["type:task", "repo:b"]));
      const watcher = createWatcher(deps({ repos: [a, b], listed: true }));
      await watcher.pass();
      await watcher.pass();
      expect(starts()).toEqual([{ args: ["run", "7", "--flow", "task"], cwd: b.repoRoot, root: b.root }]);
      expect(out).toEqual(["#7: running in b (acme/planning)", `b #7: started sous run 7 --flow task (pid 1000, /usr/bin/node /engine/cli.js in ${b.repoRoot})`]);
    });

    it("reports an unknown repo label, several and a missing one once each and skips them, even when two entries list them", async () => {
      const shared = fakeTracker();
      const a = await onPlanning("a", shared);
      const b = await onPlanning("b", shared);
      shared.issues.set("6", ready("6", ["type:task", "repo:a", "repo:b"]));
      shared.issues.set("7", ready("7", ["type:task", "repo:zzz"]));
      shared.issues.set("8", ready("8"));
      const watcher = createWatcher(deps({ repos: [a, b], listed: true }));
      await watcher.pass();
      await watcher.pass();
      expect(spawned.children).toEqual([]);
      expect(out).toEqual(["#6 skipped: carries several repo:* labels (repo:a, repo:b); keep one", "#7 skipped: repo:zzz names no entry of repos: (a, b)", "#8 skipped: tracker acme/planning is shared; add repo:a or repo:b"]);
    });

    it("skips an issue of an unshared tracker naming another repository, and one of a shared tracker naming an entry elsewhere", async () => {
      const a = await listedRepo("a");
      const shared = fakeTracker();
      const b = await onPlanning("b", shared);
      a.tracker.issues.set("7", ready("7", ["type:task", "repo:b"]));
      shared.issues.set("8", ready("8", ["type:task", "repo:a"]));
      const watcher = createWatcher(deps({ repos: [a, b], listed: true }));
      await watcher.pass();
      await watcher.pass();
      expect(spawned.children).toEqual([]);
      expect(out).toEqual(["#7 skipped: repo:b names another repository than a", "#8 skipped: repo:a, but the tracker of a does not list it; a run in a could not find it"]);
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
      expect(starts().map((c) => c.args)).toEqual([["run", "3", "--flow", "task"], ["run", "5", "--flow", "task"], ["run", "6", "--flow", "task"]]);
    });

    it("builds each entry from its own .sous and starts its runs on the running engine's CLI, never the entry's .sous/sous", async () => {
      const home = join(repoRoot, ".sous");
      const a = await listedRepo("a");
      await writeFile(join(a.root, "sous.yaml"), `engine: ^0.9.0\n${TRACKER}`);
      await writeFile(join(a.root, "sous"), "#!/bin/sh\nexit 99\n");
      await writeFile(join(home, "sous.yaml"), `repos: { a: ${a.repoRoot} }\n`);
      const built = await watchReposOf(home, undefined, "0.9.0");
      expect(built.listed).toBe(true);
      expect(built.repos.map(({ name, root, repoRoot }) => ({ name, root, repoRoot }))).toEqual([{ name: "a", root: a.root, repoRoot: a.repoRoot }]);
      expect(await built.repos[0]?.tracker.list({ labels: ["sous:ready"] })).toEqual([]);

      const watcher = createWatcher(deps({ ...built, repos: built.repos.map((r) => ({ ...r, tracker: a.tracker })) }));
      a.tracker.issues.set("3", ready("3", ["type:task", "repo:a"]));
      await watcher.pass();
      expect(spawned.children.map(({ command, args, cwd, env }) => ({ command, args, cwd, env }))).toEqual([{ command: "/usr/bin/node", args: ["/engine/cli.js", "run", "3", "--flow", "task"], cwd: a.repoRoot, env: { SOUS_ROOT: a.root } }]);
      expect(out).toEqual([`a #3: started sous run 3 --flow task (pid 1000, /usr/bin/node /engine/cli.js in ${a.repoRoot})`]);
    });

    it("serves an entry with sous.yaml but no wrapper and no node_modules; sets one without sous.yaml aside, reported once", async () => {
      const home = join(repoRoot, ".sous");
      const a = await onPlanning("a", fakeTracker());
      const gone = join(repoRoot, "..", `nowhere-${Date.now()}`);
      await writeFile(join(a.root, "sous.yaml"), `engine: ^0.9.0\n${TRACKER}`);
      await writeFile(join(home, "sous.yaml"), `repos: { a: ${a.repoRoot}, gone: ${gone} }\n`);
      const built = await watchReposOf(home, undefined, "0.9.0");
      expect(built.repos.map((r) => r.name)).toEqual(["a"]);
      expect(built.unrunnable).toEqual([{ name: "gone", reason: `${gone} holds no .sous/sous.yaml; sous watch starts nothing there` }]);

      a.tracker.issues.set("3", ready("3", ["type:task", "repo:a"]));
      a.tracker.issues.set("4", ready("4", ["type:task", "repo:gone"]));
      const watcher = createWatcher(deps({ repos: [a], unrunnable: built.unrunnable, listed: true }));
      await watcher.pass();
      await watcher.pass();
      expect(starts()).toEqual([{ args: ["run", "3", "--flow", "task"], cwd: a.repoRoot, root: a.root }]);
      expect(out).toEqual([`gone skipped: ${gone} holds no .sous/sous.yaml; sous watch starts nothing there`, "#3: running in a (acme/planning)", `a #3: started sous run 3 --flow task (pid 1000, /usr/bin/node /engine/cli.js in ${a.repoRoot})`]);
    });

    it("sets an entry without engine: or outside its range aside, reports each once and serves the others", async () => {
      const home = join(repoRoot, ".sous");
      const a = await onPlanning("a", fakeTracker());
      const old = await listedRepo("old");
      const unstated = await listedRepo("unstated");
      await writeFile(join(a.root, "sous.yaml"), `engine: ^0.9.0\n${TRACKER}`);
      // A newer engine's key beside the range: read for engine: alone, never loaded as settings.
      await writeFile(join(old.root, "sous.yaml"), "engine: ^0.8.0\nsomethingNewer: true\n");
      await writeFile(join(unstated.root, "sous.yaml"), TRACKER);
      await writeFile(join(home, "sous.yaml"), `repos: { a: ${a.repoRoot}, old: ${old.repoRoot}, unstated: ${unstated.repoRoot} }\n`);
      const built = await watchReposOf(home, undefined, "0.9.0");
      expect(built.repos.map((r) => r.name)).toEqual(["a"]);
      expect(built.unrunnable).toEqual([
        { name: "old", reason: `engine 0.9.0 does not satisfy engine: ^0.8.0 of ${old.repoRoot}; run it with an engine in that range or widen the range; sous watch starts nothing there` },
        { name: "unstated", reason: `${unstated.repoRoot} states no engine: range in sous.yaml; add engine: ^0.9.0; sous watch starts nothing there` },
      ]);

      a.tracker.issues.set("3", ready("3", ["type:task", "repo:a"]));
      a.tracker.issues.set("4", ready("4", ["type:task", "repo:old"]));
      const watcher = createWatcher(deps({ repos: [a], unrunnable: built.unrunnable, listed: true }));
      await watcher.pass();
      await watcher.pass();
      expect(starts()).toEqual([{ args: ["run", "3", "--flow", "task"], cwd: a.repoRoot, root: a.root }]);
      expect(out).toEqual([`old skipped: ${built.unrunnable[0]?.reason}`, `unstated skipped: ${built.unrunnable[1]?.reason}`, "#3: running in a (acme/planning)", `a #3: started sous run 3 --flow task (pid 1000, /usr/bin/node /engine/cli.js in ${a.repoRoot})`]);
    });

    it("refuses to build two entries on one tracker with shared: false, naming both", async () => {
      const home = join(repoRoot, ".sous");
      const a = await listedRepo("a");
      const b = await listedRepo("b");
      const block = "engine: ^0.9.0\ntracker: { type: github, repo: acme/planning, shared: false, labels: sous }\n";
      await writeFile(join(a.root, "sous.yaml"), block);
      await writeFile(join(b.root, "sous.yaml"), block);
      await writeFile(join(home, "sous.yaml"), `repos: { a: ${a.repoRoot}, b: ${b.repoRoot} }\n`);
      await expect(watchReposOf(home, undefined, "0.9.0")).rejects.toThrow("repos: a and b use one tracker (github acme/planning) with shared: false; set shared: true in both, or give each its own tracker");
      await writeFile(join(b.root, "sous.yaml"), block.replace("false", "true"));
      await expect(watchReposOf(home, undefined, "0.9.0")).rejects.toThrow("repos: a and b use one tracker");
      await writeFile(join(a.root, "sous.yaml"), block.replace("false", "true"));
      expect((await watchReposOf(home, undefined, "0.9.0")).repos.map(({ name, shared, location }) => ({ name, shared, location }))).toEqual([
        { name: "a", shared: true, location: planning },
        { name: "b", shared: true, location: planning },
      ]);
    });

    it("refuses to build two entries under one name", async () => {
      const home = join(repoRoot, ".sous");
      const a = await listedRepo("a");
      await writeFile(join(a.root, "sous.yaml"), "engine: ^0.9.0\n");
      await writeFile(join(home, "sous.yaml"), `repos: [${a.repoRoot}, ${a.repoRoot}]\n`);
      await expect(watchReposOf(home)).rejects.toThrow(/two entries are named/);
    });
  });
});
