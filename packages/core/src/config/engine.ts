/**
 * `engine:` in `sous.yaml`: the semver range of engines a repository's
 * definitions were written for. The running engine checks it before it runs
 * a repository, with npm's semver semantics, so a repository is refused by
 * name instead of failing somewhere inside a step.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { messageOf, readYaml } from "./schema.js";
import { SETTINGS_FILE } from "./settings.js";

export type EngineCheck = { kind: "satisfied" } | { kind: "missing" | "invalid" | "unsatisfied"; message: string };

/**
 * Whether the engine `version` may run the repository `repo` (a name or a
 * path, as the message should show it) whose `sous.yaml` states `range`.
 * A missing range is its own verdict: `run` accepts it, `watch` refuses it.
 */
export const checkEngine = (version: string, range: string | undefined, repo: string): EngineCheck => {
  if (range === undefined) return { kind: "missing", message: `${repo} states no engine: range in ${SETTINGS_FILE}` };
  if (semver.validRange(range) === null) return { kind: "invalid", message: `engine: ${JSON.stringify(range)} is not a semver range` };
  if (!semver.satisfies(version, range)) return { kind: "unsatisfied", message: `engine ${version} does not satisfy engine: ${range} of ${repo}` };
  return { kind: "satisfied" };
};

/**
 * What `sous init` writes: a caret on the exact version, which on 0.x keeps
 * the minor, as the changelog breaks per minor. A prerelease keeps its tag:
 * `^1.2.0` excludes `1.2.0-rc.1`, so the engine that wrote it would refuse it.
 */
export const initialRange = (version: string): string => `^${semver.valid(version) ?? version}`;

/** The `package.json` of this package, found upward from this file whether it runs from `src/` or `dist/src/`. */
const ownPackageVersion = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "sous-factory" && pkg.version !== undefined) return pkg.version;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("sous: cannot find the sous-factory package.json to read the engine version");
    dir = parent;
  }
};

/** The version of the engine running this process. */
export const ENGINE_VERSION = ownPackageVersion();

/**
 * `engine:` of the project at `root`, read on its own: a listed repository
 * may carry keys a newer engine knows, and its range is what says so.
 */
export const engineRangeOf = (root: string): string | undefined => {
  const doc = readYaml(join(root, SETTINGS_FILE), true);
  if (typeof doc !== "object" || doc === null || !("engine" in doc)) return undefined;
  const value = (doc as { engine: unknown }).engine;
  return value === undefined || value === null ? undefined : String(value);
};

/** `checkEngine` on the project at `root`, read tolerantly; a `sous.yaml` that cannot be read counts as an invalid range. */
export const engineCheckOf = (root: string, version: string, repo: string): EngineCheck => {
  let range: string | undefined;
  try {
    range = engineRangeOf(root);
  } catch (error: unknown) {
    return { kind: "invalid", message: messageOf(error) };
  }
  return checkEngine(version, range, repo);
};
