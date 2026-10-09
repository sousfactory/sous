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
};

export type FakeGit = Git & {
  readonly state: FakeGitState;
  readonly existing: Set<string>;
  readonly calls: string[];
  /** Commit messages created through `commit` and `squashMerge`. */
  readonly committed: { cwd: string; message: string; sha: string }[];
  /** Worktree paths removed through `removeWorktree`. */
  readonly removedWorktrees: string[];
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
    ...overrides,
  };
  const existing = new Set(overrides.existing ?? ["main"]);
  const calls: string[] = [];
  const committed: FakeGit["committed"] = [];
  const removedWorktrees: string[] = [];
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
    async removeWorktree(cwd, path) {
      record("removeWorktree", cwd, path);
      removedWorktrees.push(path);
    },
  };
};
