import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "../../src/adapters/exec.js";
import { defaultStarterDir, GITIGNORE, initCommand, parseInitArgs, setupChecklist, SKILL_TARGET } from "../../src/commands/init.js";
import { validateProject } from "../../src/config/validate.js";
import { fixture, io } from "../helpers.js";

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
  return { repoRoot, calls, exec, ...lines, deps: { repoRoot, exec, ...lines.deps } };
};

describe("parseInitArgs", () => {
  it("takes --starter <dir> and --force, nothing else", () => {
    expect(parseInitArgs([])).toEqual({ force: false });
    expect(parseInitArgs(["--starter", "/s", "--force"])).toEqual({ starter: "/s", force: true });
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
    expect(lines[1]).toContain(".sous/steps/verify/eval.ts: set BASE_BRANCH and fill CHECKS");
    expect(lines[2]).toContain(".sous/sous.yaml: tracker, baseBranch, branch template, lifecycle");
    expect(lines[3]).toContain(".sous/flows/*.yaml: agent models and allowedLabels");
    expect(lines[3]).toContain("type:task, type:bug, type:feature");
    expect(lines[4]).toContain(".sous/prompts/plan.md: follow its ADAPT notes");
    expect(lines[4]).toContain("plan.beads.md");
    expect(lines[5]).toContain("cd .sous && ./sous validate && npx vitest run");
    expect(lines[5]).toContain("./sous run bench <issue>");
  });
});


describe("initCommand", () => {
  it("copies the starter into .sous/ without its leftovers, writes the gitignore, installs, places the skill and prints the checklist; the result validates", async () => {
    const starter = await starterOf();
    const s = await setup();
    expect(await initCommand(["--starter", starter], s.deps)).toBe(0);

    const root = join(s.repoRoot, ".sous");
    expect(await readFile(join(root, "sous.yaml"), "utf8")).toBe(await readFile(join(starter, "sous.yaml"), "utf8"));
    expect(existsSync(join(root, "flows", "good.yaml"))).toBe(true);
    expect(existsSync(join(root, "steps", "build", "step.yaml"))).toBe(true);
    for (const skipped of ["node_modules", "logs", "runs"]) expect(existsSync(join(root, skipped)), `${skipped} not copied`).toBe(false);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(GITIGNORE);
    expect(s.calls).toEqual([{ command: "npm", args: ["install"], cwd: root }]);
    expect(await readFile(join(s.repoRoot, SKILL_TARGET, "SKILL.md"), "utf8")).toBe("# plan\n");
    expect(existsSync(join(s.repoRoot, ".claude", "skills", "tdd"))).toBe(false);
    expect(s.out.slice(-6)).toEqual(setupChecklist(".sous"));
    expect(validateProject(root).errors).toEqual([]);
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
