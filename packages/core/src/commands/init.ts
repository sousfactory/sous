/**
 * `sous init`: copies a starter into `<repoRoot>/.sous/`, installs its
 * dependencies and puts the `/sous-plan` skill where Claude Code finds it,
 * so a new project begins from working flows instead of an empty folder.
 * The starter is copied, not linked: the project owns it from then on.
 * What stays manual is printed as a checklist, so nobody has to read the
 * manual to know what to adapt.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exec as defaultExec, type Exec } from "../adapters/exec.js";
import { ENGINE_VERSION, initialRange } from "../config/engine.js";
import { originRepoOf } from "../config/repos.js";
import { REPO_PLACEHOLDER, SETTINGS_FILE } from "../config/settings.js";
import { PROJECT_DIR } from "../root.js";

export const USAGE = "usage: sous init [--starter <dir>] [--force] [--no-install] [<path>]";

/** The starter's wrapper around the installed engine; `--no-install` leaves it out, since no engine is installed beside it. */
export const WRAPPER = "sous";

/** What a run leaves behind and what `npm install` creates; never committed. */
export const GITIGNORE = "logs/\nruns/\nlocks/\nworktrees/\nnode_modules/\n";

/** The skill as the starter ships it, and where Claude Code looks for it. */
export const SKILL_SOURCE = join("skills", "sous-plan");
export const SKILL_TARGET = join(".claude", "skills", "sous-plan");

/**
 * A definitions-only project (`--no-install`): the repository's name in
 * `repo:<name>` labels, and the `repos:` entry the home repository adds for
 * it when init ran from there (`undefined` when it ran in the repository).
 */
export type Served = { name: string; entry?: string };

/** What `sous init` cannot know about the project; printed once the files are in place. */
export const setupChecklist = (project: string, served?: Served): string[] => [
  "init: still to do by hand:",
  `  1. ${join(project, "steps", "verify", "eval.ts")}: fill CHECKS (until then every verify passes with a WARN in the log)`,
  `  2. ${join(project, "sous.yaml")}: tracker, baseBranch, branch template, lifecycle; engine: names the engines these definitions run on`,
  `  3. ${join(project, "flows")}/*.yaml: agent models and allowedLabels; create the labels on the tracker (type:task, type:bug, type:feature)`,
  `  4. ${join(project, "prompts", "plan.md")}: follow its ADAPT notes; it speaks to the tracker through ${join(project, "trackers", "<tracker>.md")} and writes the shapes in ${join(project, "templates")}/`,
  ...(served === undefined
    ? [`  5. cd ${project} && ./sous validate && npx vitest run; then ./sous run <issue> --flow bench as a smoke test`]
    : [
        `  5. SOUS_ROOT=${project} sous validate; then, in the home repository, sous run ${served.name}#<issue> --flow bench as a smoke test`,
        `  ${join(project, "package.json")}: serves the editor and the project's tests (npm install there, then npx vitest run); runs need no install here`,
        ...(served.entry !== undefined ? [`  add to ${join(PROJECT_DIR, SETTINGS_FILE)} here, the home repository: repos: { ${served.name}: ${served.entry} }`] : []),
      ]),
];

/** The `engine:` line `sous init` writes, aligned with the starter's commented settings. */
export const engineLine = (version: string): string => `${`engine: ${initialRange(version)}`.padEnd(50)}# the engines these definitions are written for; others refuse them`;

/**
 * `text` (a `sous.yaml`) with `engine:` stating the engine that ran init: an
 * existing line replaced, else the line put first among the settings, after
 * the leading comments.
 */
const withEngine = (text: string, version: string): string => {
  const line = engineLine(version);
  if (/^engine:.*$/m.test(text)) return text.replace(/^engine:.*$/m, line);
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const first = lines.findIndex((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
  lines.splice(first === -1 ? lines.length : first, 0, line);
  return `${lines.join("\n")}\n`;
};

/** The `tracker:` block `sous init` writes when the starter's `sous.yaml` has none: github at `repo`, written out so it is visible. */
export const trackerBlock = (repo: string): string =>
  [
    ["tracker:", "where this repository's issues live; no key has a default"],
    ["  type: github", "github, beads, local, or the path of a project module (see README)"],
    [`  repo: ${repo}`, "github: owner/name of the repository the issues live in; local takes dir:, beads nothing"],
    ["  shared: false", "true when the tracker holds the issues of several repositories"],
    ["  labels: sous", "sous:running / sous:blocked set by the run, sous:merged by the merge step"],
  ]
    .map(([setting = "", comment = ""]) => `${setting.padEnd(50)}# ${comment}\n`)
    .join("");

/**
 * `text` (a `sous.yaml`) with its `tracker:` block addressing `repo`: the
 * block appended when there is none, the `owner/name` placeholder of a
 * starter's block replaced. A block naming any other location is the
 * starter's choice and stays.
 */
const withTracker = (text: string, repo: string): string => {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const start = lines.findIndex((l) => /^tracker:/.test(l));
  if (start === -1) return `${lines.map((l) => `${l}\n`).join("")}${trackerBlock(repo)}`;
  const after = lines.findIndex((l, i) => i > start && l.trim() !== "" && !/^\s/.test(l));
  const end = after === -1 ? lines.length : after;
  const placeholder = new RegExp(`(\\brepo:\\s*)${REPO_PLACEHOLDER}\\b`);
  for (let i = start; i < end; i++) lines[i] = (lines[i] ?? "").replace(placeholder, `$1${repo}`);
  return `${lines.join("\n")}\n`;
};

/** Folders a starter checkout may contain that a fresh project must not inherit. */
const SKIPPED = new Set(["node_modules", "logs", "runs", "locks", ".lock"]);

/** The starter bundled with the engine: `<package>/starter`, whether this file runs from `src/` or from `dist/src/`. */
export const defaultStarterDir = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = here.endsWith(join("dist", "src", "commands")) ? join(here, "..", "..", "..") : join(here, "..", "..");
  return join(pkg, "starter");
};

/** `path`: the repository to initialise, when not the current one. */
export type InitArgs = { starter?: string; force: boolean; install: boolean; path?: string };

export const parseInitArgs = (args: readonly string[]): InitArgs | { error: string } => {
  let starter: string | undefined;
  let path: string | undefined;
  let force = false;
  let install = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--force") force = true;
    else if (arg === "--no-install") install = false;
    else if (arg === "--starter") {
      starter = args[++i];
      if (starter === undefined || starter.startsWith("--")) return { error: `--starter needs a folder\n${USAGE}` };
    } else if (arg !== undefined && !arg.startsWith("-")) {
      if (path !== undefined) return { error: `one path at most, got ${path} and ${arg}\n${USAGE}` };
      path = arg;
    } else return { error: `unknown option ${String(arg)}\n${USAGE}` };
  }
  return { ...(starter !== undefined ? { starter } : {}), force, install, ...(path !== undefined ? { path } : {}) };
};

export type InitDeps = {
  /** The repository the command runs in: the project folder goes here unless a path names another. */
  repoRoot: string;
  /** What a path argument is relative to; `repoRoot` unless set. */
  cwd?: string;
  /** Replaces the bundled starter; tests point it at a temp folder. */
  defaultStarter?: string;
  exec?: Exec;
  /** The version `engine:` is written for; the running engine's unless a test sets it. */
  engineVersion?: string;
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
  const { exec = defaultExec, out, err } = deps;
  const repoRoot = parsed.path !== undefined ? resolve(deps.cwd ?? deps.repoRoot, parsed.path) : deps.repoRoot;
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

  const skipped = (source: string): boolean => {
    const rel = relative(starter, source);
    return SKIPPED.has(rel.split(/[\\/]/)[0] ?? "") || (!parsed.install && rel === WRAPPER);
  };
  await cp(starter, target, { recursive: true, filter: (source) => !skipped(source) });
  await writeFile(join(target, ".gitignore"), GITIGNORE, "utf8");
  const settingsFile = join(target, SETTINGS_FILE);
  const settings = existsSync(settingsFile) ? await readFile(settingsFile, "utf8") : "";
  // Read once, here: a run never falls back to the origin, so the block says where the issues live.
  const origin = await originRepoOf(repoRoot, exec);
  await writeFile(settingsFile, withTracker(withEngine(settings, deps.engineVersion ?? ENGINE_VERSION), origin ?? REPO_PLACEHOLDER), "utf8");
  out(`init: copied ${starter} to ${target}`);

  const skill = join(target, SKILL_SOURCE);
  if (existsSync(skill)) {
    const installed = join(repoRoot, SKILL_TARGET);
    await mkdir(dirname(installed), { recursive: true });
    await cp(skill, installed, { recursive: true });
    out(`init: installed the /sous-plan skill at ${installed}`);
  }

  // A path argument's project as typed from where init ran, so the checklist reads right in that shell.
  const project = relative(parsed.path !== undefined ? (deps.cwd ?? deps.repoRoot) : repoRoot, target);
  if (origin === undefined && (await readFile(settingsFile, "utf8")).includes(REPO_PLACEHOLDER)) {
    out(`init: the checkout has no origin; set tracker.repo in ${join(project, SETTINGS_FILE)} to the owner/name of the repository the issues live in`);
  }
  if (!parsed.install) {
    const entry = resolve(repoRoot) === resolve(deps.repoRoot) ? undefined : relative(deps.repoRoot, repoRoot);
    for (const line of setupChecklist(project, { name: basename(repoRoot), ...(entry !== undefined ? { entry } : {}) })) out(line);
    return 0;
  }

  // Last, so a registry hiccup leaves a complete project behind: rerun `npm install` in .sous/ and go on.
  const install = await exec("npm", ["install"], { cwd: target });
  const checklist = setupChecklist(project);
  if (install.code !== 0) {
    err(`sous init: npm install failed in ${target} (exit ${install.code}); the project is in place, run it again there\n${install.stderr.trim()}`);
    for (const line of checklist) out(line);
    return 1;
  }
  out(`init: installed dependencies in ${target}`);
  for (const line of checklist) out(line);
  return 0;
};
