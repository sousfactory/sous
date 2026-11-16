import type { Commit, Git } from "../../src/ports/git.js";

/** Knobs a test flips to script outcomes; the fake reads them live. */
export type FakeGitState = {
  /** Branch checked out per cwd; unknown cwds are on `main`. */
  branches: Record<string, string>;
  /** cwds whose checkout is dirty. */
  dirty: Set<string>;
  /** `mergeInto` stops on conflicts while true. */
  conflict: boolean;
  /** A clean `mergeInto` leaves HEAD where it was while true ("Already up to date."); otherwise it moves HEAD. */
  upToDate: boolean;
  merging: boolean;
  /** What `diffNames` returns. */
  diff: string[];
  /** `isAncestor(cwd, a, b)` is true for entries `"a..b"`. */
  ancestors: Set<string>;
  /** What `log` returns. */
  commits: Commit[];
  /** `treeSha(cwd, ref)` per ref; unknown refs get `tree:<ref>`. */
  trees: Record<string, string>;
  /** Where each branch is checked out, as `worktreeOf` reports it; `addWorktree` adds to it. */
  worktrees: Record<string, string>;
  /** The remote's branch has commits the local one lacks: `fastForward` brings them in, so the branch is no longer an ancestor of anything in `ancestors`. */
  remoteAhead: boolean;
  /** `fastForward` answers false (local and remote diverged) while true. */
  diverged: boolean;
  /** `push` rejects with this message when set. */
  pushError?: string;
};

export type FakeGit = Git & {
  readonly state: FakeGitState;
  readonly existing: Set<string>;
  readonly calls: string[];
  /** Commit messages created through `commit` and `squashMerge`. */
  readonly committed: { cwd: string; message: string; sha: string }[];
  /** Worktree paths removed through `removeWorktree`. */
  readonly removedWorktrees: string[];
  /** Successful `push` calls, with the sha the branch stood at: what the remote now holds. */
  readonly pushed: { remote: string; branch: string; sha: string }[];
};

export const fakeGit = (overrides: Partial<FakeGitState> & { existing?: string[] } = {}): FakeGit => {
  const state: FakeGitState = {
    branches: {},
    dirty: new Set(),
    conflict: false,
    upToDate: false,
    merging: false,
    diff: [],
    ancestors: new Set(),
    commits: [],
    trees: {},
    worktrees: {},
    remoteAhead: false,
    diverged: false,
    ...overrides,
  };
  const existing = new Set(overrides.existing ?? ["main"]);
  const calls: string[] = [];
  const committed: FakeGit["committed"] = [];
  const removedWorktrees: string[] = [];
  const pushed: FakeGit["pushed"] = [];
  let seq = 0;
  let merges = 0;
  /** HEAD after a clean merge that moved it; the next commit clears it. */
  let mergeHead: string | undefined;

  const record = (name: string, ...args: unknown[]) => calls.push(`${name}(${args.map(String).join(", ")})`);
  const nextSha = () => `sha${++seq}`;
  const commit = async (cwd: string, message: string) => {
    record("commit", cwd, message);
    const sha = nextSha();
    committed.push({ cwd, message, sha });
    mergeHead = undefined;
    return sha;
  };

  return {
    state,
    existing,
    calls,
    committed,
    removedWorktrees,
    pushed,
    async currentBranch(cwd) {
      record("currentBranch", cwd);
      return state.branches[cwd] ?? "main";
    },
    async isDirty(cwd) {
      record("isDirty", cwd);
      return state.dirty.has(cwd);
    },
    async branchExists(cwd, name) {
      record("branchExists", cwd, name);
      return existing.has(name);
    },
    async createBranch(cwd, name, from) {
      record("createBranch", cwd, name, from);
      existing.add(name);
    },
    async deleteBranch(cwd, name, options = {}) {
      record("deleteBranch", cwd, name, options.force ?? false);
      existing.delete(name);
    },
    async mergeInto(cwd, source) {
      record("mergeInto", cwd, source);
      if (state.conflict) {
        state.merging = true;
        return { ok: false, conflicted: true, log: `CONFLICT (content): ${source}` };
      }
      if (state.upToDate) return { ok: true, conflicted: false, log: "Already up to date." };
      mergeHead = `merge${++merges}`;
      return { ok: true, conflicted: false, log: `Merge made by the 'ort' strategy.` };
    },
    async mergeInProgress(cwd) {
      record("mergeInProgress", cwd);
      return state.merging;
    },
    async diffNames(cwd, base) {
      record("diffNames", cwd, base);
      return [...state.diff];
    },
    async log(cwd, range) {
      record("log", cwd, range);
      return [...state.commits];
    },
    async squashMerge(mainCwd, branch, message) {
      record("squashMerge", mainCwd, branch, message);
      if (state.dirty.has(mainCwd)) throw new Error(`refusing to squash-merge: ${mainCwd} has uncommitted changes`);
      return commit(mainCwd, message);
    },
    async add(cwd, paths) {
      record("add", cwd, paths.join(" "));
    },
    commit,
    async headSha(cwd) {
      record("headSha", cwd);
      return mergeHead ?? committed.at(-1)?.sha ?? "sha0";
    },
    async treeSha(cwd, ref) {
      record("treeSha", cwd, ref);
      return state.trees[ref] ?? `tree:${ref}`;
    },
    async isAncestor(cwd, a, b) {
      record("isAncestor", cwd, a, b);
      return state.ancestors.has(`${a}..${b}`);
    },
    async fastForward(cwd, branch, remote) {
      record("fastForward", cwd, branch, remote);
      if (state.diverged) return false;
      if (state.remoteAhead) {
        for (const pair of [...state.ancestors]) if (pair.startsWith(`${branch}..`)) state.ancestors.delete(pair);
        state.remoteAhead = false;
      }
      return true;
    },
    async push(cwd, branch, remote) {
      record("push", cwd, branch, remote);
      if (state.pushError !== undefined) throw new Error(state.pushError);
      pushed.push({ remote, branch, sha: mergeHead ?? committed.at(-1)?.sha ?? "sha0" });
    },
    async removeWorktree(cwd, path) {
      record("removeWorktree", cwd, path);
      removedWorktrees.push(path);
      for (const [branch, at] of Object.entries(state.worktrees)) if (at === path) delete state.worktrees[branch];
    },
    async worktreeOf(cwd, branch) {
      record("worktreeOf", cwd, branch);
      return state.worktrees[branch];
    },
    async addWorktree(cwd, path, branch, base) {
      record("addWorktree", cwd, path, branch, base);
      existing.add(branch);
      state.worktrees[branch] = path;
    },
  };
};
