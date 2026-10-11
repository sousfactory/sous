/** Git over the `git` CLI: one subprocess per call, no decisions beyond exit codes. */
import { access } from "node:fs/promises";
import type { Commit, Git } from "../ports/git.js";
import { exec as defaultExec, ExecError, must, type Exec } from "./exec.js";

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const lines = (out: string): string[] => out.split("\n").filter((l) => l.length > 0);

export const createGit = (exec: Exec = defaultExec): Git => {
  const git = (cwd: string, args: readonly string[]) => exec("git", args, { cwd });
  const run = async (cwd: string, args: readonly string[]) => must(await git(cwd, args), `git ${args[0]}`);
  const succeeds = async (cwd: string, args: readonly string[]) => (await git(cwd, args)).code === 0;

  const headSha = (cwd: string) => run(cwd, ["rev-parse", "HEAD"]);
  const isDirty = async (cwd: string) => (await run(cwd, ["status", "--porcelain", "--untracked-files=no"])).length > 0;
  const hasConflicts = async (cwd: string) => (await run(cwd, ["diff", "--name-only", "--diff-filter=U"])).length > 0;
  const mergeInProgress = (cwd: string) => succeeds(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);

  const commit = async (cwd: string, message: string) => {
    if (await succeeds(cwd, ["diff", "--cached", "--quiet"])) return undefined;
    await run(cwd, ["commit", "-m", message]);
    return headSha(cwd);
  };

  return {
    currentBranch: (cwd) => run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    isDirty,
    branchExists: (cwd, name) => succeeds(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]),
    async createBranch(cwd, name, from) {
      await run(cwd, ["branch", name, from]);
    },
    async deleteBranch(cwd, name, options = {}) {
      await run(cwd, ["branch", options.force ? "-D" : "-d", name]);
    },
    async mergeInto(cwd, source) {
      const result = await git(cwd, ["merge", "--no-edit", source]);
      const ok = result.code === 0;
      return { ok, conflicted: !ok && (await mergeInProgress(cwd)), log: `${result.stdout}${result.stderr}` };
    },
    mergeInProgress,
    diffNames: async (cwd, base) => lines(await run(cwd, ["diff", "--name-only", `${base}...HEAD`])),
    log: async (cwd, range) =>
      lines(await run(cwd, ["log", "--format=%H%x09%s", range])).map((line): Commit => {
        const [sha = "", ...rest] = line.split("\t");
        return { sha, subject: rest.join("\t") };
      }),
    async squashMerge(mainCwd, branch, message) {
      if (await isDirty(mainCwd)) throw new Error(`refusing to squash-merge: ${mainCwd} has uncommitted changes`);
      const merge = await git(mainCwd, ["merge", "--squash", branch]);
      if (merge.code !== 0) {
        // Only a squash that stopped on conflicts has staged anything of
        // ours. One that failed before touching the index (an `index.lock`
        // another process holds, an unknown branch) left the checkout as it
        // was, and a reset would discard what someone else has staged there.
        if (await hasConflicts(mainCwd)) await git(mainCwd, ["reset", "--merge"]);
        must(merge, `git merge --squash ${branch}`);
      }
      const sha = await commit(mainCwd, message);
      if (sha === undefined) throw new Error(`nothing to squash-merge from ${branch}`);
      return sha;
    },
    async add(cwd, paths) {
      await run(cwd, ["add", "--", ...paths]);
    },
    commit,
    headSha,
    treeSha: (cwd, ref) => run(cwd, ["rev-parse", `${ref}^{tree}`]),
    async isAncestor(cwd, a, b) {
      const result = await git(cwd, ["merge-base", "--is-ancestor", a, b]);
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      throw new ExecError("git merge-base", result);
    },
    async removeWorktree(cwd, path) {
      if (await exists(path)) await run(cwd, ["worktree", "remove", "--force", path]);
      await run(cwd, ["worktree", "prune"]);
    },
  };
};
