import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exec } from "../../src/adapters/exec.js";
import { createGit, worktreeList } from "../../src/adapters/git.js";
import type { Git } from "../../src/ports/git.js";
import { tempRepo, type TempRepo } from "../helpers/repo.js";

describe("git adapter (real repository)", () => {
  let repo: TempRepo;
  let git: Git;
  let main: string;

  beforeEach(async () => {
    repo = await tempRepo();
    git = createGit();
    main = repo.dir;
  });
  afterEach(() => repo.cleanup());

  it("reports branch, head and branch existence; creates and deletes branches", async () => {
    expect(await git.currentBranch(main)).toBe("main");
    expect(await git.headSha(main)).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.branchExists(main, "feature/1-x")).toBe(false);

    await git.createBranch(main, "feature/1-x", "main");
    expect(await git.branchExists(main, "feature/1-x")).toBe(true);

    await git.deleteBranch(main, "feature/1-x");
    expect(await git.branchExists(main, "feature/1-x")).toBe(false);
  });

  it("deleteBranch needs force for an unmerged branch", async () => {
    await git.createBranch(main, "feature/1-x", "main");
    const wt = await repo.worktree("feature/1-x");
    await repo.commitFile("a.txt", "a\n", "feat: a", wt);
    await repo.git(["worktree", "remove", "--force", wt]);

    await expect(git.deleteBranch(main, "feature/1-x")).rejects.toThrow(/not fully merged/);
    await git.deleteBranch(main, "feature/1-x", { force: true });
    expect(await git.branchExists(main, "feature/1-x")).toBe(false);
  });

  it("isDirty sees modified tracked files but not untracked ones", async () => {
    expect(await git.isDirty(main)).toBe(false);
    await writeFile(join(main, "scratch.txt"), "x\n");
    expect(await git.isDirty(main)).toBe(false);
    await writeFile(join(main, "README.md"), "changed\n");
    expect(await git.isDirty(main)).toBe(true);
  });

  it("commit returns undefined with nothing staged and the new sha otherwise", async () => {
    expect(await git.commit(main, "empty")).toBeUndefined();
    await writeFile(join(main, "b.txt"), "b\n");
    await git.add(main, [join(main, "b.txt")]);
    const sha = await git.commit(main, "feat: b");
    expect(sha).toBe(await git.headSha(main));
    expect(await git.log(main, "-1")).toEqual([{ sha, subject: "feat: b" }]);
  });

  it("mergeInto merges cleanly and log lists the range", async () => {
    await git.createBranch(main, "feature/1-x", "main");
    const wt = await repo.worktree("feature/1-x");
    const onBranch = await repo.commitFile("a.txt", "a\n", "feat: a", wt);
    const onMain = await repo.commitFile("c.txt", "c\n", "chore: c");

    const result = await git.mergeInto(wt, "main");
    expect(result).toMatchObject({ ok: true, conflicted: false });
    expect(await git.mergeInProgress(wt)).toBe(false);
    expect(await git.isAncestor(wt, onMain, "HEAD")).toBe(true);
    expect((await git.log(wt, "main..HEAD")).map((c) => c.sha)).toContain(onBranch);
  });

  it("mergeInto reports a conflict and leaves the merge in progress", async () => {
    await git.createBranch(main, "feature/1-x", "main");
    const wt = await repo.worktree("feature/1-x");
    await repo.commitFile("README.md", "branch\n", "feat: branch", wt);
    await repo.commitFile("README.md", "main\n", "chore: main");

    const result = await git.mergeInto(wt, "main");
    expect(result.ok).toBe(false);
    expect(result.conflicted).toBe(true);
    expect(result.log).toMatch(/CONFLICT/);
    expect(await git.mergeInProgress(wt)).toBe(true);

    await repo.git(["merge", "--abort"], wt);
    expect(await git.mergeInProgress(wt)).toBe(false);
  });

  it("diffNames lists paths changed on the branch, not those changed on main", async () => {
    await git.createBranch(main, "feature/1-x", "main");
    const wt = await repo.worktree("feature/1-x");
    await repo.commitFile("infra/Stack.kt", "x\n", "feat: infra", wt);
    await repo.commitFile("src/App.kt", "y\n", "feat: app", wt);
    await repo.commitFile("docs.md", "d\n", "docs: main only");

    expect(await git.diffNames(wt, "main")).toEqual(["infra/Stack.kt", "src/App.kt"]);
    expect(await git.diffNames(main, "main")).toEqual([]);
  });

  it("squashMerge lands one commit on main with the given message", async () => {
    await git.createBranch(main, "feature/1-x", "main");
    const wt = await repo.worktree("feature/1-x");
    await repo.commitFile("a.txt", "a\n", "feat: a", wt);
    await repo.commitFile("b.txt", "b\n", "feat: b", wt);
    const before = await git.headSha(main);

    const sha = await git.squashMerge(main, "feature/1-x", "feat(#1): squash");

    expect(sha).toBe(await git.headSha(main));
    expect(await git.log(main, `${before}..HEAD`)).toEqual([{ sha, subject: "feat(#1): squash" }]);
    // Same tree as the branch, but a squash is not an ancestor of it.
    expect(await repo.git(["diff", "--stat", "main", "feature/1-x"])).toBe("");
    expect(await git.isAncestor(main, "feature/1-x", "main")).toBe(false);
    expect(await git.isDirty(main)).toBe(false);
  });

  it("squashMerge refuses a dirty main checkout and when there is nothing to merge", async () => {
    await git.createBranch(main, "feature/1-x", "main");
    await expect(git.squashMerge(main, "feature/1-x", "noop")).rejects.toThrow(/nothing to squash-merge/);

    const wt = await repo.worktree("feature/1-x");
    await repo.commitFile("a.txt", "a\n", "feat: a", wt);
    await writeFile(join(main, "README.md"), "dirty\n");
    await expect(git.squashMerge(main, "feature/1-x", "feat")).rejects.toThrow(/uncommitted changes/);
  });

  it("squashMerge undoes a squash that stopped on conflicts, and resets nothing when the merge failed before staging anything", async () => {
    const calls: string[] = [];
    const recording = createGit((command, args, options) => {
      calls.push(args.join(" "));
      return exec(command, args, options);
    });
    await recording.createBranch(main, "feature/1-x", "main");
    const wt = await repo.worktree("feature/1-x");
    await repo.commitFile("README.md", "branch\n", "feat: branch", wt);
    await repo.commitFile("README.md", "main\n", "chore: main");

    await expect(recording.squashMerge(main, "feature/1-x", "feat")).rejects.toThrow(/git merge --squash feature\/1-x failed/);
    expect(calls).toContain("reset --merge");
    expect(await recording.isDirty(main)).toBe(false);

    // A failure before the index was touched (here an unknown branch; in a run, another process's index.lock) must not reset what someone else staged.
    calls.length = 0;
    await expect(recording.squashMerge(main, "nope", "feat")).rejects.toThrow(/git merge --squash nope failed/);
    expect(calls).not.toContain("reset --merge");
  });

  it("isAncestor answers both ways and rejects unknown revisions", async () => {
    const first = await git.headSha(main);
    const second = await repo.commitFile("z.txt", "z\n");
    expect(await git.isAncestor(main, first, second)).toBe(true);
    expect(await git.isAncestor(main, second, first)).toBe(false);
    await expect(git.isAncestor(main, "nope", first)).rejects.toThrow(/git merge-base failed/);
  });

  it("treeSha differs while the branch has work and matches after a squash", async () => {
    await git.createBranch(main, "feature/1-x", "main");
    expect(await git.treeSha(main, "feature/1-x")).toBe(await git.treeSha(main, "main"));
    const wt = await repo.worktree("feature/1-x");
    await repo.commitFile("a.txt", "a\n", "feat: a", wt);
    expect(await git.treeSha(main, "feature/1-x")).not.toBe(await git.treeSha(main, "main"));

    await git.squashMerge(main, "feature/1-x", "feat(#1): a");
    expect(await git.treeSha(main, "feature/1-x")).toBe(await git.treeSha(main, "main"));
    await expect(git.treeSha(main, "nope")).rejects.toThrow(/git rev-parse failed/);
  });

  it("addWorktree checks a branch out at a path, creating it from the base when new; worktreeOf finds it, or the primary checkout", async () => {
    const wt = join(repo.dir, ".sous", "worktrees", "feature-2-y");
    expect(await git.worktreeOf(main, "feature/2-y")).toBeUndefined();
    expect(await git.worktreeOf(main, "main")).toBe(await realpath(main));

    await git.addWorktree(main, wt, "feature/2-y", "main");
    expect(await git.branchExists(main, "feature/2-y")).toBe(true);
    expect(await git.currentBranch(wt)).toBe("feature/2-y");
    expect(await git.worktreeOf(main, "feature/2-y")).toBe(await realpath(wt));

    // An existing branch is checked out where it stands, not recreated from the base.
    const sha = await repo.commitFile("y.txt", "y\n", "feat: y", wt);
    await git.removeWorktree(main, wt);
    const again = join(repo.dir, ".sous", "worktrees", "again");
    await git.addWorktree(main, again, "feature/2-y", "main");
    expect(await git.currentBranch(again)).toBe("feature/2-y");
    expect(await git.headSha(again)).toBe(sha);
  });

  it("worktreeList reads the porcelain blocks", () => {
    expect(worktreeList("worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/.sous/worktrees/f-1\nHEAD def\nbranch refs/heads/feature/1\n\nworktree /r/detached\nHEAD 123\ndetached\n")).toEqual([
      { path: "/r", branch: "main" },
      { path: "/r/.sous/worktrees/f-1", branch: "feature/1" },
      { path: "/r/detached" },
    ]);
    expect(worktreeList("")).toEqual([]);
  });

  it("removeWorktree removes a registered worktree and tolerates a missing path", async () => {
    await git.createBranch(main, "feature/1-x", "main");
    const wt = await repo.worktree("feature/1-x");
    await writeFile(join(wt, "dirty.txt"), "x\n");

    await git.removeWorktree(main, wt);
    expect(await repo.git(["worktree", "list", "--porcelain"])).not.toContain(wt);
    await git.removeWorktree(main, wt);
    await git.deleteBranch(main, "feature/1-x");
  });
});
