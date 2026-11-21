/**
 * Picks the project's tracker from `sous.yaml`: a built-in by name, or a
 * project module by path, so a tracker sous does not ship (Jira, Linear, a
 * company tool) plugs in without a fork of the core.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBeadsTracker } from "./adapters/beads.js";
import { createGitHubTracker } from "./adapters/github.js";
import { createLocalTracker } from "./adapters/local-issues.js";
import { requiredTracker, SETTINGS_FILE, trackerProblems, type Settings } from "./config/settings.js";
import { SousError } from "./exec/errors.js";
import { importDefault } from "./exec/executor.js";
import { TRACKER_METHODS, type Tracker } from "./ports/tracker.js";

export const BUILTIN_TRACKERS = ["github", "beads", "local"] as const;

/** Where the tracker runs: the project root (`.sous/`), the repository and the runs folder, all absolute. */
export type TrackerPlace = { root: string; repoRoot: string; runsDir: string };

/** What a tracker module is handed besides its block: the place, plus `labelPrefix`, the block's `labels`. */
export type TrackerEnv = TrackerPlace & { labelPrefix: string };

/** The default export of a tracker module: the `tracker:` block of `sous.yaml` and the environment in, a `Tracker` out. */
export type TrackerFactory = (options: Record<string, unknown>, env: TrackerEnv) => Tracker | Promise<Tracker>;

/** Anything but a built-in name is a module path relative to the project root. */
export const isTrackerModule = (tracker: string): boolean => !(BUILTIN_TRACKERS as readonly string[]).includes(tracker);

export const trackerModulePath = (root: string, tracker: string): string => resolve(root, tracker);

/** The methods a value lacks to be a `Tracker`; empty when it is one. */
export const missingTrackerMethods = (value: unknown): string[] => {
  if (typeof value !== "object" || value === null) return [...TRACKER_METHODS];
  const record = value as Record<string, unknown>;
  return TRACKER_METHODS.filter((m) => typeof record[m] !== "function");
};

/**
 * The tracker the `tracker:` block names. A missing block or location is
 * refused here too, for a caller that did not come through `parseSettings`.
 */
export const loadTracker = async (settings: Pick<Settings, "tracker">, place: TrackerPlace): Promise<Tracker> => {
  const file = join(place.root, SETTINGS_FILE);
  const block = requiredTracker(settings, file);
  const problems = trackerProblems(block);
  if (problems.length > 0) throw new SousError(`${file}: ${problems.join("; ")}`);
  const { type, labels: labelPrefix } = block;
  const env: TrackerEnv = { ...place, labelPrefix };
  if (type === "github") return createGitHubTracker({ repo: String(block.repo), cwd: env.repoRoot, labelPrefix });
  if (type === "beads") return createBeadsTracker({ dir: env.runsDir, cwd: env.repoRoot, labelPrefix });
  if (type === "local") return createLocalTracker({ dir: resolve(env.root, String(block.dir)), labelPrefix });
  const module = trackerModulePath(env.root, type);
  if (!existsSync(module)) throw new SousError(`tracker: ${module} does not exist; name a built-in (${BUILTIN_TRACKERS.join(", ")}) or a module path relative to ${env.root}`);
  const factory = await importDefault<unknown>(module);
  if (typeof factory !== "function") throw new SousError(`tracker: ${module}: the default export must be a function (options, env) => Tracker`);
  const built: unknown = await (factory as TrackerFactory)(block, env);
  const missing = missingTrackerMethods(built);
  if (missing.length > 0) throw new SousError(`tracker: ${module}: the tracker lacks ${missing.join(", ")}`);
  return built as Tracker;
};
