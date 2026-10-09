import { describe, expect, it } from "vitest";
import { BRANCH, ctxOf, fakeTracker, issue } from "sous-factory/testing";
import closeWork, { closeWorkComment, commitsInput } from "../../steps/close-work/run.js";

const work14 = { id: "14", ref: "#14", title: "Work 14", body: "do 14" };

const setup = (state: "open" | "closed" = "open", workProgress = {}) => ctxOf({ tracker: fakeTracker({ issues: [issue({ id: "14", state })] }), work: work14, workProgress });

describe("commitsInput / closeWorkComment", () => {
  it("accepts an array of shas or the same as a JSON string, deduplicated, and rejects anything else", () => {
    expect(commitsInput(["a", "b", "a"])).toEqual(["a", "b"]);
    expect(commitsInput('["a","b"]')).toEqual(["a", "b"]);
    expect(commitsInput([])).toEqual([]);
    expect(() => commitsInput("a, b")).toThrow('close-work: input "commits" is not a JSON array: a, b');
    expect(() => commitsInput('{"a":1}')).toThrow("must be an array of shas or a JSON array string");
    expect(() => commitsInput([1])).toThrow("must be an array of shas or a JSON array string");
    expect(() => commitsInput(undefined)).toThrow("must be an array of shas or a JSON array string");
  });

  it("renders the comment", () => {
    expect(closeWorkComment("#1", "feature/1-x", ["abc", "def"])).toBe("Landed on `feature/1-x` for #1.\n\n- abc\n- def");
    expect(closeWorkComment("#1", "feature/1-x", [])).toBe("Landed on `feature/1-x` for #1.\n\n_No commits reported._");
  });
});

describe("close-work", () => {
  it("comments the commits, closes the sub-issue and marks the work done with them", async () => {
    const f = setup();
    const out = await closeWork(f.ctx, { commits: ["a", "b"] });

    expect(out).toEqual({ summary: "close-work: closed #14 with 2 commits", commits: [], output: { work: work14 } });
    expect(f.tracker.comments).toEqual([{ issue: "14", body: `Landed on \`${BRANCH}\` for #1.\n\n- a\n- b` }]);
    expect(f.tracker.issues.get("14")?.state).toBe("closed");
    expect(f.done).toEqual([{ work: "14", commits: ["a", "b"] }]);
    expect(f.ctx.work).toEqual(work14);
  });

  it("takes the commits as the JSON string a templated with: value produces", async () => {
    const f = setup();
    await closeWork(f.ctx, { commits: '["c"]' });
    expect(f.done).toEqual([{ work: "14", commits: ["c"] }]);
    expect(f.tracker.comments[0]?.body).toContain("- c");
  });

  it("is idempotent: a closed sub-issue gets no second comment and a done item is not marked again", async () => {
    const f = setup("closed", { "14": { state: "done", commits: ["a"] } });
    const out = await closeWork(f.ctx, { commits: ["a"] });
    expect(out.summary).toBe("close-work: #14 was already closed");
    expect(f.tracker.comments).toEqual([]);
    expect(f.done).toEqual([]);
  });

  it("still marks the work done when the sub-issue was closed by hand", async () => {
    const f = setup("closed");
    await closeWork(f.ctx, { commits: [] });
    expect(f.tracker.comments).toEqual([]);
    expect(f.done).toEqual([{ work: "14", commits: [] }]);
  });

  it("refuses the issue itself on the bench, and fails before touching Tracker on malformed commits", async () => {
    await expect(closeWork(ctxOf().ctx, { commits: [] })).rejects.toThrow("close-work: #1 is the issue itself, not a sub-issue; merge closes it");
    const f = setup();
    await expect(closeWork(f.ctx, { commits: "nope" })).rejects.toThrow('input "commits"');
    expect(f.tracker.issues.get("14")?.state).toBe("open");
  });
});
