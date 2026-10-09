/** `sous validate`: `sous.yaml`, every flow and a project tracker module; exit 2 with one line per error. */
import { join, relative, resolve } from "node:path";
import { loadSettings, SETTINGS_FILE } from "../config/settings.js";
import { validateProject, type ValidationError } from "../config/validate.js";
import { repoRootOf } from "../root.js";
import { isTrackerModule, loadTracker } from "../tracker.js";
import { messageOf } from "../config/schema.js";

export type ValidateDeps = {
  root: string;
  out: (line: string) => void;
  err: (line: string) => void;
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

export const validateCommand = async (args: readonly string[], deps: ValidateDeps): Promise<number> => {
  if (args.length > 0) {
    deps.err(USAGE);
    return 2;
  }
  const report = validateProject(deps.root);
  const tracker = await checkTrackerModule(deps.root);
  if (tracker !== undefined) report.errors.push(tracker);
  for (const e of report.errors) deps.err(formatError(deps.root, e));
  if (report.note !== undefined) deps.out(`note: ${report.note}`);
  if (report.errors.length > 0) {
    deps.err(`${report.errors.length} error(s)`);
    return 2;
  }
  deps.out(`ok: sous.yaml and ${report.flows.length} flow(s) valid`);
  return 0;
};
