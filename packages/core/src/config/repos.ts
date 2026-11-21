/**
 * The repositories a home repository serves (`repos:` in its `sous.yaml`) and
 * the name a repository answers to in `repo:<name>` labels. The name is the
 * repository's identity in labels, so a colleague's differently named
 * checkout still routes; everything else is read from the repository's own
 * `.sous/`.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { exec as defaultExec, type Exec } from "../adapters/exec.js";
import { PROJECT_DIR, repoRootOf } from "../root.js";
import { SETTINGS_FILE, type Settings, type TrackerSettings } from "./settings.js";

export type RepoEntry = { name: string; path: string };

/** The label naming the repository an issue belongs to. */
export const REPO_LABEL = "repo:";

const expand = (repoRoot: string, path: string): string => {
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
  return isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
};

/** The listed repositories with absolute paths, in the order written; `undefined` without `repos:`. */
export const repoEntries = (root: string, settings: Pick<Settings, "repos">): RepoEntry[] | undefined => {
  const { repos } = settings;
  if (repos === undefined) return undefined;
  const repoRoot = repoRootOf(root);
  if (Array.isArray(repos)) return repos.map((p) => expand(repoRoot, p)).map((path) => ({ name: basename(path), path }));
  return Object.entries(repos).map(([name, p]) => ({ name, path: expand(repoRoot, p) }));
};

/** What `sous validate` says about `repos:`: a path without a project, two entries under one name. */
export const repoProblems = (root: string, settings: Pick<Settings, "repos">): string[] => {
  const missing = (repoEntries(root, settings) ?? []).filter(({ path }) => !existsSync(join(path, PROJECT_DIR, SETTINGS_FILE)));
  return [...repoNameProblems(root, settings), ...missing.map(({ name, path }) => `repos.${name}: ${path} holds no ${PROJECT_DIR}/${SETTINGS_FILE}`)];
};

/**
 * The listed entries `sous watch` cannot serve: no `.sous/sous.yaml`, so
 * nothing to run. Kept apart from `repoProblems`, where `sous validate`
 * reports them: the daemon skips these and serves the rest.
 */
export const unrunnableRepos = (root: string, settings: Pick<Settings, "repos">): { name: string; reason: string }[] =>
  (repoEntries(root, settings) ?? [])
    .filter(({ path }) => !existsSync(join(path, PROJECT_DIR, SETTINGS_FILE)))
    .map(({ name, path }) => ({ name, reason: `${path} holds no ${PROJECT_DIR}/${SETTINGS_FILE}; sous watch starts nothing there` }));

/** The `repos:` problems a daemon cannot serve around: two entries under one name. */
export const repoNameProblems = (root: string, settings: Pick<Settings, "repos">): string[] => {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const { name } of repoEntries(root, settings) ?? []) {
    if (seen.has(name)) problems.push(`repos: two entries are named ${name}; use a map to name them apart`);
    seen.add(name);
  }
  return problems;
};

/** Where an issue runs, or why it does not. */
export type Route = { to: string } | { reason: string };

/**
 * Where a tracker keeps its issues: two entries whose trackers have one type
 * and one `at` list the same issues. `at` is the github repository, the
 * local folder, the beads checkout, or a module's own keys.
 */
export type TrackerLocation = { type: string; at: string };

/** The tracker keys every type has; the rest of a module's block is where it looks. */
const COMMON_KEYS = new Set(["type", "shared", "labels"]);

/** Where the tracker of the project at `root` (checkout `repoRoot`) keeps its issues, by its block. */
export const trackerLocationOf = (block: TrackerSettings, place: { root: string; repoRoot: string }): TrackerLocation => {
  const { type } = block;
  if (type === "github") return { type, at: String(block.repo) };
  if (type === "local") return { type, at: resolve(place.root, String(block.dir)) };
  if (type === "beads") return { type, at: place.repoRoot };
  const own = Object.fromEntries(Object.entries(block).filter(([key]) => !COMMON_KEYS.has(key)).sort(([a], [b]) => a.localeCompare(b)));
  return { type: resolve(place.root, type), at: JSON.stringify(own) };
};

const sameLocation = (a: TrackerLocation, b: TrackerLocation): boolean => a.type === b.type && a.at === b.at;

/** An entry of the lookup as routing sees it: its name, and its tracker's location and `shared`, unless `sous watch` could not load it. */
export type RouteEntry = { name: string; shared?: boolean; location?: TrackerLocation };

/** The entry whose tracker listed an issue. */
export type Lister = { name: string; shared: boolean; location: TrackerLocation };

/**
 * Two entries on one tracker where either says `shared: false`: each claims
 * the tracker's issues as its own alone, so no rule can tell where one runs.
 */
export const sameLocationProblems = (entries: readonly Lister[]): string[] => {
  const problems: string[] = [];
  entries.forEach((a, i) => {
    for (const b of entries.slice(i + 1))
      if (sameLocation(a.location, b.location) && !(a.shared && b.shared))
        problems.push(`repos: ${a.name} and ${b.name} use one tracker (${a.location.type} ${a.location.at}) with shared: false; set shared: true in both, or give each its own tracker`);
  });
  return problems;
};

/**
 * Where an issue a tracker listed (`listedBy`) runs, by its labels: an
 * unshared tracker's issue runs in the entry that listed it, unless its one
 * `repo:*` label names another repository; a shared tracker's runs in the
 * entry its one `repo:<name>` label names, among the `entries` on that
 * tracker, and without one runs nowhere. `home` says `entries` come from
 * `repos:`. The rule `sous watch` and `sous run` follow.
 */
export const routeIssue = (labels: readonly string[], { listedBy, entries, home }: { listedBy: Lister; entries: readonly RouteEntry[]; home: boolean }): Route => {
  const names = labels.filter((l) => l.startsWith(REPO_LABEL));
  if (names.length > 1) return { reason: `carries several ${REPO_LABEL}* labels (${names.join(", ")}); keep one` };
  const label = names[0];
  const named = label?.slice(REPO_LABEL.length);
  const another = { reason: `${label} names another repository than ${listedBy.name}` };
  if (!listedBy.shared) return named === undefined || named === listedBy.name ? { to: listedBy.name } : another;
  if (named === undefined) {
    const here = entries.filter((e) => e.location !== undefined && sameLocation(e.location, listedBy.location)).map((e) => e.name);
    const suggested = here.length > 0 ? here : [listedBy.name];
    return { reason: `tracker ${listedBy.location.at} is shared; add ${suggested.map((n) => `${REPO_LABEL}${n}`).join(" or ")}` };
  }
  const target = entries.find((e) => e.name === named);
  if (target === undefined) return home ? { reason: `${label} names no entry of repos: (${entries.map((e) => e.name).join(", ")})` } : another;
  if (target.location !== undefined && !sameLocation(target.location, listedBy.location)) return { reason: `${label}, but the tracker of ${named} does not list it; a run in ${named} could not find it` };
  return { to: named };
};

/** `acme/web` of `git@github.com:acme/web.git` or `https://github.com/acme/web`: the last path part, without `.git`. */
const repoPartOf = (url: string): string | undefined => {
  const part = url.trim().replace(/\/+$/, "").split(/[/:]/).at(-1)?.replace(/\.git$/, "");
  return part === undefined || part === "" ? undefined : part;
};

/** `acme/web` of an origin URL (`git@github.com:acme/web.git`, `https://github.com/acme/web`): the last two path parts, without `.git`. */
export const ownerNameOf = (url: string): string | undefined => {
  const parts = url.trim().replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/);
  const owner = parts.at(-2);
  const name = parts.at(-1);
  return owner === undefined || name === undefined || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name) ? undefined : `${owner}/${name}`;
};

/** `owner/name` of the checkout's `origin` remote, or `undefined` without one. */
export const originRepoOf = async (repoRoot: string, exec: Exec = defaultExec): Promise<string | undefined> => {
  const origin = await exec("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
  return origin.code === 0 ? ownerNameOf(origin.stdout) : undefined;
};

/** `name:` in `sous.yaml`, else the repository part of the `origin` remote, else the folder name. */
export const repoNameOf = async (repoRoot: string, settings: Pick<Settings, "name">, exec: Exec = defaultExec): Promise<string> => {
  if (settings.name !== undefined) return settings.name;
  const origin = await exec("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
  const fromRemote = origin.code === 0 ? repoPartOf(origin.stdout) : undefined;
  return fromRemote ?? basename(repoRoot);
};
