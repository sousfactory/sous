import { describe, expect, it } from "vitest";
import type { Event } from "sous-factory";
import { BRANCH, ctxOf, fakeGit, REPO, type FakeCtxOptions, type FakeGitState } from "sous-factory/testing";
import merge, { cleanUpMerged, mergeComment, mergeMessage, minorFindings } from "../../steps/merge/run.js";

const output = (step: string, scope: string, out: unknown): Event => ({
  type: "output",
  at: "2026-10-02T09:00:00.000Z",
  spanId: "r1-1",
  step,
  iteration: 1,
  scope,
  envelope: { summary: "s", commits: [], output: out },
  eval: { ok: true, logTail: "" },
});

const findings = [
  { severity: "blocker", file: "src/a.ts", line: 1, message: "wrong" },
  { severity: "minor", file: "src/a.ts", line: 3, message: "small thing" },
  { severity: "nit", file: "src/b.ts", message: "taste" },
];

const events: Event[] = [
  output("build", "14", { filesTouched: ["src/a.ts"], testsRun: [] }),
  output("review", "14", { verdict: "findings", findings }),
  output("review-full", "1", { verdict: "clean", findings: [] }),
];

const setup = (git: Partial<FakeGitState> & { existing?: string[] } = {}, options: FakeCtxOptions = {}) =>
  ctxOf({
    git: fakeGit({ existing: ["main", BRANCH], trees: { main: "t-main", [BRANCH]: "t-branch" }, ancestors: new Set([`main..${BRANCH}`]), ...git }),
    workProgress: { "1": { state: "open", commits: [] }, "14": { state: "done", commits: ["a", "b"] }, "15": { state: "done", commits: ["c"] } },
    events,
    ...options,
  });

describe("mergeMessage / minorFindings / mergeComment", () => {
  it("uses feat for features and fix for tasks and bugs", () => {
    expect(mergeMessage({ ref: "#1", title: "Add thing", labels: ["type:feature"] })).toBe("feat(#1): Add thing");
    expect(mergeMessage({ ref: "#2", title: "Fix thing", labels: ["type:task"] })).toBe("fix(#2): Fix thing");
    expect(mergeMessage({ ref: "#3", title: "Crash", labels: ["type:bug", "p1"] })).toBe("fix(#3): Crash");
    expect(mergeMessage({ ref: "#4", title: "No label", labels: [] })).toBe("feat(#4): No label");
  });

  it("collects the non-blocking findings of every review-shaped output, whatever the step id", () => {
    expect(minorFindings(events)).toEqual([findings[1], findings[2]]);
    expect(minorFindings([])).toEqual([]);
  });

  it("renders the squash, the sub-issues (never the issue's own entry) and the minors", () => {
    const progress = { "1": { state: "open" as const, commits: [] }, "14": { state: "done" as const, commits: ["a", "b"] } };
    const body = mergeComment({ baseBranch: "main", sha: "0123456789abcdef", message: "feat(#1): Test issue", issue: "1", workProgress: progress, minors: minorFindings(events) });
    expect(body).toBe(
      ["Merged into `main` as 0123456: `feat(#1): Test issue`", "", "Sub-issues:", "- 14: done, 2 commits", "", "Minor review findings (logged, not fixed):", "- minor src/a.ts:3 small thing", "- nit src/b.ts taste"].join("\n"),
    );
    expect(mergeComment({ baseBranch: "main", sha: "abc", message: "m", issue: "1", workProgress: { "1": { state: "open", commits: [] } }, minors: [] })).toBe("Merged into `main` as abc: `m`");
  });
});

describe("merge", () => {
  it("squashes the branch, cleans up, labels the issue merged, comments with sub-issues and minors, and marks the issue's work done; closing is the lifecycle's", async () => {
    const f = setup();
    const out = await merge(f.ctx, { baseBranch: "main", mergedLabel: "sous:merged", resync: true });

    expect(out).toEqual({ summary: `merge: squashed ${BRANCH} into main as sha1`, commits: ["sha1"], output: { stale: false, sha: "sha1" } });
    expect(f.git.calls).toEqual([
      `currentBranch(${REPO})`,
      `isDirty(${REPO})`,
      `branchExists(${REPO}, ${BRANCH})`,
      `treeSha(${REPO}, ${BRANCH})`,
      `treeSha(${REPO}, main)`,
      `isAncestor(${REPO}, main, ${BRANCH})`,
      `squashMerge(${REPO}, ${BRANCH}, feat(#1): Test issue)`,
      `commit(${REPO}, feat(#1): Test issue)`,
      `removeWorktree(${REPO}, /tmp/worktree)`,
      `branchExists(${REPO}, ${BRANCH})`,
      `deleteBranch(${REPO}, ${BRANCH}, true)`,
    ]);
    expect(f.sandbox.closed).toBe(true);
    expect(f.git.existing.has(BRANCH)).toBe(false);
    expect(f.tracker.issues.get("1")).toMatchObject({ state: "open", labels: ["sous:merged"] });
    expect(f.tracker.comments).toEqual([
      {
        issue: "1",
        body: ["Merged into `main` as sha1: `feat(#1): Test issue`", "", "Sub-issues:", "- 14: done, 2 commits", "- 15: done, 1 commit", "", "Minor review findings (logged, not fixed):", "- minor src/a.ts:3 small thing", "- nit src/b.ts taste"].join("\n"),
      },
    ]);
    expect(f.done).toEqual([{ work: "1", commits: ["sha1"] }]);
  });

  it("does the checks and the squash as one transaction under the repository lock; the cleanup runs outside it", async () => {
    const f = setup();
    await merge(f.ctx, { baseBranch: "main", resync: true });
    // Everything from the branch check to the commit: a merge by another run in between would land this branch on a base it never synced.
    expect(f.locked).toEqual(f.git.calls.slice(0, 8));
    expect(f.locked.at(-1)).toBe(`commit(${REPO}, feat(#1): Test issue)`);
    expect(f.git.calls.slice(8).map((c) => c.split("(")[0])).toEqual(["removeWorktree", "branchExists", "deleteBranch"]);
  });

  it("merges nothing and answers stale when main has commits the branch lacks: another run landed since the last sync", async () => {
    const f = setup({ ancestors: new Set() });
    const out = await merge(f.ctx, { baseBranch: "main", mergedLabel: "sous:merged", resync: true });
    expect(out).toEqual({ summary: `merge: main moved since the last sync; nothing merged, ${BRANCH} syncs again`, commits: [], output: { stale: true } });
    expect(f.git.calls.at(-1)).toBe(`isAncestor(${REPO}, main, ${BRANCH})`);
    expect(f.locked).toEqual(f.git.calls);
    expect(f.git.committed).toEqual([]);
    expect(f.sandbox.closed).toBe(false);
    expect(f.git.existing.has(BRANCH)).toBe(true);
    expect(f.tracker.issues.get("1")?.labels).toEqual([]);
    expect(f.tracker.comments).toEqual([]);
    expect(f.done).toEqual([]);
  });

  it("an already squashed branch counts as merged even though main has moved past it", async () => {
    const f = setup({ ancestors: new Set(), trees: { main: "same", [BRANCH]: "same" } });
    expect((await merge(f.ctx, { baseBranch: "main", resync: true })).output).toEqual({ stale: false, sha: "sha0" });
    expect(f.git.calls.some((c) => c.startsWith("isAncestor"))).toBe(false);
  });

  it("without resync squashes onto a moved main without asking", async () => {
    const f = setup({ ancestors: new Set() });
    expect((await merge(f.ctx, { baseBranch: "main" })).output).toEqual({ stale: false, sha: "sha1" });
    expect(f.git.calls.some((c) => c.startsWith("isAncestor"))).toBe(false);
  });

  it("refuses a dirty base-branch checkout before touching anything", async () => {
    const f = setup({ dirty: new Set([REPO]) });
    await expect(merge(f.ctx, { baseBranch: "main" })).rejects.toThrow(`merge: refusing to merge: the main checkout at ${REPO} has uncommitted changes`);
    expect(f.git.calls).toEqual([`currentBranch(${REPO})`, `isDirty(${REPO})`]);
    expect(f.sandbox.closed).toBe(false);
    expect(f.tracker.issues.get("1")?.state).toBe("open");
  });

  it("refuses when the repository checkout is not on the base branch", async () => {
    const f = setup({ branches: { [REPO]: "feature/other" } });
    await expect(merge(f.ctx, { baseBranch: "main" })).rejects.toThrow(`merge: refusing to merge: ${REPO} has feature/other checked out, not main`);
    expect(f.git.calls).toEqual([`currentBranch(${REPO})`]);
  });

  it("detects an already squashed branch by tree, skips the squash, still cleans up, labels and comments", async () => {
    const f = setup({ trees: { main: "same", [BRANCH]: "same" } });
    const out = await merge(f.ctx, { baseBranch: "main", mergedLabel: "sous:merged" });
    expect(out).toEqual({ summary: `merge: ${BRANCH} was already in main (sha0); cleaned up`, commits: [], output: { stale: false, sha: "sha0" } });
    expect(f.git.calls).not.toContain(`squashMerge(${REPO}, ${BRANCH}, feat(#1): Test issue)`);
    expect(f.git.calls).toContain(`deleteBranch(${REPO}, ${BRANCH}, true)`);
    expect(f.sandbox.closed).toBe(true);
    expect(f.tracker.issues.get("1")).toMatchObject({ state: "open", labels: ["sous:merged"] });
    expect(f.tracker.comments[0]?.body).toContain("Merged into `main` as sha0:");
  });

  it("treats a branch that is already gone as merged and skips the branch deletion", async () => {
    const f = setup({ existing: ["main"] });
    const out = await merge(f.ctx, { baseBranch: "main", mergedLabel: "sous:merged" });
    expect(out.output).toEqual({ stale: false, sha: "sha0" });
    expect(f.git.calls.filter((c) => c.startsWith("treeSha") || c.startsWith("deleteBranch") || c.startsWith("squashMerge"))).toEqual([]);
    expect(f.git.removedWorktrees).toEqual(["/tmp/worktree"]);
    expect(f.tracker.issues.get("1")?.labels).toEqual(["sous:merged"]);
  });

  it("uses fix(#N) for a task and takes the base branch from the input", async () => {
    const f = setup({ existing: ["develop", BRANCH], trees: { develop: "t-dev", [BRANCH]: "t-branch" }, ancestors: new Set([`develop..${BRANCH}`]), branches: { [REPO]: "develop" } }, { issue: { id: "1", ref: "#1", title: "Test issue", labels: ["type:task"] } });
    await merge(f.ctx, { baseBranch: "develop" });
    expect(f.git.committed).toEqual([{ cwd: REPO, message: "fix(#1): Test issue", sha: "sha1" }]);
    expect(f.tracker.comments[0]?.body).toContain("Merged into `develop` as sha1: `fix(#1): Test issue`");
  });

  it("cleanUpMerged closes the sandbox, removes the worktree and deletes the branch, skipping a branch already gone", async () => {
    const f = setup({ existing: ["main"] });
    await cleanUpMerged(f.ctx);
    expect(f.sandbox.closed).toBe(true);
    expect(f.git.calls).toEqual([`removeWorktree(${REPO}, /tmp/worktree)`, `branchExists(${REPO}, ${BRANCH})`]);
  });

  it("never pushes and requires baseBranch", async () => {
    const f = setup();
    await merge(f.ctx, { baseBranch: "main" });
    expect(f.git.calls.some((c) => c.includes("push"))).toBe(false);
    await expect(merge(setup().ctx, {})).rejects.toThrow('merge: input "baseBranch" must be a non-empty string');
  });

  it("without mergedLabel it sets no label, and never closes the issue itself", async () => {
    const f = setup();
    await merge(f.ctx, { baseBranch: "main" });
    expect(f.tracker.issues.get("1")).toMatchObject({ state: "open", labels: [] });
    expect(f.tracker.comments).toHaveLength(1);
  });
});
