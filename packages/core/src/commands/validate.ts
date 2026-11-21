/** `sous validate`: `sous.yaml`, every flow and the tracker; exit 2 with one line per error. */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { checkEngine, ENGINE_VERSION, engineCheckOf, engineRefusalOf } from "../config/engine.js";
import { repoEntries, sameLocationProblems } from "../config/repos.js";
import { listedTrackersOf } from "../lookup.js";
import { loadSettings, SETTINGS_FILE, TRACKER_BLOCK } from "../config/settings.js";
import { validateProject, type ValidationError } from "../config/validate.js";
import { PROJECT_DIR, repoRootOf } from "../root.js";
import { useRunningEngine } from "../exec/imports.js";
import { loadTracker } from "../tracker.js";
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
 * The tracker is built the way `sous run` would build it: a missing block is
 * refused, and a module is only known to work once it is built. Building a
 * built-in calls nothing. A home repository whose `repos:` does not name
 * itself needs no block: no lookup asks its own tracker. Unreadable settings
 * are `validateProject`'s to report.
 */
const checkTracker = async (root: string): Promise<ValidationError | undefined> => {
  const file = join(root, SETTINGS_FILE);
  let settings;
  try {
    settings = loadSettings(file);
  } catch {
    return undefined;
  }
  if (settings.tracker === undefined) {
    const entries = repoEntries(root, settings);
    if (entries !== undefined && !entries.some(({ path }) => path === repoRootOf(root))) return undefined;
    return { file, rule: "settings", message: `tracker is required: ${TRACKER_BLOCK}` };
  }
  try {
    await loadTracker(settings, { root, repoRoot: repoRootOf(root), runsDir: resolve(root, settings.runsDir) });
    return undefined;
  } catch (error: unknown) {
    return { file, rule: "settings", message: messageOf(error) };
  }
};

/**
 * `engine:` against this engine: this repository's range, and in a home
 * repository every listed one's, since `sous watch` skips those it does not
 * satisfy. A missing range is an error everywhere, as `run` and `watch`
 * refuse it. An invalid range or a broken `sous.yaml` here is
 * `validateProject`'s to report.
 */
const checkEngines = (root: string, version: string): ValidationError[] => {
  const file = join(root, SETTINGS_FILE);
  let settings;
  try {
    settings = loadSettings(file);
  } catch {
    return [];
  }
  const errors: ValidationError[] = [];
  const own = engineRefusalOf(checkEngine(version, settings.engine, repoRootOf(root)), version);
  if (own !== undefined) errors.push({ file, rule: "settings", message: own });
  for (const { name, path } of repoEntries(root, settings) ?? []) {
    const listed = join(path, PROJECT_DIR);
    if (!existsSync(join(listed, SETTINGS_FILE))) continue;
    const refusal = engineRefusalOf(engineCheckOf(listed, version, name), version);
    if (refusal !== undefined) errors.push({ file, rule: "settings", message: `repos.${name}: ${refusal}` });
  }
  return errors;
};

/** In a home repository, two entries on one tracker unless both say `shared: true`, as `sous watch` refuses them. */
const checkLocations = (root: string): ValidationError[] => {
  const file = join(root, SETTINGS_FILE);
  let settings;
  try {
    settings = loadSettings(file);
  } catch {
    return [];
  }
  return sameLocationProblems(listedTrackersOf(root, settings)).map((message) => ({ file, rule: "settings", message }));
};

const COMMONJS = "so steps and tracker modules load as CommonJS, where sous-factory cannot be imported";

/**
 * The project's `package.json` makes its `.ts` files ES modules; without
 * `"type": "module"` they load as CommonJS, which the running-engine hook
 * does not reach, and a step's `sous-factory` import fails only at run time.
 */
const checkModuleType = (root: string): ValidationError | undefined => {
  const file = join(root, "package.json");
  if (!existsSync(file)) return { file, rule: "package", message: `there is none, ${COMMONJS}; add ${PROJECT_DIR}/package.json with "type": "module"` };
  let type: unknown;
  try {
    type = (JSON.parse(readFileSync(file, "utf8")) as { type?: unknown }).type;
  } catch (error: unknown) {
    return { file, rule: "package", message: `${messageOf(error)}; it must be JSON with "type": "module"` };
  }
  return type === "module" ? undefined : { file, rule: "package", message: `"type" is not "module", ${COMMONJS}; add "type": "module" to ${PROJECT_DIR}/package.json` };
};

export const validateCommand = async (args: readonly string[], deps: ValidateDeps): Promise<number> => {
  if (args.length > 0) {
    deps.err(USAGE);
    return 2;
  }
  const report = validateProject(deps.root);
  // As `run` and `watch` load it: a definitions-only repository's tracker module imports this engine.
  await useRunningEngine();
  const tracker = await checkTracker(deps.root);
  if (tracker !== undefined) report.errors.push(tracker);
  report.errors.push(...checkEngines(deps.root, deps.engineVersion ?? ENGINE_VERSION));
  report.errors.push(...checkLocations(deps.root));
  const moduleType = checkModuleType(deps.root);
  if (moduleType !== undefined) report.errors.push(moduleType);
  for (const e of report.errors) deps.err(formatError(deps.root, e));
  if (report.note !== undefined) deps.out(`note: ${report.note}`);
  if (report.errors.length > 0) {
    deps.err(`${report.errors.length} error(s)`);
    return 2;
  }
  deps.out(`ok: sous.yaml and ${report.flows.length} flow(s) valid`);
  return 0;
};
