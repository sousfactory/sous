/**
 * `sous.yaml`. Every key has a default, so a project may have no file at all.
 * Every `*Dir` is relative to the project root (`.sous/`).
 */
import { resolve } from "node:path";
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
  /** `sous` of `sous:running`, `sous:blocked` and the `sous:merged` a step sets. */
  labelPrefix: string;
  /** `core`: the run claims, blocks and closes its issue; `steps`: the core only reads the tracker and steps write what they need. A flow may override it. */
  lifecycle: "core" | "steps";
  idleTimeoutSeconds: number;
  /**
   * `github`, `beads`, `local`, or the path (relative to the project root) of a
   * module whose default export builds the tracker (`TrackerFactory`), so a
   * tracker sous does not ship can be plugged in without forking the core.
   */
  tracker: string;
  /** Handed to the tracker: `local` takes `{ dir }`; a module takes whatever it documents. */
  trackerOptions: Record<string, unknown>;
};

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
  labelPrefix: "sous",
  lifecycle: "core",
  idleTimeoutSeconds: 1800,
  tracker: "github",
  trackerOptions: {},
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
    labelPrefix: { type: "string", minLength: 1 },
    lifecycle: { enum: ["core", "steps"] },
    idleTimeoutSeconds: { type: "integer", minimum: 1 },
    tracker: { type: "string", minLength: 1 },
    trackerOptions: { type: "object" },
  },
});

/** `doc` is `null` for an empty file. */
export const parseSettings = (doc: unknown, file: string = SETTINGS_FILE): Settings => ({
  ...DEFAULT_SETTINGS,
  ...check(doc ?? {}, file),
});

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
