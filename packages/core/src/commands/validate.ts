/** `sous validate`: `sous.yaml`, every flow and a project tracker module; exit 2 with one line per error. */
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { checkEngine, ENGINE_VERSION, engineCheckOf, initialRange } from "../config/engine.js";
import { repoEntries } from "../config/repos.js";
import { loadSettings, SETTINGS_FILE } from "../config/settings.js";
import { validateProject, type ValidationError } from "../config/validate.js";
import { PROJECT_DIR, repoRootOf } from "../root.js";
import { isTrackerModule, loadTracker } from "../tracker.js";
import { messageOf } from "../config/schema.js";

export type ValidateDeps = {
  root: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** The running engine's version, checked against `engine:`; injectable for tests. */
  engineVersion?: string;
};

export const USAGE = "usage: sous validate";

export const formatError = (root: string, e: ValidationError): string =>
  `${relative(root, e.file)}${e.id !== undefined ? ` [${e.id}]` : ""}: ${e.rule}: ${e.message}`;

/**
 * A tracker module is only known to work once it is built, so validate builds
 * it the way `sous run` would. Built-ins and unreadable settings (reported by
 * `validateProject`) are skipped.
 */
const checkTrackerModule = async (root: string): Promise<ValidationError | undefined> => {
  const file = join(root, SETTINGS_FILE);
  let settings;
  try {
    settings = loadSettings(file);
  } catch {
    return undefined;
  }
  if (!isTrackerModule(settings.tracker)) return undefined;
  try {
    await loadTracker(settings, { root, repoRoot: repoRootOf(root), runsDir: resolve(root, settings.runsDir), labelPrefix: settings.labelPrefix });
    return undefined;
  } catch (error: unknown) {
    return { file, rule: "settings", message: messageOf(error) };
  }
};

/**
 * `engine:` against this engine: this repository's range, and in a home
 * repository every listed one's, since `sous watch` skips those it does not
 * satisfy. A missing range here is a warning, `sous run` accepts it; a listed
 * repository without one is an error, the daemon never runs it. An invalid
 * range or a broken `sous.yaml` here is `validateProject`'s to report.
 */
const checkEngines = (root: string, version: string): { errors: ValidationError[]; warnings: string[] } => {
  const file = join(root, SETTINGS_FILE);
  let settings;
  try {
    settings = loadSettings(file);
  } catch {
    return { errors: [], warnings: [] };
  }
  const errors: ValidationError[] = [];
  const warnings: string[] = [];
  const own = checkEngine(version, settings.engine, repoRootOf(root));
  if (own.kind === "missing") warnings.push(`${own.message}; add engine: ${initialRange(version)}`);
  else if (own.kind !== "satisfied") errors.push({ file, rule: "settings", message: own.message });
  for (const { name, path } of repoEntries(root, settings) ?? []) {
    const listed = join(path, PROJECT_DIR);
    if (!existsSync(join(listed, SETTINGS_FILE))) continue;
    const check = engineCheckOf(listed, version, name);
    if (check.kind !== "satisfied") errors.push({ file, rule: "settings", message: `repos.${name}: ${check.message}` });
  }
  return { errors, warnings };
};

export const validateCommand = async (args: readonly string[], deps: ValidateDeps): Promise<number> => {
  if (args.length > 0) {
    deps.err(USAGE);
    return 2;
  }
  const report = validateProject(deps.root);
  const tracker = await checkTrackerModule(deps.root);
  if (tracker !== undefined) report.errors.push(tracker);
  const engines = checkEngines(deps.root, deps.engineVersion ?? ENGINE_VERSION);
  report.errors.push(...engines.errors);
  for (const warning of engines.warnings) deps.out(`warning: ${warning}`);
  for (const e of report.errors) deps.err(formatError(deps.root, e));
  if (report.note !== undefined) deps.out(`note: ${report.note}`);
  if (report.errors.length > 0) {
    deps.err(`${report.errors.length} error(s)`);
    return 2;
  }
  deps.out(`ok: sous.yaml and ${report.flows.length} flow(s) valid`);
  return 0;
};
