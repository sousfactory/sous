import { describe, expect, it } from "vitest";
import { BRANCH, ctxOf, fakeGit, fakeTracker, issue } from "sous-factory/testing";
import init from "../../steps/init/run.js";

describe("init", () => {
  it("passes an open issue on the run's branch, writes and commits nothing; the issue is left to the lifecycle", async () => {
    const f = ctxOf({ issue: { id: "1", ref: "#1", title: "Test issue", body: "Do the thing" } });
    const out = await init(f.ctx);

    expect(out).toEqual({ summary: `init: #1 is open, the worktree is on ${BRANCH}`, commits: [], output: {} });
    expect(f.git.calls).toEqual(["currentBranch(/tmp/worktree)"]);
    expect(f.tracker.issues.get("1")?.labels).toEqual([]);
    expect(f.tracker.claims).toEqual([]);
  });

  it("refuses a closed issue", async () => {
    const f = ctxOf({ issue: { id: "1", state: "closed" } });
    await expect(init(f.ctx)).rejects.toThrow("init: #1 is closed; sous runs open issues only");
    expect(f.git.calls).toEqual([]);
  });

  it("runs a sub-issue like any other: its label put it in the flow", async () => {
    const tracker = fakeTracker({ issues: [issue({ id: "5" }), issue({ id: "1" })], subIssues: { "5": ["1"] } });
    const f = ctxOf({ tracker });
    expect((await init(f.ctx)).output).toEqual({});
  });

  it("refuses a worktree on another branch", async () => {
    const f = ctxOf({ git: fakeGit({ existing: ["main", BRANCH] }) });
    await expect(init(f.ctx)).rejects.toThrow(`init: the worktree is on main, the session expects ${BRANCH}`);
  });
});
