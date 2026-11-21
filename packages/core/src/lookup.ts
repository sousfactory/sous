/**
 * The one lookup `sous watch` and the home `sous run` run on: the
 * entries (the repository itself without `repos:`, else each listed
 * checkout, the home only when the list names it), each with its own
 * `.sous/sous.yaml` and the tracker its block names. Where an issue runs is
 * `routeIssue`'s rule over the entry whose tracker listed it; entries whose
 * trackers share a location are one tracker, refused up front unless every
 * one of them says `shared: true`.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Exec } from "./adapters/exec.js";
import { ENGINE_VERSION, engineCheckOf, engineRefusalOf } from "./config/engine.js";
import { repoEntries, repoNameOf, repoNameProblems, sameLocationProblems, trackerLocationOf, unrunnableRepos, type Lister } from "./config/repos.js";
import { messageOf } from "./config/schema.js";
import { loadSettings, requiredTracker, SETTINGS_FILE, type Settings } from "./config/settings.js";
import { SousError } from "./exec/errors.js";
import type { Tracker } from "./ports/tracker.js";
import { PROJECT_DIR, repoRootOf } from "./root.js";
import { loadTracker } from "./tracker.js";

/** An entry of the lookup: its name in `repo:<name>` labels, its project root (`.sous/`), checkout and tracker, and where that tracker keeps its issues. */
export type LookupEntry = Lister & { root: string; repoRoot: string; tracker: Tracker };

export type Lookup = {
  /** The entries a run can start in. */
  repos: LookupEntry[];
  /** The entries come from `repos:`. */
  listed: boolean;
  /** `repos:` entries nothing starts in (no `.sous/sous.yaml`, no `engine:` this engine satisfies), with why. */
  unrunnable: { name: string; reason: string }[];
  /**
   * Entries whose tracker failed while it was built, with why: only
   * `overviewLookupOf` sets them aside here; `lookupOf` refuses instead.
   * `lister` is there when the entry's settings loaded.
   */
  broken?: BrokenEntry[];
};

/** An entry whose tracker did not build: its settings did not load (no `lister`), or the tracker itself failed. */
export type BrokenEntry = { name: string; root: string; repoRoot: string; reason: string; lister?: Lister };

/** The entry at `root` as routing sees it, from its loaded settings. */
const listerOf = (name: string, root: string, settings: Settings): Lister => {
  const block = requiredTracker(settings, join(root, SETTINGS_FILE));
  return { name, shared: block.shared, location: trackerLocationOf(block, { root, repoRoot: repoRootOf(root) }) };
};

/** The entry at `root`, or why its settings or its tracker failed while it was built. */
const builtOf = async (name: string, root: string): Promise<LookupEntry | (BrokenEntry & { error: unknown })> => {
  const repoRoot = repoRootOf(root);
  let settings: Settings;
  let lister: Lister;
  try {
    settings = loadSettings(join(root, SETTINGS_FILE));
    lister = listerOf(name, root, settings);
  } catch (error) {
    return { name, root, repoRoot, reason: messageOf(error), error };
  }
  try {
    const tracker = await loadTracker(settings, { root, repoRoot, runsDir: resolve(root, settings.runsDir) });
    return { ...lister, root, repoRoot, tracker };
  } catch (error) {
    return { name, root, repoRoot, reason: messageOf(error), lister, error };
  }
};

/**
 * The lookup of the project at `root`. An entry without `.sous/sous.yaml`, or
 * whose `engine:` this engine does not satisfy, is set aside; two entries
 * under one name, or on one tracker without `shared: true` in both, are
 * refused. `only` names the one entry to load (`sous run name#issue`): the
 * others are neither read nor judged, so a broken one does not stop it.
 */
export const lookupOf = (root: string, exec?: Exec, engineVersion: string = ENGINE_VERSION, only?: string): Promise<Lookup> =>
  lookupWith(root, exec, engineVersion, only, false);

/**
 * The lookup `sous status` shows: `lookupOf`'s, except that an entry whose
 * tracker fails while it is built (its settings do not load, the tracker
 * module throws) is set aside in `broken` instead of refusing the lookup.
 */
export const overviewLookupOf = (root: string, exec?: Exec, engineVersion: string = ENGINE_VERSION): Promise<Lookup> =>
  lookupWith(root, exec, engineVersion, undefined, true);

const lookupWith = async (root: string, exec: Exec | undefined, engineVersion: string, only: string | undefined, tolerant: boolean): Promise<Lookup> => {
  const file = join(root, SETTINGS_FILE);
  const settings = loadSettings(file);
  const entries = repoEntries(root, settings);
  const broken: BrokenEntry[] = [];
  const build = async (name: string, projectRoot: string, wrap: (error: unknown) => unknown): Promise<LookupEntry[]> => {
    const built = await builtOf(name, projectRoot);
    if (!("reason" in built)) return [built];
    if (!tolerant) throw wrap(built.error);
    const { error: _, ...entry } = built;
    broken.push(entry);
    return [];
  };
  if (entries === undefined) {
    const repos = await build(await repoNameOf(repoRootOf(root), settings, exec), root, (error) => error);
    return { listed: false, unrunnable: [], repos, ...(tolerant ? { broken } : {}) };
  }
  const problems = repoNameProblems(root, settings);
  if (problems.length > 0) throw new SousError(`${file}: ${problems.join("; ")}`);
  const unrunnable = unrunnableRepos(root, settings);
  const repos: LookupEntry[] = [];
  for (const { name, path } of entries) {
    if (unrunnable.some((u) => u.name === name) || (only !== undefined && name !== only)) continue;
    const projectRoot = join(path, PROJECT_DIR);
    // Before its settings load: a repository written for a newer engine may hold keys this one rejects.
    // A missing range counts too: a run nobody watches must say what it was written for.
    const refusal = engineRefusalOf(engineCheckOf(projectRoot, engineVersion, path), engineVersion);
    if (refusal !== undefined) {
      unrunnable.push({ name, reason: `${refusal}; sous watch starts nothing there` });
      continue;
    }
    repos.push(...(await build(name, projectRoot, (error) => new SousError(`repos.${name}: ${messageOf(error)}`))));
  }
  const shared = sameLocationProblems(repos);
  if (shared.length > 0) throw new SousError(`${file}: ${shared.join("; ")}`);
  return { listed: true, repos, unrunnable, ...(tolerant ? { broken } : {}) };
};

/**
 * The `repos:` entries of the home at `root` as routing sees them, read
 * tolerantly for `sous validate`: the entries `lookupOf` loads, so the two
 * judge one set. An entry without `.sous/sous.yaml`, whose `engine:` this
 * engine does not satisfy, or whose settings do not load or hold no tracker
 * block is left out; its own check reports it.
 */
export const listedTrackersOf = (root: string, settings: Pick<Settings, "repos">, engineVersion: string = ENGINE_VERSION): Lister[] => {
  const listers: Lister[] = [];
  for (const { name, path } of repoEntries(root, settings) ?? []) {
    const projectRoot = join(path, PROJECT_DIR);
    if (!existsSync(join(projectRoot, SETTINGS_FILE))) continue;
    if (engineRefusalOf(engineCheckOf(projectRoot, engineVersion, path), engineVersion) !== undefined) continue;
    try {
      listers.push(listerOf(name, projectRoot, loadSettings(join(projectRoot, SETTINGS_FILE))));
    } catch {
      continue;
    }
  }
  return listers;
};
