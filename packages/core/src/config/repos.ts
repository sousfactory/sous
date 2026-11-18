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
import { SETTINGS_FILE, type Settings } from "./settings.js";

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
 * Where an issue runs, by its labels: with `repos:` (`entries`) its one
 * `repo:*` label names the entry, and an issue without one, or naming no
 * entry, runs nowhere; without (`self`), the one repository takes an issue
 * without a label or naming it. `override` (`sous run --repo`) wins over the
 * label. The one rule `sous watch` and `sous run` in a home repository follow.
 */
export const routeIssue = (labels: readonly string[], scope: { entries: readonly string[] } | { self: string }, override?: string): Route => {
  if ("entries" in scope && override !== undefined) return scope.entries.includes(override) ? { to: override } : { reason: `--repo ${override} names no entry of repos: (${scope.entries.join(", ")})` };
  const names = labels.filter((l) => l.startsWith(REPO_LABEL));
  if (names.length > 1) return { reason: `carries several ${REPO_LABEL}* labels (${names.join(", ")}); keep one` };
  const named = names[0]?.slice(REPO_LABEL.length);
  if ("self" in scope) return named === undefined || named === scope.self ? { to: scope.self } : { reason: `${names[0]} names another repository than ${scope.self}` };
  if (named === undefined) return { reason: `no ${REPO_LABEL}* label names its repository` };
  if (!scope.entries.includes(named)) return { reason: `${names[0]} names no entry of repos: (${scope.entries.join(", ")})` };
  return { to: named };
};

/** `acme/web` of `git@github.com:acme/web.git` or `https://github.com/acme/web`: the last path part, without `.git`. */
const repoPartOf = (url: string): string | undefined => {
  const part = url.trim().replace(/\/+$/, "").split(/[/:]/).at(-1)?.replace(/\.git$/, "");
  return part === undefined || part === "" ? undefined : part;
};

/** `name:` in `sous.yaml`, else the repository part of the `origin` remote, else the folder name. */
export const repoNameOf = async (repoRoot: string, settings: Pick<Settings, "name">, exec: Exec = defaultExec): Promise<string> => {
  if (settings.name !== undefined) return settings.name;
  const origin = await exec("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
  const fromRemote = origin.code === 0 ? repoPartOf(origin.stdout) : undefined;
  return fromRemote ?? basename(repoRoot);
};
