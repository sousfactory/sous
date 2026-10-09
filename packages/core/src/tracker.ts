/**
 * Picks the project's tracker from `sous.yaml`: a built-in by name, or a
 * project module by path, so a tracker sous does not ship (Jira, Linear, a
 * company tool) plugs in without a fork of the core.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createBeadsTracker } from "./adapters/beads.js";
import { createGitHubTracker } from "./adapters/github.js";
import { createLocalTracker } from "./adapters/local-issues.js";
import type { Settings } from "./config/settings.js";
import { SousError } from "./exec/errors.js";
import { importDefault } from "./exec/executor.js";
import { TRACKER_METHODS, type Tracker } from "./ports/tracker.js";

export const BUILTIN_TRACKERS = ["github", "beads", "local"] as const;

/** Where the tracker runs: the project root (`.sous/`), the repository and the runs folder, all absolute, plus the `labelPrefix` setting. */
export type TrackerEnv = { root: string; repoRoot: string; runsDir: string; labelPrefix: string };

/** The default export of a tracker module: `trackerOptions` from `sous.yaml` and the environment in, a `Tracker` out. */
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

const optionString = (options: Record<string, unknown>, key: string, tracker: string): string => {
  const value = options[key];
  if (typeof value !== "string" || value === "") throw new SousError(`tracker ${tracker}: trackerOptions.${key} must be a non-empty string`);
  return value;
};

export const loadTracker = async (settings: Pick<Settings, "tracker" | "trackerOptions">, env: TrackerEnv): Promise<Tracker> => {
  const { tracker, trackerOptions } = settings;
  const { labelPrefix } = env;
  if (tracker === "github") return createGitHubTracker({ cwd: env.repoRoot, labelPrefix });
  if (tracker === "beads") return createBeadsTracker({ dir: env.runsDir, cwd: env.repoRoot, labelPrefix });
  if (tracker === "local") return createLocalTracker({ dir: resolve(env.root, optionString(trackerOptions, "dir", tracker)), labelPrefix });
  const file = trackerModulePath(env.root, tracker);
  if (!existsSync(file)) throw new SousError(`tracker: ${file} does not exist; name a built-in (${BUILTIN_TRACKERS.join(", ")}) or a module path relative to ${env.root}`);
  const factory = await importDefault<unknown>(file);
  if (typeof factory !== "function") throw new SousError(`tracker: ${file}: the default export must be a function (options, env) => Tracker`);
  const built: unknown = await (factory as TrackerFactory)(trackerOptions, env);
  const missing = missingTrackerMethods(built);
  if (missing.length > 0) throw new SousError(`tracker: ${file}: the tracker lacks ${missing.join(", ")}`);
  return built as Tracker;
};
