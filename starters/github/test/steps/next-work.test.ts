import { describe, expect, it } from "vitest";
import { ctxOf, fakeTracker, issue, type FakeTracker } from "sous-factory/testing";
import nextWork, { chooseWork } from "../../steps/next-work/run.js";

type Issue = ReturnType<typeof issue>;

const sub = (id: string, blockedBy = "None", state: Issue["state"] = "open"): Issue =>
  issue({ id, title: `Work ${id}`, body: `## Acceptance criteria\n- [ ] works\n\n## Blocked by\n${blockedBy}\n`, state });

/** The parent #1 with `subs` as its sub-issues, in the tracker's pick order, plus `others`. */
const tracker = (subs: Issue[], others: Issue[] = []): FakeTracker =>
  fakeTracker({ issues: [issue({ id: "1" }), ...subs, ...others], subIssues: { "1": subs.map((s) => s.id) } });

describe("chooseWork", () => {
  it("takes the first child with no open blockers and lists the ones it skipped", () => {
    const open = [
      { id: "15", blockedBy: ["14"] },
      { id: "16", blockedBy: ["15"] },
      { id: "17", blockedBy: [] },
    ];
    expect(chooseWork(open)).toEqual({ work: "17", waiting: [{ id: "15", on: ["14"] }, { id: "16", on: ["15"] }] });
    expect(chooseWork([{ id: "15", blockedBy: [] }])).toEqual({ work: "15", waiting: [] });
    expect(chooseWork([])).toEqual({ waiting: [] });
  });
});

describe("next-work", () => {
  it("picks the first open sub-issue with no open blockers, in the tracker's order, and puts it on the bench", async () => {
    const f = ctxOf({ tracker: tracker([sub("14"), sub("15", "- #14"), sub("16")]) });
    const out = await nextWork(f.ctx);
    expect(out).toEqual({ summary: "next work: #14 Work 14", commits: [], output: { work: { id: "14", ref: "#14", title: "Work 14", body: sub("14").body }, remaining: 3 } });
    expect(f.ctx.work).toEqual({ id: "14", ref: "#14", title: "Work 14", body: sub("14").body });
  });

  it("skips closed sub-issues and treats them as satisfied blockers", async () => {
    const f = ctxOf({ tracker: tracker([sub("14", "None", "closed"), sub("15", "- #14"), sub("16", "#15")]) });
    const out = await nextWork(f.ctx);
    expect(out.output).toMatchObject({ work: { id: "15" }, remaining: 2 });
  });

  it("looks up blockers outside the sub-issue set", async () => {
    const f = ctxOf({ tracker: tracker([sub("14", "- #99"), sub("15", "- #98")], [issue({ id: "99", state: "open" }), issue({ id: "98", state: "closed" })]) });
    const out = await nextWork(f.ctx);
    expect(out.output).toMatchObject({ work: { id: "15" }, remaining: 2 });
    expect(f.ctx.work.id).toBe("15");
  });

  it("reports none left: work null, remaining 0, the bench untouched", async () => {
    const f = ctxOf({ tracker: tracker([sub("14", "None", "closed"), sub("15", "None", "closed")]), work: { id: "15", ref: "#15", title: "Work 15", body: "" } });
    const out = await nextWork(f.ctx);
    expect(out).toEqual({ summary: "no open sub-issues left", commits: [], output: { work: null, remaining: 0 } });
    expect(f.ctx.work.id).toBe("15");
  });

  it("reports all blocked: work null, remaining > 0, the blockers in the summary", async () => {
    const f = ctxOf({ tracker: tracker([sub("14", "- #99"), sub("15", "- #14, #16"), sub("16", "#99")], [issue({ id: "99" })]) });
    const out = await nextWork(f.ctx);
    expect(out.output).toEqual({ work: null, remaining: 3 });
    expect(out.summary).toBe("all 3 open sub-issues are blocked:\n- 14 blocked by 99\n- 15 blocked by 14, 16\n- 16 blocked by 99");
    expect(f.ctx.work.id).toBe("1");
  });

  it("has nothing to pick without sub-issues", async () => {
    const f = ctxOf();
    expect((await nextWork(f.ctx)).output).toEqual({ work: null, remaining: 0 });
  });

  it("refuses a child that has children of its own", async () => {
    const t = tracker([sub("14")]);
    t.subIssues.set("14", ["140"]);
    const f = ctxOf({ tracker: t });
    await expect(nextWork(f.ctx)).rejects.toThrow("next-work: #14 has children of its own; nested work items are not supported");
  });
});
