/**
 * Git as a step sees it via `ctx.git`. Every operation takes an explicit
 * `cwd`, so one instance serves both the base-branch checkout and the issue
 * worktree.
 */

export type MergeResult = {
  ok: boolean;
  /** The merge stopped on conflicts and is still in progress. */
  conflicted: boolean;
  log: string;
};

export type Commit = { sha: string; subject: string };

export type DeleteBranchOptions = { force?: boolean };

export type Git = {
  currentBranch(cwd: string): Promise<string>;
  /** Tracked files modified or staged. Untracked files do not count. */
  isDirty(cwd: string): Promise<boolean>;
  branchExists(cwd: string, name: string): Promise<boolean>;
  createBranch(cwd: string, name: string, from: string): Promise<void>;
  deleteBranch(cwd: string, name: string, options?: DeleteBranchOptions): Promise<void>;
  /** `git merge --no-edit <source>` into the branch checked out at `cwd`. */
  mergeInto(cwd: string, source: string): Promise<MergeResult>;
  mergeInProgress(cwd: string): Promise<boolean>;
  /** Paths changed on HEAD since it diverged from `base` (`base...HEAD`). */
  diffNames(cwd: string, base: string): Promise<string[]>;
  log(cwd: string, range: string): Promise<Commit[]>;
  /**
   * `git merge --squash <branch>` plus one commit on the branch checked out
   * at `mainCwd`. Refuses a dirty checkout. Returns the new sha.
   */
  squashMerge(mainCwd: string, branch: string, message: string): Promise<string>;
  add(cwd: string, paths: readonly string[]): Promise<void>;
  /** Commits the index; `undefined` when nothing is staged. Returns the new sha. */
  commit(cwd: string, message: string): Promise<string | undefined>;
  headSha(cwd: string): Promise<string>;
  /** Tree object of `ref` (`<ref>^{tree}`); equal trees mean equal content. */
  treeSha(cwd: string, ref: string): Promise<string>;
  /** True when `a` is reachable from `b`. */
  isAncestor(cwd: string, a: string, b: string): Promise<boolean>;
  /** Force-removes the worktree at `path`; a no-op when it is not a registered worktree. */
  removeWorktree(cwd: string, path: string): Promise<void>;
};
