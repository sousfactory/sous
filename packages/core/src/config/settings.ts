/**
 * `sous.yaml`. Every key but `tracker` and `engine` has a default; those two
 * are required by the commands that need them (`run`, `watch`, `validate`),
 * so the run viewer and `sous status` read a project without them.
 * Every `*Dir` is relative to the project root (`.sous/`).
 */
import { resolve } from "node:path";
import { SousError } from "../exec/errors.js";
import { checkEngine } from "./engine.js";
import { checker, readYaml } from "./schema.js";

export type Settings = {
  baseBranch: string;
  branch: string;
  /** `<specsDir>/<issue>-<slug>/spec.md`; the only folder outside the project root by default. */
  specsDir: string;
  flowsDir: string;
  stepsDir: string;
  skillsDir: string;
  /** The shapes the prompts write: `spec.md`, `child.md`, `task.md`; `ctx.templatesDir` for the steps. */
  templatesDir: string;
  logsDir: string;
  runsDir: string;
  /** `core`: the run claims, blocks and closes its issue; `steps`: the core only reads the tracker and steps write what they need. A flow may override it. */
  lifecycle: "core" | "steps";
  idleTimeoutSeconds: number;
  /** The port `sous ui` listens on at 127.0.0.1; `--port` wins for one start. */
  uiPort: number;
  /**
   * Where this repository's issues live. Required, but checked by the
   * commands that build the tracker rather than here, as `engine` is.
   */
  tracker?: TrackerSettings;
  /** The repository's name in `repo:<name>` labels; unset, the `origin` remote's repository part, else the folder. */
  name?: string;
  /**
   * The repositories `sous watch` serves from this one, the home repository:
   * name to checkout path (relative to the repository root, absolute or `~`),
   * or a list of paths named by their folders. Each holds its own `.sous/`.
   */
  repos?: Record<string, string> | string[];
  /**
   * The semver range of engines these definitions were written for.
   * Required, but checked by the commands rather than here: `run`, `watch`
   * and `validate` refuse a missing key with the line to add, and the
   * settings of a repository written for a newer engine are never loaded.
   */
  engine?: string;
};

/**
 * The `tracker:` block. The location has no default: the github `repo` and
 * the local `dir` are written out, so nothing guesses from the checkout.
 */
export type TrackerSettings = {
  /**
   * `github`, `beads`, `local`, or the path (relative to the project root) of a
   * module whose default export builds the tracker (`TrackerFactory`), so a
   * tracker sous does not ship can be plugged in without forking the core.
   */
  type: string;
  /** Whether the tracker holds the issues of several repositories, not this one's alone. */
  shared: boolean;
  /** `sous` of `sous:running`, `sous:blocked` and the `sous:merged` a step sets. */
  labels: string;
  /** github: `owner/name` of the repository the issues live in. */
  repo?: string;
  /** local: the folder of the issue files, relative to the project root. */
  dir?: string;
  /** A module type takes whatever further keys it documents. */
  [key: string]: unknown;
};

/** What `sous init` writes when the checkout has no origin to read the repository from; refused until replaced. */
export const REPO_PLACEHOLDER = "owner/name";

/** The block as a string `tracker:` is refused with. */
export const TRACKER_BLOCK = `tracker: { type: github, repo: ${REPO_PLACEHOLDER}, shared: false, labels: sous }`;

export const DEFAULT_SETTINGS: Settings = {
  baseBranch: "main",
  branch: "feature/${{ issue.id }}-${{ slug }}",
  specsDir: "../specs",
  flowsDir: "flows",
  stepsDir: "steps",
  skillsDir: "skills",
  templatesDir: "templates",
  logsDir: "logs",
  runsDir: "runs",
  lifecycle: "core",
  idleTimeoutSeconds: 1800,
  uiPort: 4680,
};

export const SETTINGS_FILE = "sous.yaml";

const check = checker<Partial<Settings>>({
  type: "object",
  additionalProperties: false,
  properties: {
    baseBranch: { type: "string", minLength: 1 },
    branch: { type: "string", minLength: 1 },
    specsDir: { type: "string", minLength: 1 },
    flowsDir: { type: "string", minLength: 1 },
    stepsDir: { type: "string", minLength: 1 },
    skillsDir: { type: "string", minLength: 1 },
    templatesDir: { type: "string", minLength: 1 },
    logsDir: { type: "string", minLength: 1 },
    runsDir: { type: "string", minLength: 1 },
    lifecycle: { enum: ["core", "steps"] },
    idleTimeoutSeconds: { type: "integer", minimum: 1 },
    uiPort: { type: "integer", minimum: 1, maximum: 65535 },
    tracker: { type: "object" },
    name: { type: "string", minLength: 1 },
    repos: {},
    engine: { type: "string", minLength: 1 },
  },
});

/** Checked by hand rather than by schema: an `anyOf` of map and list words a wrong entry as three unrelated complaints. */
const checkRepos = (repos: unknown, file: string): void => {
  if (repos === undefined) return;
  const isMap = typeof repos === "object" && repos !== null && !Array.isArray(repos);
  if (!isMap && !Array.isArray(repos)) throw new SousError(`${file}: repos must be a map of name to path or a list of paths`);
  const entries: [string, unknown][] = Array.isArray(repos) ? repos.map((path, i) => [`repos[${i}]`, path]) : Object.entries(repos).map(([name, path]) => [`repos.${name}`, path]);
  for (const [key, path] of entries) if (typeof path !== "string" || path === "") throw new SousError(`${file}: ${key} must be a path, not ${JSON.stringify(path)}`);
};

/**
 * One message per key of the settings before the tracker block, naming the
 * key to type instead, so an existing project learns the move rather than
 * reading a schema error.
 */
const oldKeyRefusals = (doc: unknown): string[] => {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return [];
  const record = doc as Record<string, unknown>;
  const refusals: string[] = [];
  if (typeof record["tracker"] === "string") refusals.push(`tracker is now a block: ${TRACKER_BLOCK}`);
  if ("trackerOptions" in record) {
    const options = record["trackerOptions"];
    const keys = typeof options === "object" && options !== null && !Array.isArray(options) ? Object.keys(options) : [];
    if (keys.length === 0) refusals.push("trackerOptions is now the tracker block: tracker.<key>");
    for (const key of keys) refusals.push(`trackerOptions.${key} is now tracker.${key}`);
  }
  if ("labelPrefix" in record) refusals.push("labelPrefix is now tracker.labels");
  return refusals;
};

const OWNER_NAME = /^[\w.-]+\/[\w.-]+$/;

const REQUIRED: Record<string, string> = {
  type: "tracker.type is required: github, beads, local, or the path of a tracker module",
  shared: "tracker.shared is required: true when the tracker holds the issues of several repositories, false when it holds this one's alone",
  labels: "tracker.labels is required: the prefix of the sous:* labels, sous unless you chose another",
};

const LOCATION: Record<string, { key: string; message: string }> = {
  github: { key: "repo", message: "tracker.repo is required for github: the owner/name of the repository the issues live in" },
  local: { key: "dir", message: "tracker.dir is required for local: the folder of the issue files, relative to .sous/" },
};

/** Checked by hand rather than by schema, so a missing key is refused with what to write there. */
export const trackerProblems = (block: Record<string, unknown>): string[] => {
  const problems: string[] = [];
  for (const [key, message] of Object.entries(REQUIRED)) if (block[key] === undefined) problems.push(message);
  const nonEmpty = (key: string): void => {
    const value = block[key];
    if (value !== undefined && (typeof value !== "string" || value === "")) problems.push(`tracker.${key} must be a non-empty string`);
  };
  nonEmpty("type");
  nonEmpty("labels");
  if (block["shared"] !== undefined && typeof block["shared"] !== "boolean") problems.push("tracker.shared must be true or false");
  const location = typeof block["type"] === "string" ? LOCATION[block["type"]] : undefined;
  if (location === undefined) return problems;
  const value = block[location.key];
  if (value === undefined) return [...problems, location.message];
  nonEmpty(location.key);
  if (location.key === "repo" && value === REPO_PLACEHOLDER) problems.push(`${location.message}, not the ${REPO_PLACEHOLDER} placeholder`);
  else if (location.key === "repo" && typeof value === "string" && value !== "" && !OWNER_NAME.test(value)) problems.push(`tracker.repo must be owner/name, not "${value}"`);
  return problems;
};

/** The `tracker:` block of the settings read from `file`, refused when the file has none. */
export const requiredTracker = (settings: Pick<Settings, "tracker">, file: string): TrackerSettings => {
  if (settings.tracker === undefined) throw new SousError(`${file}: tracker is required: ${TRACKER_BLOCK}`);
  return settings.tracker;
};

/** `doc` is `null` for an empty file. */
export const parseSettings = (doc: unknown, file: string = SETTINGS_FILE): Settings => {
  const refusals = oldKeyRefusals(doc);
  if (refusals.length > 0) throw new SousError(`${file}: ${refusals.join("; ")}`);
  const settings = check(doc ?? {}, file);
  if (settings.tracker !== undefined) {
    const problems = trackerProblems(settings.tracker);
    if (problems.length > 0) throw new SousError(`${file}: ${problems.join("; ")}`);
  }
  checkRepos(settings.repos, file);
  // Only the range's form is checked here; whether this engine satisfies it is the command's call.
  if (settings.engine !== undefined) {
    const check = checkEngine("0.0.0", settings.engine, file);
    if (check.kind === "invalid") throw new SousError(`${file}: ${check.message}`);
  }
  return { ...DEFAULT_SETTINGS, ...settings };
};

export const loadSettings = (file: string): Settings => parseSettings(readYaml(file, true), file);

export type ProjectDirs = Record<"specs" | "flows" | "steps" | "skills" | "templates" | "logs" | "runs", string>;

export const projectDirs = (root: string, settings: Settings): ProjectDirs => ({
  specs: resolve(root, settings.specsDir),
  flows: resolve(root, settings.flowsDir),
  steps: resolve(root, settings.stepsDir),
  skills: resolve(root, settings.skillsDir),
  templates: resolve(root, settings.templatesDir),
  logs: resolve(root, settings.logsDir),
  runs: resolve(root, settings.runsDir),
});
