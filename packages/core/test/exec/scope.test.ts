import { describe, expect, it } from "vitest";
import { openVisit, recordVisit, scopeKey, stepsOf, type Session } from "../../src/exec/scope.js";
import { createSession, setWork } from "../../src/session/update.js";

const fresh = (): Session =>
  createSession({ flow: "feature", issue: "12", title: "Some slug", branch: "feature/12-some-slug", specDir: "specs/12-some-slug", entry: "init" });

const visit = { ok: true, log: "", output: { filesTouched: ["a.kt"] }, commits: ["c1"], session: "s1" };

describe("scopeKey", () => {
  it("is the work item's number as a string; the issue's own number is the full-branch scope", () => {
    expect(scopeKey("14")).toBe("14");
    expect(scopeKey("12")).toBe("12");
  });
});

describe("recordVisit / stepsOf", () => {
  it("records the first visit of a step in the current scope with visits 1", () => {
    const s = recordVisit(setWork(fresh(), "14"), "build", visit);
    expect(s.scopes).toEqual({ "12": {}, "14": { build: { ...visit, visits: 1 } } });
    expect(stepsOf(s)).toEqual({ build: { ...visit, visits: 1 } });
    expect(stepsOf(s)["review"]).toBeUndefined();
  });

  it("replaces the record on a later visit and counts it", () => {
    let s = recordVisit(setWork(fresh(), "14"), "review", { ok: false, log: "major: x", output: { verdict: "findings" }, commits: [] });
    s = recordVisit(s, "fix", visit);
    s = recordVisit(s, "review", { ok: true, log: "", output: { verdict: "clean" }, commits: [] });
    expect(stepsOf(s)["review"]).toEqual({ visits: 2, ok: true, log: "", output: { verdict: "clean" }, commits: [] });
    expect(stepsOf(s)["fix"]?.visits).toBe(1);
  });

  it("keeps the records of every scope; counters reset with the scope", () => {
    let s = recordVisit(setWork(fresh(), "14"), "build", visit);
    s = recordVisit(setWork(s, "15"), "build", { ...visit, commits: ["c2"], session: "s2" });
    s = recordVisit(setWork(s, "12"), "verify", { ok: false, log: "BUILD FAILED", output: undefined, commits: [] });
    expect(s.scopes["14"]?.["build"]).toMatchObject({ visits: 1, commits: ["c1"], session: "s1" });
    expect(s.scopes["15"]?.["build"]).toMatchObject({ visits: 1, commits: ["c2"], session: "s2" });
    expect(stepsOf(s)).toEqual({ verify: { visits: 1, ok: false, log: "BUILD FAILED", output: undefined, commits: [] } });
    expect(stepsOf(setWork(s, "14"))["build"]?.session).toBe("s1");
  });

  it("openVisit keeps only the previous visit's session: its result never carries into the new visit", () => {
    const s = recordVisit(fresh(), "review", { ok: true, log: "clean", output: { verdict: "clean" }, commits: ["c1"], session: "s1" });
    expect(stepsOf(openVisit(s, "review"))["review"]).toEqual({ visits: 2, ok: true, log: "", output: undefined, commits: [], session: "s1" });

    const noSession = recordVisit(fresh(), "build", { ok: false, log: "x", output: { ok: false }, commits: [] });
    expect(stepsOf(openVisit(noSession, "build"))["build"]).toEqual({ visits: 2, ok: true, log: "", output: undefined, commits: [] });
    expect(stepsOf(openVisit(fresh(), "init"))["init"]).toEqual({ visits: 1, ok: true, log: "", output: undefined, commits: [] });
  });

  it("records into the issue's own scope of a fresh session without setWork", () => {
    const s = recordVisit(fresh(), "init", { ok: true, log: "", output: { specDir: "specs/12-some-slug" }, commits: [] });
    expect(s.scopes).toEqual({ "12": { init: { visits: 1, ok: true, log: "", output: { specDir: "specs/12-some-slug" }, commits: [] } } });
  });

  it("does not touch the input", () => {
    const original = setWork(fresh(), "14");
    const snapshot = structuredClone(original);
    recordVisit(original, "build", visit);
    expect(original).toEqual(snapshot);
  });
});
