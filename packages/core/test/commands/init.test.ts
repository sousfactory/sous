import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "../../src/adapters/exec.js";
import { defaultStarterDir, engineLine, GITIGNORE, initCommand, parseInitArgs, setupChecklist, SKILL_TARGET } from "../../src/commands/init.js";
import { homeRunCommand, type RunChild } from "../../src/commands/homerun.js";
import { createWatcher, watchReposOf, type Spawn } from "../../src/commands/watch.js";
import { validateProject } from "../../src/config/validate.js";
import { fakeTracker, issue } from "../fakes/tracker.js";
import { fixture, io } from "../helpers.js";

/** The running engine's CLI, as the home repository's commands are handed it. */
const ENGINE = ["/usr/bin/node", "/engine/cli.js"];

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };

/** A starter with the fixture project's flows and steps plus a skill, and leftovers a copy must skip. */
const starterOf = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "sous-starter-"));
  await cp(fixture("project"), dir, { recursive: true });
  for (const [skill, text] of [["sous-plan", "# plan\n"], ["tdd", "# vendored\n"]] as const) {
    await mkdir(join(dir, "skills", skill), { recursive: true });
    await writeFile(join(dir, "skills", skill, "SKILL.md"), text, "utf8");
  }
  await writeFile(join(dir, "package.json"), '{ "name": "starter" }\n', "utf8");
  await writeFile(join(dir, "sous"), "#!/usr/bin/env bash\nexec npx sous \"$@\"\n", "utf8");
  for (const leftover of ["node_modules/x", "logs/1", "runs/1"]) {
    await mkdir(join(dir, leftover), { recursive: true });
    await writeFile(join(dir, leftover, "junk"), "", "utf8");
  }
  return dir;
};

const setup = async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "sous-repo-"));
  const calls: { command: string; args: string[]; cwd?: string }[] = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ command, args: [...args], ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}) });
    return ok;
  };
  const lines = io();
  return { repoRoot, calls, exec, ...lines, deps: { repoRoot, exec, engineVersion: "0.9.0", ...lines.deps } };
};

describe("parseInitArgs", () => {
  it("takes --starter <dir>, --force, --no-install and one path, nothing else", () => {
    expect(parseInitArgs([])).toEqual({ force: false, install: true });
    expect(parseInitArgs(["--starter", "/s", "--force"])).toEqual({ starter: "/s", force: true, install: true });
    expect(parseInitArgs(["--no-install", "../api"])).toEqual({ force: false, install: false, path: "../api" });
    expect(parseInitArgs(["../api", "../web"])).toMatchObject({ error: expect.stringContaining("one path at most") });
    expect(parseInitArgs(["--starter"])).toMatchObject({ error: expect.stringContaining("--starter needs a folder") });
    expect(parseInitArgs(["--starter", "--force"])).toMatchObject({ error: expect.stringContaining("--starter needs a folder") });
    expect(parseInitArgs(["-x"])).toMatchObject({ error: expect.stringContaining("unknown option -x") });
  });

  it("looks for the bundled starter next to the package", () => {
    expect(defaultStarterDir()).toMatch(/packages\/core\/starter$/);
  });
});

describe("setupChecklist", () => {
  it("names the four files to adapt and the checks to run", () => {
    const lines = setupChecklist(".sous");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("init: still to do by hand:");
    expect(lines[1]).toContain(".sous/steps/verify/eval.ts: fill CHECKS (until then every verify passes with a WARN in the log)");
    expect(lines[1]).not.toContain("BASE_BRANCH");
    expect(lines[2]).toContain(".sous/sous.yaml: tracker, baseBranch, branch template, lifecycle");
    expect(lines[2]).toContain("engine: names the engines these definitions run on");
    expect(lines[3]).toContain(".sous/flows/*.yaml: agent models and allowedLabels");
    expect(lines[3]).toContain("type:task, type:bug, type:feature");
    expect(lines[4]).toContain(".sous/prompts/plan.md: follow its ADAPT notes");
    expect(lines[4]).toContain("trackers/<tracker>.md");
    expect(lines[5]).toContain("cd .sous && ./sous validate && npx vitest run");
    expect(lines[5]).toContain("./sous run <issue> --flow bench");
  });
});


describe("initCommand", () => {
  it("copies the starter into .sous/ without its leftovers, writes the gitignore, installs, places the skill and prints the checklist; the result validates", async () => {
    const starter = await starterOf();
    const s = await setup();
    expect(await initCommand(["--starter", starter], s.deps)).toBe(0);

    const root = join(s.repoRoot, ".sous");
    expect(await readFile(join(root, "sous.yaml"), "utf8")).toBe((await readFile(join(starter, "sous.yaml"), "utf8")).replace('engine: ">=0.1.0"', engineLine("0.9.0")));
    expect(existsSync(join(root, "flows", "good.yaml"))).toBe(true);
    expect(existsSync(join(root, "steps", "build", "step.yaml"))).toBe(true);
    for (const skipped of ["node_modules", "logs", "runs"]) expect(existsSync(join(root, skipped)), `${skipped} not copied`).toBe(false);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(GITIGNORE);
    expect(existsSync(join(root, "sous")), "the wrapper").toBe(true);
    expect(s.calls).toEqual([{ command: "npm", args: ["install"], cwd: root }]);
    expect(await readFile(join(s.repoRoot, SKILL_TARGET, "SKILL.md"), "utf8")).toBe("# plan\n");
    expect(existsSync(join(s.repoRoot, ".claude", "skills", "tdd"))).toBe(false);
    expect(s.out.slice(-6)).toEqual(setupChecklist(".sous"));
    expect(validateProject(root).errors).toEqual([]);
  });

  it("--no-install writes the definitions and engine: but no wrapper, installs nothing, and says what package.json is for", async () => {
    const starter = await starterOf();
    const s = await setup();
    expect(await initCommand(["--no-install", "--starter", starter], s.deps)).toBe(0);

    const root = join(s.repoRoot, ".sous");
    for (const kept of ["flows", "steps", "package.json", ".gitignore", join("skills", "tdd", "SKILL.md")]) expect(existsSync(join(root, kept)), kept).toBe(true);
    expect(await readFile(join(root, "sous.yaml"), "utf8")).toContain(engineLine("0.9.0"));
    expect(await readFile(join(root, ".gitignore"), "utf8")).toContain("node_modules/");
    expect(existsSync(join(root, "sous")), "no wrapper").toBe(false);
    expect(existsSync(join(root, "node_modules")), "no node_modules").toBe(false);
    expect(s.calls).toEqual([]);
    const checklist = s.out.join("\n");
    expect(checklist).toContain(".sous/package.json: serves the editor and the project's tests");
    expect(checklist).not.toContain("./sous");
    expect(checklist).not.toContain("repos:");
    expect(validateProject(root).errors).toEqual([]);
  });

  it("--no-install <path> initialises that repository and names the repos: entry to add here", async () => {
    const starter = await starterOf();
    const s = await setup();
    const api = await mkdtemp(join(tmpdir(), "sous-api-"));
    expect(await initCommand(["--no-install", "--starter", starter, api], s.deps)).toBe(0);

    expect(existsSync(join(api, ".sous", "flows", "good.yaml"))).toBe(true);
    expect(existsSync(join(api, ".sous", "sous"))).toBe(false);
    expect(existsSync(join(s.repoRoot, ".sous"))).toBe(false);
    const name = basename(api);
    expect(s.out).toContain(`  add to .sous/sous.yaml here, the home repository: repos: { ${name}: ${relative(s.repoRoot, api)} }`);
    expect(s.out.join("\n")).toContain(`sous run <issue> --repo ${name} --flow bench`);
  });

  it("a repository initialised with --no-install is run by the home repository's engine, from sous watch and from sous run there", async () => {
    const starter = await starterOf();
    await writeFile(join(starter, "sous.yaml"), "tracker: local\ntrackerOptions: { dir: issues }\n", "utf8");
    await writeFile(join(starter, "flows", "task.yaml"), `allowedLabels: [type:task]\n${await readFile(join(starter, "flows", "good.yaml"), "utf8")}`, "utf8");
    const dir = await mkdtemp(join(tmpdir(), "sous-served-"));
    const home = join(dir, "home", ".sous");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "sous.yaml"), "repos: { api: ../api }\n", "utf8");
    const s = await setup();
    expect(await initCommand(["--no-install", "--starter", starter, "../api"], { ...s.deps, repoRoot: join(dir, "home"), cwd: join(dir, "home") })).toBe(0);
    const api = { repoRoot: join(dir, "api"), root: join(dir, "api", ".sous") };

    const tracker = fakeTracker({ issues: [issue({ id: "7", labels: ["type:task", "repo:api", "sous:ready"] })] });
    const built = await watchReposOf(home, undefined, "0.9.0");
    expect(built.unrunnable).toEqual([]);
    const children: { command: string; args: string[]; cwd: string; env?: Record<string, string> }[] = [];
    const spawn: Spawn = (command, args, { cwd, env }) => {
      children.push({ command, args: [...args], cwd, ...(env !== undefined ? { env } : {}) });
      return { pid: 1000, exited: new Promise(() => undefined), kill: () => undefined };
    };
    const watcher = createWatcher({ root: home, ...built, repos: built.repos.map((r) => ({ ...r, tracker })), engine: ENGINE, spawn, engineVersion: "0.9.0", isAlive: () => false, out: () => undefined, err: () => undefined });
    await watcher.pass();

    const ran: { command: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
    const runChild: RunChild = async (command, args, { cwd, env }) => (ran.push({ command, args: [...args], cwd, env }), 0);
    const homeRun = { root: home, tracker, engine: ENGINE, runChild, runHere: async () => 1, out: () => undefined, err: () => undefined };
    expect(await homeRunCommand(["7", "--flow", "task"], homeRun)).toBe(0);

    const started = { command: "/usr/bin/node", args: ["/engine/cli.js", "run", "7", "--flow", "task"], cwd: api.repoRoot, env: { SOUS_ROOT: api.root } };
    expect(children).toEqual([started]);
    expect(ran).toEqual([started]);
  });

  it("refuses a non-empty .sous/ unless --force, and names a missing starter", async () => {
    const starter = await starterOf();
    const s = await setup();
    await mkdir(join(s.repoRoot, ".sous"), { recursive: true });
    await writeFile(join(s.repoRoot, ".sous", "keep.txt"), "x", "utf8");
    expect(await initCommand(["--starter", starter], s.deps)).toBe(1);
    expect(s.err[0]).toMatch(/\.sous is not empty; pass --force/);
    expect(s.calls).toEqual([]);
    expect(await initCommand(["--starter", starter, "--force"], s.deps)).toBe(0);
    expect(existsSync(join(s.repoRoot, ".sous", "keep.txt"))).toBe(true);
    expect(existsSync(join(s.repoRoot, ".sous", "sous.yaml"))).toBe(true);

    const fresh = await setup();
    expect(await initCommand([], { ...fresh.deps, defaultStarter: join(fresh.repoRoot, "nowhere") })).toBe(2);
    expect(fresh.err[0]).toMatch(/sous init: no starter at .*nowhere; pass --starter <dir>/);
  });

  it("writes engine: as a caret on the exact version of the engine that ran it, whatever the starter's sous.yaml holds", async () => {
    expect(engineLine("0.9.0")).toMatch(/^engine: \^0\.9\.0 +# /);
    const commented = await mkdtemp(join(tmpdir(), "sous-commented-"));
    await writeFile(join(commented, "sous.yaml"), "# settings\n\nbaseBranch: main\n", "utf8");
    const s = await setup();
    expect(await initCommand(["--starter", commented], { ...s.deps, engineVersion: "1.2.3-rc.1" })).toBe(0);
    expect(await readFile(join(s.repoRoot, ".sous", "sous.yaml"), "utf8")).toBe(`# settings\n\n${engineLine("1.2.3-rc.1")}\nbaseBranch: main\n`);
    expect(engineLine("1.2.3-rc.1")).toMatch(/^engine: \^1\.2\.3-rc\.1 +# /);

    const none = await mkdtemp(join(tmpdir(), "sous-none-"));
    const t = await setup();
    expect(await initCommand(["--starter", none], t.deps)).toBe(0);
    expect(await readFile(join(t.repoRoot, ".sous", "sous.yaml"), "utf8")).toBe(`${engineLine("0.9.0")}\n`);
  });

  it("skips the skill when the starter has none and reports a failed install", async () => {
    const bare = await mkdtemp(join(tmpdir(), "sous-bare-"));
    await writeFile(join(bare, "sous.yaml"), "", "utf8");
    const s = await setup();
    expect(await initCommand(["--starter", bare], s.deps)).toBe(0);
    expect(existsSync(join(s.repoRoot, ".claude"))).toBe(false);

    const failing = await setup();
    const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "npm ERR! boom" });
    expect(await initCommand(["--starter", bare], { ...failing.deps, exec })).toBe(1);
    expect(failing.err[0]).toMatch(/npm install failed in .*\.sous \(exit 1\); the project is in place.*\nnpm ERR! boom/);
    // The files are there, so the checklist still applies.
    expect(failing.out.slice(-6)).toEqual(setupChecklist(".sous"));
  });
});
