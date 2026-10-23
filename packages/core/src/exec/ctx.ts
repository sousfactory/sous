/**
 * Builds the `Ctx` for one point in a run. It is a plain value, rebuilt
 * wherever an expression, prompt, module or eval needs it, so it never goes
 * stale. `repoFiles` and `readFile` are synchronous so they work inside `${{ }}`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SousError } from "./errors.js";
import type { CtxValues } from "../expr/compile.js";
import type { Ctx, ExecOptions, Issue, Work, WorkRecord } from "../index.js";
import type { EventLog } from "../ports/eventlog.js";
import type { Git } from "../ports/git.js";
import type { Tracker } from "../ports/tracker.js";
import type { Sandbox } from "../ports/sandbox.js";

/** Fixed for the whole run. */
export type CtxDeps = {
  issue: Issue;
  /** `ctx.spec`: the spec markdown as resolved when the current visit started. */
  spec: string;
  flow: string;
  branch: string;
  /** The repository checkout (`merge` squashes there). */
  repoRoot: string;
  /** Absolute `.sous/skills`. */
  skillsDir: string;
  /** Absolute `.sous/templates`. */
  templatesDir: string;
  sandbox: Sandbox;
  git: Git;
  tracker: Tracker;
  events: Pick<EventLog, "readAll">;
  repoLock: Ctx["repoLock"];
};

/** Changes between visits and iterations. */
export type CtxState = {
  work: Work;
  /** Relative to the repository root, as the session records it; resolved against the worktree. */
  specDir: string;
  workProgress: Readonly<Record<string, WorkRecord>>;
  previous: string | null;
  /** Set for eval and routes only. */
  iteration?: number;
};

/** Absent outside a module call, where `ctx.workDone` throws. */
export type CtxWrites = { workDone: (work: string, commits: readonly string[]) => void };

const inWorktree = (worktree: string, path: string): string => resolve(worktree, path);

const read = (file: string, shown: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch (error: unknown) {
    throw new SousError(`cannot read ${shown}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const isDirectory = (file: string): boolean => {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
};

/** Sorted, so a prompt built from a directory is stable between runs. */
const filesUnder = (worktree: string, dir: string): string[] =>
  readdirSync(inWorktree(worktree, dir), { withFileTypes: true })
    .map((entry) => join(dir, entry.name))
    .sort()
    .flatMap((path) => (isDirectory(inWorktree(worktree, path)) ? filesUnder(worktree, path) : [path]));

/** `### <path>` plus content per file; a directory expands to its files. */
export const repoFiles = (worktree: string, paths: readonly string[]): string =>
  paths
    .flatMap((path) => (isDirectory(inWorktree(worktree, path)) ? filesUnder(worktree, path) : [path]))
    .map((path) => `### ${path}\n\n${read(inWorktree(worktree, path), path).trimEnd()}`)
    .join("\n\n");

export const buildCtx = (deps: CtxDeps, state: CtxState, writes?: CtxWrites): Ctx => {
  const worktree = deps.sandbox.worktreePath;
  const ctx: Ctx = {
    issue: deps.issue,
    spec: deps.spec,
    flow: deps.flow,
    work: state.work,
    branch: deps.branch,
    worktree,
    repoRoot: deps.repoRoot,
    specDir: state.specDir,
    skillsDir: deps.skillsDir,
    templatesDir: deps.templatesDir,
    previous: state.previous,
    ...(state.iteration !== undefined ? { iteration: state.iteration } : {}),
    workProgress: state.workProgress,
    workDone(commits) {
      if (writes === undefined) throw new SousError("ctx.workDone is available to modules only");
      writes.workDone(ctx.work.id, [...commits]);
    },
    repoFiles: (paths) => repoFiles(worktree, paths),
    readFile: (path) => read(inWorktree(worktree, path), path),
    exec: (cmd: string, opts?: ExecOptions) => deps.sandbox.exec(cmd, opts),
    git: deps.git,
    tracker: deps.tracker,
    events: { readAll: () => deps.events.readAll() },
    sandbox: { close: () => deps.sandbox.close() },
    repoLock: (fn) => deps.repoLock(fn),
  };
  return ctx;
};

/** The `{{ctx.*}}` values a prompt may use without declaring them. */
export const ctxPlaceholders = (ctx: Ctx): CtxValues => ({
  "ctx.issue.id": ctx.issue.id,
  "ctx.issue.ref": ctx.issue.ref,
  "ctx.work.id": ctx.work.id,
  "ctx.work.ref": ctx.work.ref,
  "ctx.worktree": ctx.worktree,
  "ctx.spec": ctx.spec,
  "ctx.specDir": ctx.specDir,
  "ctx.skillsDir": ctx.skillsDir,
  "ctx.templatesDir": ctx.templatesDir,
});
