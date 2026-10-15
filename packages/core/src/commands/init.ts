/**
 * `sous init`: copies a starter into `<repoRoot>/.sous/`, installs its
 * dependencies and puts the `/sous-plan` skill where Claude Code finds it,
 * so a new project begins from working flows instead of an empty folder.
 * The starter is copied, not linked: the project owns it from then on.
 * What stays manual is printed as a checklist, so nobody has to read the
 * manual to know what to adapt.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { exec as defaultExec, type Exec } from "../adapters/exec.js";
import { PROJECT_DIR } from "../root.js";

export const USAGE = "usage: sous init [--starter <dir>] [--force]";

/** What a run leaves behind and what `npm install` creates; never committed. */
export const GITIGNORE = "logs/\nruns/\nlocks/\nnode_modules/\n";

/** The skill as the starter ships it, and where Claude Code looks for it. */
export const SKILL_SOURCE = join("skills", "sous-plan");
export const SKILL_TARGET = join(".claude", "skills", "sous-plan");

/** What `sous init` cannot know about the project; printed once the files are in place. */
export const setupChecklist = (project: string): string[] => [
  "init: still to do by hand:",
  `  1. ${join(project, "steps", "verify", "eval.ts")}: set BASE_BRANCH and fill CHECKS (until then every verify passes with a WARN in the log)`,
  `  2. ${join(project, "sous.yaml")}: tracker, baseBranch, branch template, lifecycle`,
  `  3. ${join(project, "flows")}/*.yaml: agent models and allowedLabels; create the labels on the tracker (type:task, type:bug, type:feature)`,
  `  4. ${join(project, "prompts", "plan.md")}: follow its ADAPT notes (tracker beads: move plan.beads.md over it first)`,
  `  5. cd ${project} && ./sous validate && npx vitest run; then ./sous run bench <issue> as a smoke test`,
];

/** Folders a starter checkout may contain that a fresh project must not inherit. */
const SKIPPED = new Set(["node_modules", "logs", "runs", "locks", ".lock"]);

/** The starter bundled with the engine: `<package>/starter`, whether this file runs from `src/` or from `dist/src/`. */
export const defaultStarterDir = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = here.endsWith(join("dist", "src", "commands")) ? join(here, "..", "..", "..") : join(here, "..", "..");
  return join(pkg, "starter");
};

export type InitArgs = { starter?: string; force: boolean };

export const parseInitArgs = (args: readonly string[]): InitArgs | { error: string } => {
  let starter: string | undefined;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--force") force = true;
    else if (arg === "--starter") {
      starter = args[++i];
      if (starter === undefined || starter.startsWith("--")) return { error: `--starter needs a folder\n${USAGE}` };
    } else return { error: `unknown option ${String(arg)}\n${USAGE}` };
  }
  return { ...(starter !== undefined ? { starter } : {}), force };
};

export type InitDeps = {
  /** The repository the project folder goes into. */
  repoRoot: string;
  /** Replaces the bundled starter; tests point it at a temp folder. */
  defaultStarter?: string;
  exec?: Exec;
  out: (line: string) => void;
  err: (line: string) => void;
};

const isEmptyDir = async (dir: string): Promise<boolean> => !existsSync(dir) || (await readdir(dir)).length === 0;

export const initCommand = async (args: readonly string[], deps: InitDeps): Promise<number> => {
  const parsed = parseInitArgs(args);
  if ("error" in parsed) {
    deps.err(parsed.error);
    return 2;
  }
  const { repoRoot, exec = defaultExec, out, err } = deps;
  const starter = parsed.starter ?? deps.defaultStarter ?? defaultStarterDir();
  if (!existsSync(starter)) {
    err(`sous init: no starter at ${starter}; pass --starter <dir>`);
    return 2;
  }
  const target = join(repoRoot, PROJECT_DIR);
  if (!(await isEmptyDir(target)) && !parsed.force) {
    err(`sous init: ${target} is not empty; pass --force to copy over it`);
    return 1;
  }

  await cp(starter, target, { recursive: true, filter: (source) => !SKIPPED.has(relative(starter, source).split(/[\\/]/)[0] ?? "") });
  await writeFile(join(target, ".gitignore"), GITIGNORE, "utf8");
  out(`init: copied ${starter} to ${target}`);

  const skill = join(target, SKILL_SOURCE);
  if (existsSync(skill)) {
    const installed = join(repoRoot, SKILL_TARGET);
    await mkdir(dirname(installed), { recursive: true });
    await cp(skill, installed, { recursive: true });
    out(`init: installed the /sous-plan skill at ${installed}`);
  }

  // Last, so a registry hiccup leaves a complete project behind: rerun `npm install` in .sous/ and go on.
  const install = await exec("npm", ["install"], { cwd: target });
  const checklist = setupChecklist(relative(repoRoot, target));
  if (install.code !== 0) {
    err(`sous init: npm install failed in ${target} (exit ${install.code}); the project is in place, run it again there\n${install.stderr.trim()}`);
    for (const line of checklist) out(line);
    return 1;
  }
  out(`init: installed dependencies in ${target}`);
  for (const line of checklist) out(line);
  return 0;
};
