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
  const entries = repoEntries(root, settings) ?? [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { name, path } of entries) {
    if (seen.has(name)) problems.push(`repos: two entries are named ${name}; use a map to name them apart`);
    seen.add(name);
    if (!existsSync(join(path, PROJECT_DIR, SETTINGS_FILE))) problems.push(`repos.${name}: ${path} holds no ${PROJECT_DIR}/${SETTINGS_FILE}`);
  }
  return problems;
};

/** The wrapper in a project folder that runs the project's own engine version. */
export const WRAPPER = "sous";

/**
 * The listed projects `sous watch` cannot start a run in: no `.sous/sous`,
 * so nothing names their engine, and the home engine never stands in. Kept
 * apart from `repoProblems`: the daemon skips these and serves the rest.
 */
export const unrunnableRepos = (root: string, settings: Pick<Settings, "repos">): { name: string; reason: string }[] =>
  (repoEntries(root, settings) ?? [])
    .filter(({ path }) => existsSync(join(path, PROJECT_DIR, SETTINGS_FILE)) && !existsSync(join(path, PROJECT_DIR, WRAPPER)))
    .map(({ name, path }) => ({ name, reason: `${path} holds no ${PROJECT_DIR}/${WRAPPER} to run it on its own engine; sous watch starts nothing there` }));

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
