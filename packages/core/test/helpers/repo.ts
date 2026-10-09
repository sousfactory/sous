import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exec, must } from "../../src/adapters/exec.js";

/** A real temporary git repository with one commit on `main`. */
export type TempRepo = {
  readonly dir: string;
  git(args: readonly string[], cwd?: string): Promise<string>;
  /** Writes `content` to `file` under `cwd`, stages and commits it. */
  commitFile(file: string, content: string, message?: string, cwd?: string): Promise<string>;
  /** Checks `branch` out in a sibling worktree and returns its path. */
  worktree(branch: string): Promise<string>;
  cleanup(): Promise<void>;
};

const identity = { GIT_AUTHOR_NAME: "sous test", GIT_AUTHOR_EMAIL: "sous@test", GIT_COMMITTER_NAME: "sous test", GIT_COMMITTER_EMAIL: "sous@test" };

export const tempRepo = async (): Promise<TempRepo> => {
  const root = await mkdtemp(join(tmpdir(), "sous-git-"));
  const dir = join(root, "repo");
  const git = async (args: readonly string[], cwd = dir) => must(await exec("git", args, { cwd, env: identity }), `git ${args[0]}`);

  await git(["init", "-q", "-b", "main", dir], root);
  await git(["config", "commit.gpgsign", "false"]);

  const commitFile = async (file: string, content: string, message = `add ${file}`, cwd = dir) => {
    await mkdir(dirname(join(cwd, file)), { recursive: true });
    await writeFile(join(cwd, file), content, "utf8");
    await git(["add", "--", file], cwd);
    await git(["commit", "-q", "-m", message], cwd);
    return git(["rev-parse", "HEAD"], cwd);
  };
  await commitFile("README.md", "hello\n", "initial");

  let worktrees = 0;
  return {
    dir,
    git,
    commitFile,
    async worktree(branch) {
      const path = join(root, `wt-${++worktrees}`);
      await git(["worktree", "add", "-q", path, branch]);
      return path;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};
