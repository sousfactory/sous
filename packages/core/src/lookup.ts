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
};

/** The entry at `root` as routing sees it, from its loaded settings. */
const listerOf = (name: string, root: string, settings: Settings): Lister => {
  const block = requiredTracker(settings, join(root, SETTINGS_FILE));
  return { name, shared: block.shared, location: trackerLocationOf(block, { root, repoRoot: repoRootOf(root) }) };
};

const entryOf = async (name: string, root: string): Promise<LookupEntry> => {
  const repoRoot = repoRootOf(root);
  const settings = loadSettings(join(root, SETTINGS_FILE));
  const tracker = await loadTracker(settings, { root, repoRoot, runsDir: resolve(root, settings.runsDir) });
  return { ...listerOf(name, root, settings), root, repoRoot, tracker };
};

/**
 * The lookup of the project at `root`. An entry without `.sous/sous.yaml`, or
 * whose `engine:` this engine does not satisfy, is set aside; two entries
 * under one name, or on one tracker without `shared: true` in both, are
 * refused. `only` names the one entry to load (`sous run name#issue`): the
 * others are neither read nor judged, so a broken one does not stop it.
 */
export const lookupOf = async (root: string, exec?: Exec, engineVersion: string = ENGINE_VERSION, only?: string): Promise<Lookup> => {
  const file = join(root, SETTINGS_FILE);
  const settings = loadSettings(file);
  const entries = repoEntries(root, settings);
  if (entries === undefined) return { listed: false, unrunnable: [], repos: [await entryOf(await repoNameOf(repoRootOf(root), settings, exec), root)] };
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
    try {
      repos.push(await entryOf(name, projectRoot));
    } catch (error) {
      throw new SousError(`repos.${name}: ${messageOf(error)}`);
    }
  }
  const shared = sameLocationProblems(repos);
  if (shared.length > 0) throw new SousError(`${file}: ${shared.join("; ")}`);
  return { listed: true, repos, unrunnable };
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
