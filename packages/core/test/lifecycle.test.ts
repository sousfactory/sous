import { describe, expect, it } from "vitest";
import { recordVisit, type Session } from "../src/exec/scope.js";
import { blockedComment, createLifecycle, type LifecycleMode } from "../src/lifecycle.js";
import { bumpIteration, createSession, markBlocked, setCurrent, setWork } from "../src/session/update.js";
import { fakeTracker, issue } from "./fakes/tracker.js";

const fresh = (): Session => createSession({ flow: "task", issue: "1", title: "Test issue", branch: "feature/1-test", specDir: "specs/1-test", entry: "init" });

/** Stopped in `fix` after three iterations, the last eval having failed. */
const blocked = (): Session => {
  let s = setCurrent(setWork(fresh(), "14"), "fix");
  s = bumpIteration(bumpIteration(bumpIteration(s, "fix"), "fix"), "fix");
  s = recordVisit(s, "fix", { ok: false, log: "> Task :test FAILED\nBUILD FAILED", output: {}, commits: [] });
  return markBlocked(s);
};

const WT = "/repo/.sandcastle/worktrees/feature-1-test";

describe("blockedComment", () => {
  it("names the step, iteration, eval tail of the current scope, worktree and how to resume", () => {
    expect(blockedComment(blocked(), WT)).toBe(
      [
        "Blocked in `fix` after 3 iterations.",
        "",
        "Last eval:",
        "```",
        "> Task :test FAILED",
        "BUILD FAILED",
        "```",
        "",
        `Worktree kept at \`${WT}\` on \`feature/1-test\`.`,
        "Fix things by hand there, then run `sous run task 1` again; it re-enters at this step's eval.",
      ].join("\n"),
    );
  });

  it("omits the eval block when the step has no record in the current scope", () => {
    const session = setCurrent(recordVisit(fresh(), "build", { ok: true, log: "x", output: {}, commits: [] }), "next-work");
    const text = blockedComment(session, "/wt");
    expect(text).toContain("Blocked in `next-work` after 0 iterations.");
    expect(text).not.toContain("Last eval");
    expect(blockedComment(bumpIteration(session, "next-work"), "/wt")).toContain("after 1 iteration.");
  });
});

describe("createLifecycle", () => {
  const setup = (mode: LifecycleMode = "core") => {
    const tracker = fakeTracker({ issues: [issue({ id: "1", labels: ["type:task"] })] });
    return { tracker, lifecycle: createLifecycle({ tracker, issue: "1", mode }) };
  };

  it("core: claims for the branch, blocks with the comment, closes", async () => {
    const { tracker, lifecycle } = setup();
    await lifecycle.claim("feature/1-test");
    expect(tracker.claims).toEqual([{ issue: "1", branch: "feature/1-test" }]);
    expect(tracker.issues.get("1")?.labels).toEqual(["type:task", "sous:running"]);

    await lifecycle.block(blocked(), WT);
    expect(tracker.issues.get("1")?.labels).toEqual(["type:task", "sous:blocked"]);
    expect(tracker.comments).toEqual([{ issue: "1", body: expect.stringContaining("Blocked in `fix`") }]);

    await lifecycle.claim("feature/1-test");
    expect(tracker.issues.get("1")?.labels).toEqual(["type:task", "sous:running"]);

    await lifecycle.close();
    expect(tracker.issues.get("1")?.state).toBe("closed");
    expect(tracker.comments).toHaveLength(1);
  });

  it("steps: writes nothing at all", async () => {
    const { tracker, lifecycle } = setup("steps");
    await lifecycle.claim("feature/1-test");
    await lifecycle.block(blocked(), WT);
    await lifecycle.close();
    expect(tracker.claims).toEqual([]);
    expect(tracker.comments).toEqual([]);
    expect(tracker.issues.get("1")).toMatchObject({ state: "open", labels: ["type:task"] });
  });
});
