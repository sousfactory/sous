import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenSandbox } from "../../src/adapters/sandbox.js";
import { homeRunCommand, type HomeRunDeps, type RunChild } from "../../src/commands/homerun.js";
import { lockPath } from "../../src/commands/lock.js";
import { runCommand } from "../../src/commands/run.js";
import { statusCommand } from "../../src/commands/status.js";
import { watchReposOf } from "../../src/commands/watch.js";
import { lookupOf, type Lookup } from "../../src/lookup.js";
import { answer, execRoot, fakeClock } from "../fakes/executor.js";
import { fakeGit } from "../fakes/git.js";
import { fakeSandbox } from "../fakes/sandbox.js";
import { fakeTracker, issue, type FakeTracker } from "../fakes/tracker.js";

/** The running engine's CLI, as `sous run` in the home repository is handed it. */
const ENGINE = ["/usr/bin/node", "/engine/cli.js"];

/** An entry's own tracker, or the one several entries share. */
const OWN = "tracker: { type: local, dir: issues, shared: false, labels: sous }";
const SHARED = "tracker: { type: local, dir: ../../planning, shared: true, labels: sous }";

describe("sous run in a home repository", () => {
  let dir: string;
  let home: string;
  /** The fake behind each tracker location, so entries on one location share it. */
  let trackers: Map<string, FakeTracker>;
  let out: string[];
  let err: string[];
  /** Every child started: its command line, cwd and the environment it was given. */
  let children: { command: string; args: string[]; cwd: string; env: Record<string, string> }[];
  /** Where each run opened its worktree. */
  let sandboxRoots: string[];

  const trackerAt = (at: string): FakeTracker => {
    if (!trackers.has(at)) trackers.set(at, fakeTracker());
    return trackers.get(at)!;
  };
  /** The tracker of entry `name` when it keeps its own issues, and the shared one. */
  const own = (name: string): FakeTracker => trackerAt(join(dir, name, ".sous", "issues"));
  const shared = (): FakeTracker => trackerAt(join(dir, "planning"));

  /** A listed repository `name` beside the home one: its `.sous/` holds definitions only, no wrapper, no `node_modules`. */
  const listed = async (name: string, tracker: string = OWN): Promise<{ repoRoot: string; root: string }> => {
    const repoRoot = join(dir, name);
    const root = join(repoRoot, ".sous");
    await cp(execRoot, root, { recursive: true });
    await writeFile(join(root, "sous.yaml"), `engine: ^0.9.0\nidleTimeoutSeconds: 60\n${tracker}\n`);
    // As the workspace root: without it tsx would load the copied step modules as CommonJS.
    await writeFile(join(repoRoot, "package.json"), '{ "type": "module" }\n');
    return { repoRoot, root };
  };

  /** The lookup `sous watch` would build here, each tracker the fake at its location. */
  const lookup = async (): Promise<Lookup> => {
    const built = await lookupOf(home, undefined, "0.9.1");
    return { ...built, repos: built.repos.map((r) => ({ ...r, tracker: trackerAt(r.location.at) })) };
  };

  /** The child the engine's CLI would be: `sous run` with the project `SOUS_ROOT` names, in the cwd it was given, on that project's tracker. */
  const engineChild: RunChild = async (command, args, { cwd, env }) => {
    children.push({ command, args: [...args], cwd, env: { ...env } });
    const git = fakeGit();
    const openSandbox: OpenSandbox = async (options) => {
      sandboxRoots.push(options.repoRoot);
      return fakeSandbox({ worktreePath: join(options.repoRoot, ".sous", "worktrees", "wt"), branch: options.branch, agent: [answer("w1")] });
    };
    const [, ...runArgs] = args.slice(ENGINE.length - 1);
    const tracker = (await lookup()).repos.find((r) => r.root === env["SOUS_ROOT"])!.tracker;
    return runCommand(runArgs, {
      root: env["SOUS_ROOT"]!,
      repoRoot: cwd,
      git,
      tracker,
      openSandbox,
      confirm: async () => true,
      out: () => undefined,
      err: (line) => err.push(line),
      clock: fakeClock(),
      pid: 4242,
      isAlive: () => false,
      host: "box",
      sha: async () => "abc1234",
      newId: () => "r1",
      engineVersion: "0.9.1",
    });
  };

  const run = async (args: string[], overrides: Partial<HomeRunDeps> = {}): Promise<number> =>
    homeRunCommand(args, {
      root: home,
      lookup: await lookup(),
      engine: ENGINE,
      engineVersion: "0.9.1",
      runChild: engineChild,
      runHere: async () => {
        throw new Error("not routed to the home repository");
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      ...overrides,
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sous-home-run-"));
    home = join(dir, "home", ".sous");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "sous.yaml"), "repos: { a: ../a, b: ../b }\n");
    trackers = new Map();
    out = [];
    err = [];
    children = [];
    sandboxRoots = [];
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("asks every entry's tracker and runs the issue where the one that holds it lives, ready or not, with lock, record and worktree there", async () => {
    await listed("a");
    const b = await listed("b");
    own("b").issues.set("42", issue({ id: "42", title: "Cap asset slug length", labels: ["type:task"] }));
    expect(await run(["42", "--flow", "walk"])).toBe(0);

    expect(err).toEqual([]);
    expect(children).toEqual([{ command: "/usr/bin/node", args: ["/engine/cli.js", "run", "42", "--flow", "walk"], cwd: b.repoRoot, env: { SOUS_ROOT: b.root } }]);
    expect(out).toEqual([`#42: running in b: /usr/bin/node /engine/cli.js run 42 --flow walk in ${b.repoRoot}`]);
    expect(sandboxRoots).toEqual([b.repoRoot]);
    expect(existsSync(lockPath(b.root, "42"))).toBe(false);
    expect(existsSync(join(home, "runs"))).toBe(false);

    const status: string[] = [];
    expect(await statusCommand(["42"], { root: b.root, out: (line) => status.push(line), err: (line) => status.push(line) })).toBe(0);
    expect(status.join("\n")).toContain("walk");
    expect(status.join("\n")).toContain(join(b.root, "runs", "42"));
  });

  it("refuses a number several trackers hold, naming the qualified form for each entry, and starts nothing", async () => {
    await listed("a");
    await listed("b");
    own("a").issues.set("42", issue({ id: "42", labels: ["type:task"] }));
    own("b").issues.set("42", issue({ id: "42", labels: ["type:task"] }));
    expect(await run(["42"])).toBe(2);
    expect(children).toEqual([]);
    expect(err).toEqual(["sous run: issue 42 is in several trackers; name the entry: sous run a#42, sous run b#42"]);
  });

  it("name#issue asks that entry's tracker alone and runs the issue as listed by it", async () => {
    const a = await listed("a");
    await listed("b");
    own("a").issues.set("42", issue({ id: "42", labels: ["type:task"] }));
    own("b").issues.set("42", issue({ id: "42", labels: ["type:task"] }));
    expect(await run(["a#42", "--flow", "walk"])).toBe(0);
    expect(children.map(({ args, cwd, env }) => ({ args, cwd, root: env["SOUS_ROOT"] }))).toEqual([{ args: ["/engine/cli.js", "run", "42", "--flow", "walk"], cwd: a.repoRoot, root: a.root }]);
  });

  it("name#issue naming no entry exits 2 naming the known entries; one whose tracker lacks the issue says so", async () => {
    const a = await listed("a");
    await listed("b");
    own("b").issues.set("42", issue({ id: "42", labels: ["type:task"] }));
    expect(await run(["zzz#42"])).toBe(2);
    expect(await run(["a#42"])).toBe(2);
    expect(children).toEqual([]);
    expect(err).toEqual(["sous run: zzz#42: zzz names no entry of repos: (a, b)", `sous run: a#42 is not in the tracker of a (local ${join(a.root, "issues")})`]);
  });

  it("exits 2 naming the trackers asked when none holds the issue, or every one holding it has it closed", async () => {
    const a = await listed("a");
    const b = await listed("b");
    const asked = `local ${join(a.root, "issues")}, local ${join(b.root, "issues")}`;
    expect(await run(["42"])).toBe(2);
    own("a").issues.set("42", issue({ id: "42", state: "closed", labels: ["type:task"] }));
    expect(await run(["42"])).toBe(2);
    expect(children).toEqual([]);
    expect(err).toEqual([`sous run: issue 42 is in none of the trackers asked (${asked})`, `sous run: issue 42 is closed wherever it is found (asked: ${asked})`]);
  });

  it("names the entries it could not ask when it finds the issue nowhere", async () => {
    const a = await listed("a");
    expect(await run(["42"])).toBe(2);
    expect(err).toEqual([`sous run: issue 42 is in none of the trackers asked (local ${join(a.root, "issues")}); not asked, as nothing runs there: b`]);
  });

  it("stops at a tracker that fails to answer, naming it and its error, instead of counting it as a miss", async () => {
    const a = await listed("a");
    await listed("b");
    own("b").issues.set("42", issue({ id: "42", labels: ["type:task"] }));
    own("a").getIssue = async () => {
      throw new Error("HTTP 503: Service Unavailable");
    };
    expect(await run(["42"])).toBe(2);
    expect(await run(["a#42"])).toBe(2);
    expect(children).toEqual([]);
    const failed = `sous run: issue 42: the tracker local ${join(a.root, "issues")} did not answer: HTTP 503: Service Unavailable`;
    expect(err).toEqual([failed, failed]);
  });

  it("counts a tracker module's own not-found error, by its code, as a miss", async () => {
    await listed("a");
    const b = await listed("b");
    own("b").issues.set("42", issue({ id: "42", labels: ["type:task"] }));
    own("a").getIssue = async () => {
      throw Object.assign(new Error("no such issue"), { code: "ISSUE_NOT_FOUND" });
    };
    expect(await run(["42"], { runChild: async (_command, _args, { cwd }) => (children.push({ command: "", args: [], cwd, env: {} }), 0) })).toBe(0);
    expect(children.map((c) => c.cwd)).toEqual([b.repoRoot]);
  });

  it("passes a closed copy over for the one open elsewhere", async () => {
    await listed("a");
    const b = await listed("b");
    own("a").issues.set("42", issue({ id: "42", state: "closed", labels: ["type:task"] }));
    own("b").issues.set("42", issue({ id: "42", labels: ["type:task"] }));
    expect(await run(["42"], { runChild: async (_command, _args, { cwd }) => (children.push({ command: "", args: [], cwd, env: {} }), 0) })).toBe(0);
    expect(children.map((c) => c.cwd)).toEqual([b.repoRoot]);
  });

  it("asks a tracker several entries share once, and runs its issue in the entry its repo: label names, the line naming the tracker", async () => {
    await listed("a", SHARED);
    const b = await listed("b", SHARED);
    shared().issues.set("42", issue({ id: "42", labels: ["type:task", "repo:b"] }));
    expect(await run(["42", "--flow", "walk"])).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([`#42: running in b (${join(dir, "planning")}): /usr/bin/node /engine/cli.js run 42 --flow walk in ${b.repoRoot}`]);
  });

  it("exits 2 with the daemon's skip reason for a shared tracker's issue without a repo: label, or naming no entry", async () => {
    await listed("a", SHARED);
    await listed("b", SHARED);
    shared().issues.set("7", issue({ id: "7", labels: ["type:task", "repo:zzz"] }));
    shared().issues.set("8", issue({ id: "8", labels: ["type:task"] }));
    expect(await run(["7"])).toBe(2);
    expect(await run(["8"])).toBe(2);
    expect(children).toEqual([]);
    expect(err).toEqual(["sous run: #7: repo:zzz names no entry of repos: (a, b)", `sous run: #8: tracker ${join(dir, "planning")} is shared; add repo:a or repo:b`]);
  });

  it("exits 2 when an unshared tracker's issue names another repository", async () => {
    await listed("a");
    await listed("b");
    own("a").issues.set("42", issue({ id: "42", labels: ["type:task", "repo:b"] }));
    expect(await run(["42"])).toBe(2);
    expect(err).toEqual(["sous run: #42: repo:b names another repository than a"]);
  });

  it("rejects --repo, naming the qualified form, before asking any tracker", async () => {
    await listed("a");
    await listed("b");
    expect(await run(["42", "--repo", "a"])).toBe(2);
    expect(children).toEqual([]);
    expect(err).toEqual(["sous run: --repo is gone; name the entry with the issue: sous run a#42\nusage: sous run <issue | name#issue> [--flow <name>] [--restart]"]);
  });

  it("runs an issue routed to the home repository itself in this process, never spawning itself again", async () => {
    await writeFile(join(home, "sous.yaml"), `engine: ^0.9.0\n${OWN}\nrepos: { planning: ., b: ../b }\n`);
    await listed("b");
    trackerAt(join(home, "issues")).issues.set("9", issue({ id: "9", labels: ["type:task"] }));
    const here: string[][] = [];
    const runHere = async (args: readonly string[]) => (here.push([...args]), 0);
    expect(await run(["9", "--flow", "walk"], { runHere })).toBe(0);
    expect(await run(["planning#9", "--restart"], { runHere })).toBe(0);
    expect(children).toEqual([]);
    expect(here).toEqual([
      ["9", "--flow", "walk"],
      ["9", "--restart"],
    ]);
  });

  it("passes the child's exit code on", async () => {
    await listed("b");
    own("b").issues.set("42", issue({ id: "42", labels: ["type:task"] }));
    expect(await run(["42"], { runChild: async () => 130 })).toBe(130);
  });

  it("exits 2 when the entry a shared issue names holds no .sous/sous.yaml", async () => {
    await listed("a", SHARED);
    shared().issues.set("42", issue({ id: "42", labels: ["type:task", "repo:b"] }));
    expect(await run(["42"])).toBe(2);
    expect(await run(["b#42"])).toBe(2);
    expect(children).toEqual([]);
    expect(err).toEqual([`sous run: b: ${join(dir, "b")} holds no .sous/sous.yaml`, `sous run: b: ${join(dir, "b")} holds no .sous/sous.yaml`]);
  });

  it("refuses an entry without engine: with the daemon's reason for it, starting nothing", async () => {
    await listed("a", SHARED);
    const b = await listed("b", SHARED);
    await writeFile(join(b.root, "sous.yaml"), `idleTimeoutSeconds: 60\n${SHARED}\n`);
    shared().issues.set("42", issue({ id: "42", labels: ["type:task", "repo:b"] }));
    expect(await run(["42"])).toBe(2);
    expect(children).toEqual([]);
    expect(err).toEqual([`sous run: b: ${b.repoRoot} states no engine: range in sous.yaml; add engine: ^0.9.1`]);
    expect((await watchReposOf(home, undefined, "0.9.1")).unrunnable).toContainEqual({ name: "b", reason: `${b.repoRoot} states no engine: range in sous.yaml; add engine: ^0.9.1; sous watch starts nothing there` });
  });

  it("refuses an entry whose engine: range this engine does not satisfy with the daemon's reason for it, starting nothing", async () => {
    await listed("a", SHARED);
    const b = await listed("b", SHARED);
    await writeFile(join(b.root, "sous.yaml"), `engine: ^0.8.0\nidleTimeoutSeconds: 60\n${SHARED}\n`);
    shared().issues.set("42", issue({ id: "42", labels: ["type:task", "repo:b"] }));
    expect(await run(["42"])).toBe(2);
    expect(await run(["b#42"])).toBe(2);
    expect(children).toEqual([]);
    const reason = `engine 0.9.1 does not satisfy engine: ^0.8.0 of ${b.repoRoot}; run it with an engine in that range or widen the range`;
    expect(err).toEqual([`sous run: b: ${reason}`, `sous run: b: ${reason}`]);
    expect((await watchReposOf(home, undefined, "0.9.1")).unrunnable).toContainEqual({ name: "b", reason: `${reason}; sous watch starts nothing there` });
  });
});

describe("sous run name#issue outside a home repository", () => {
  it("exits 2: there are no entries to name", async () => {
    const err: string[] = [];
    const code = await runCommand(["a#42"], {
      root: "/nowhere/.sous",
      repoRoot: "/nowhere",
      git: fakeGit(),
      tracker: fakeTracker(),
      openSandbox: async () => {
        throw new Error("never opened");
      },
      confirm: async () => false,
      out: () => undefined,
      err: (line) => err.push(line),
    });
    expect(code).toBe(2);
    expect(err).toEqual(["sous run: a#42 names an entry of repos:, and this repository's sous.yaml lists none; run sous run 42"]);
  });
});

/**
 * The real child of `sous run` in a home repository, driven through a real
 * `sous run` process: signals are sent to that process's pid alone, as `kill`
 * or a supervisor would, so the test runner's own handlers stay out of it.
 */
describe("runChildInTerminal", () => {
  const packageDir = fileURLToPath(new URL("../..", import.meta.url));
  const homerunModule = pathToFileURL(join(packageDir, "src", "commands", "homerun.ts")).href;
  let dir: string;
  let parent: ChildProcess | undefined;

  /** `sous run` handing `script` to `runChildInTerminal` as the child in `dir`, with `env`; its own environment has the home repository's SOUS_ROOT. */
  const startParent = (script: string, env: Record<string, string>): ChildProcess => {
    const main = `import { runChildInTerminal } from ${JSON.stringify(homerunModule)};
process.exitCode = await runChildInTerminal(process.execPath, ["-e", ${JSON.stringify(script)}], { cwd: ${JSON.stringify(dir)}, env: ${JSON.stringify(env)} });`;
    return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", main], {
      cwd: packageDir,
      env: { ...process.env, SOUS_ROOT: "/the/home/.sous", SOUS_HOMERUN_TEST: "kept" },
      stdio: "ignore",
    });
  };

  const exited = (child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
    new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  const appears = async (path: string): Promise<string> => {
    for (let waited = 0; waited < 10_000; waited += 25) {
      if (existsSync(path)) return readFile(path, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${path} never appeared`);
  };

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "sous-homerun-child-")));
  });

  afterEach(async () => {
    if (parent?.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    const pid = existsSync(join(dir, "pid")) ? Number(await readFile(join(dir, "pid"), "utf8")) : undefined;
    if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the child in the entry's checkout with the entry's SOUS_ROOT, never the home repository's, and exits with its code", async () => {
    const report = `require("node:fs").writeFileSync("seen", JSON.stringify({ cwd: process.cwd(), root: process.env.SOUS_ROOT ?? "unset", other: process.env.SOUS_HOMERUN_TEST })); process.exit(3);`;
    parent = startParent(report, { SOUS_ROOT: join(dir, ".sous") });
    expect(await exited(parent)).toEqual({ code: 3, signal: null });
    expect(JSON.parse(await readFile(join(dir, "seen"), "utf8"))).toEqual({ cwd: dir, root: join(dir, ".sous"), other: "kept" });

    // Handed no SOUS_ROOT, the child finds its project from its cwd instead of inheriting the home repository's.
    parent = startParent(report, {});
    expect(await exited(parent)).toEqual({ code: 3, signal: null });
    expect(JSON.parse(await readFile(join(dir, "seen"), "utf8"))).toMatchObject({ root: "unset" });
  });

  it("leaves a SIGINT to the run: sous run keeps waiting and exits with the run's code", async () => {
    const waitForGo = `const fs = require("node:fs"); process.on("SIGINT", () => undefined); fs.writeFileSync("pid", String(process.pid)); setInterval(() => { if (fs.existsSync("go")) process.exit(7); }, 25);`;
    parent = startParent(waitForGo, {});
    const done = exited(parent);
    await appears(join(dir, "pid"));
    parent.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(parent.pid!)).toBe(true);
    await writeFile(join(dir, "go"), "");
    expect(await done).toEqual({ code: 7, signal: null });
  });

  it("passes a SIGTERM sent to sous run alone on to the run, and exits 143 when the run ends by it", async () => {
    // No handler: the run is ended by the signal itself, so its exit code is the signal's.
    const runUntilStopped = `require("node:fs").writeFileSync("pid", String(process.pid)); setInterval(() => undefined, 1000);`;
    parent = startParent(runUntilStopped, {});
    const done = exited(parent);
    const pid = Number(await appears(join(dir, "pid")));
    parent.kill("SIGTERM");
    expect(await done).toEqual({ code: 143, signal: null });
    expect(alive(pid)).toBe(false);
  });
});
