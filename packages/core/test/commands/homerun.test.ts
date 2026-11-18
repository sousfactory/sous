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
import { answer, execRoot, fakeClock } from "../fakes/executor.js";
import { fakeGit } from "../fakes/git.js";
import { fakeSandbox } from "../fakes/sandbox.js";
import { fakeTracker, issue, type FakeTracker } from "../fakes/tracker.js";

/** The running engine's CLI, as `sous run` in the home repository is handed it. */
const ENGINE = ["/usr/bin/node", "/engine/cli.js"];

describe("sous run in a home repository", () => {
  let dir: string;
  let home: string;
  let tracker: FakeTracker;
  let out: string[];
  let err: string[];
  /** Every child started: its command line, cwd and the environment it was given. */
  let children: { command: string; args: string[]; cwd: string; env: Record<string, string> }[];
  /** Where each run opened its worktree. */
  let sandboxRoots: string[];

  /** A listed repository `name` beside the home one: its `.sous/` holds definitions only, no wrapper, no `node_modules`. */
  const listed = async (name: string): Promise<{ repoRoot: string; root: string }> => {
    const repoRoot = join(dir, name);
    const root = join(repoRoot, ".sous");
    await cp(execRoot, root, { recursive: true });
    await writeFile(join(root, "sous.yaml"), "engine: ^0.9.0\nidleTimeoutSeconds: 60\n");
    // As the workspace root: without it tsx would load the copied step modules as CommonJS.
    await writeFile(join(repoRoot, "package.json"), '{ "type": "module" }\n');
    return { repoRoot, root };
  };

  /** The child the engine's CLI would be: `sous run` with the project `SOUS_ROOT` names, in the cwd it was given. */
  const engineChild: RunChild = async (command, args, { cwd, env }) => {
    children.push({ command, args: [...args], cwd, env: { ...env } });
    const git = fakeGit();
    const openSandbox: OpenSandbox = async (options) => {
      sandboxRoots.push(options.repoRoot);
      return fakeSandbox({ worktreePath: join(options.repoRoot, ".sous", "worktrees", "wt"), branch: options.branch, agent: [answer("w1")] });
    };
    const [, ...runArgs] = args.slice(ENGINE.length - 1);
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

  const deps = (overrides: Partial<HomeRunDeps> = {}): HomeRunDeps => ({
    root: home,
    tracker,
    engine: ENGINE,
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
    tracker = fakeTracker({ issues: [issue({ id: "42", title: "Cap asset slug length", labels: ["type:task", "repo:b"] })] });
    out = [];
    err = [];
    children = [];
    sandboxRoots = [];
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("runs the issue in the entry its repo: label names, on the running engine, with lock, record and worktree there", async () => {
    await listed("a");
    const b = await listed("b");
    expect(await homeRunCommand(["42", "--flow", "walk"], deps())).toBe(0);

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

  it("runs an issue routed to the home repository itself in this process, never spawning itself again", async () => {
    await writeFile(join(home, "sous.yaml"), "repos: { planning: ., b: ../b }\n");
    tracker.issues.set("9", issue({ id: "9", labels: ["type:task", "repo:planning"] }));
    const here: string[][] = [];
    const runHere = async (args: readonly string[]) => (here.push([...args]), 0);
    expect(await homeRunCommand(["9", "--flow", "walk"], deps({ runHere }))).toBe(0);
    expect(await homeRunCommand(["9", "--repo", "planning", "--restart"], deps({ runHere }))).toBe(0);
    expect(children).toEqual([]);
    expect(here).toEqual([
      ["9", "--flow", "walk"],
      ["9", "--restart"],
    ]);
  });

  it("passes the child's exit code on", async () => {
    await listed("b");
    expect(await homeRunCommand(["42"], deps({ runChild: async () => 130 }))).toBe(130);
  });

  it("exits 2 with the daemon's message when the issue names no entry, or carries no repo: label", async () => {
    tracker.issues.set("7", issue({ id: "7", labels: ["type:task", "repo:zzz"] }));
    tracker.issues.set("8", issue({ id: "8", labels: ["type:task"] }));
    expect(await homeRunCommand(["7"], deps())).toBe(2);
    expect(await homeRunCommand(["8"], deps())).toBe(2);
    expect(children).toEqual([]);
    expect(err).toEqual(["sous run: #7: repo:zzz names no entry of repos: (a, b)", "sous run: #8: no repo:* label names its repository"]);
  });

  it("--repo runs in the entry it names, whatever the label says", async () => {
    const a = await listed("a");
    expect(await homeRunCommand(["42", "--repo", "a", "--flow", "walk"], deps())).toBe(0);
    expect(children.map(({ args, cwd, env }) => ({ args, cwd, root: env["SOUS_ROOT"] }))).toEqual([{ args: ["/engine/cli.js", "run", "42", "--flow", "walk"], cwd: a.repoRoot, root: a.root }]);
  });

  it("--repo naming no entry exits 2 naming the known entries, before asking the tracker", async () => {
    tracker.issues.clear();
    expect(await homeRunCommand(["42", "--repo", "zzz"], deps())).toBe(2);
    expect(children).toEqual([]);
    expect(err).toEqual(["sous run: --repo zzz names no entry of repos: (a, b)"]);
  });

  it("exits 2 when the entry holds no .sous/sous.yaml", async () => {
    expect(await homeRunCommand(["42"], deps())).toBe(2);
    expect(children).toEqual([]);
    expect(err).toEqual([`sous run: b: ${join(dir, "b")} holds no .sous/sous.yaml`]);
  });
});

describe("sous run --repo outside a home repository", () => {
  it("exits 2: there are no entries to name", async () => {
    const err: string[] = [];
    const code = await runCommand(["42", "--repo", "a"], {
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
    expect(err).toEqual(["sous run: --repo names an entry of repos:, and this repository's sous.yaml lists none"]);
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
