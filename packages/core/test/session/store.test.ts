import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { recordVisit, type Session } from "../../src/exec/scope.js";
import { branchName, eventsFile, runDir, runsRoot, sessionFile, slugify, specDir, specDirName } from "../../src/session/paths.js";
import { filePersist, loadSession, parseSession, saveSession } from "../../src/session/store.js";
import {
  appendHistory,
  bumpIteration,
  clearBlocked,
  createSession,
  iterationOf,
  logTail,
  markBlocked,
  markWorkDone,
  resetIteration,
  setCurrent,
  setSpecDir,
  setWork,
  transition,
} from "../../src/session/update.js";

const fresh = (): Session =>
  createSession({ flow: "feature", issue: "12", title: "Some slug", branch: "feature/12-some-slug", specDir: "specs/12-some-slug", entry: "init" });

describe("paths", () => {
  it("slugifies to lowercase dash-separated words, keeping the first four", () => {
    expect(slugify("Add Portfolio Export (CSV) for users!")).toBe("add-portfolio-export-csv");
    expect(slugify("  Fix   flaky   test ")).toBe("fix-flaky-test");
    expect(slugify("Ünïcode & symbols --- here")).toBe("n-code-symbols-here");
    expect(slugify("")).toBe("");
  });

  it("derives the spec dir from the settings specsDir, issue and title", () => {
    expect(specDirName("12", "Some slug for this")).toBe("12-some-slug-for-this");
    expect(specDir("specs", "12", "Some slug")).toBe("specs/12-some-slug");
    expect(specDir("docs/specs", "12", "Some slug")).toBe("docs/specs/12-some-slug");
  });

  it("renders the branch from the settings template over issue and slug", () => {
    const issue = { id: "12", ref: "#12", title: "Some slug" };
    expect(branchName(DEFAULT_SETTINGS.branch, issue)).toBe("feature/12-some-slug");
    expect(branchName("sous/${{ issue.id }}", issue)).toBe("sous/12");
    expect(branchName("sous/${{ issue.id }}", { id: "proj/a 1", title: "t" })).toBe("sous/proj-a-1");
    expect(branchName('${{ issue.title.includes("slug") ? "x" : "y" }}-${{ slug.length }}', issue)).toBe("x-9");
    expect(branchName("plain", issue)).toBe("plain");
    expect(() => branchName("feature/${{ issue. }}", issue)).toThrow(/cannot compile expression/);
  });

  it("puts the run record under runsDir/<issue>, resolved against the project root", () => {
    expect(runsRoot("/repo/.sous", DEFAULT_SETTINGS)).toBe("/repo/.sous/runs");
    expect(runsRoot("/repo/.sous", { runsDir: "/elsewhere/runs" })).toBe("/elsewhere/runs");
    expect(runDir("/repo/.sous/runs", "12")).toBe("/repo/.sous/runs/12");
    expect(sessionFile("/repo/.sous/runs", "12")).toBe("/repo/.sous/runs/12/session.json");
    expect(eventsFile("/repo/.sous/runs", "12")).toBe("/repo/.sous/runs/12/events.jsonl");
  });
});

describe("store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sous-store-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a session through save and load, creating parent directories", async () => {
    const path = join(dir, "runs", "12", "session.json");
    let session = setWork(fresh(), "14");
    session = recordVisit(session, "build", { ok: true, log: "", output: { filesTouched: ["a.kt"] }, commits: ["c1"], session: "s1" });
    session = recordVisit(session, "review", { ok: false, log: "major: x", output: { verdict: "findings", findings: [] }, commits: [] });
    session = markWorkDone(session, "14", ["c1"]);
    session = transition(session, "init", "next-work", new Date(Date.UTC(2026, 9, 2, 9)), true);
    session = bumpIteration(session, "next-work");
    session = markBlocked(session);

    await saveSession(path, session);

    expect(await loadSession(path)).toEqual(session);
    expect((await readFile(path, "utf8")).endsWith("}\n")).toBe(true);
  });

  it("returns undefined for a missing file", async () => {
    expect(await loadSession(join(dir, "missing.json"))).toBeUndefined();
  });

  it("rejects a file that does not match schema 5, naming the file and the violation", async () =>  {
    const path = join(dir, "session.json");
    await saveSession(path, { ...fresh(), schemaVersion: 3 } as unknown as Session);
    await expect(loadSession(path)).rejects.toThrow(/session\.json: \/schemaVersion must be equal to constant/);
  });

  it("parseSession checks the shape, not only the version", () => {
    expect(parseSession(fresh(), "f")).toEqual(fresh());
    expect(() => parseSession({ ...fresh(), extra: 1 }, "f")).toThrow(/additional properties \(extra\)/);
    expect(() => parseSession({ ...fresh(), work: 14 }, "f")).toThrow(/\/work must be/);
    expect(() => parseSession({ ...fresh(), scopes: { "14": { build: { visits: 0, ok: true, log: "", commits: [] } } } }, "f")).toThrow(/visits must be >= 1/);
    const { blocked: _b, ...withoutBlocked } = fresh();
    expect(() => parseSession(withoutBlocked, "f")).toThrow(/required property 'blocked'/);
  });

  it("filePersist writes the session to the given path", async () => {
    const path = join(dir, "session.json");
    await filePersist(path)(fresh());
    expect(await loadSession(path)).toEqual(fresh());
  });
});

describe("update", () => {
  it("createSession has the session shape: schema 6, the issue on the bench, entry counter at 0", () => {
    expect(fresh()).toEqual({
      schemaVersion: 6,
      flow: "feature",
      issue: "12",
      title: "Some slug",
      branch: "feature/12-some-slug",
      specDir: "specs/12-some-slug",
      current: "init",
      previous: null,
      work: "12",
      scopes: { "12": {} },
      workProgress: { "12": { state: "open", commits: [] } },
      history: [],
      iterations: { init: 0 },
      blocked: false,
    });
  });

  it("setCurrent moves, remembers the step left and starts the target's counter fresh", () => {
    const s = setCurrent({ ...fresh(), iterations: { init: 1, build: 2 } }, "build");
    expect(s).toMatchObject({ current: "build", previous: "init", iterations: { init: 1, build: 0 } });
  });

  it("bumpIteration counts per step; resetIteration zeroes it", () => {
    let s = bumpIteration(fresh(), "build");
    s = bumpIteration(s, "build");
    expect(iterationOf(s, "build")).toBe(2);
    expect(iterationOf(s, "review")).toBe(0);
    expect(resetIteration(s, "build").iterations).toEqual({ init: 0, build: 0 });
  });

  it("markBlocked / clearBlocked: re-entry resets the current step's counter", () => {
    const blocked = markBlocked(bumpIteration(setCurrent(fresh(), "build"), "build"));
    expect(blocked).toMatchObject({ current: "build", blocked: true, iterations: { build: 1 } });
    expect(clearBlocked(blocked)).toMatchObject({ current: "build", blocked: false, iterations: { build: 0 } });
  });

  it("setWork opens the work's scope and registers it as open; the issue's own id is the full-branch scope", () => {
    const s = setWork(fresh(), "14");
    expect(s.work).toBe("14");
    expect(s.scopes).toEqual({ "12": {}, "14": {} });
    expect(s.workProgress["14"]).toEqual({ state: "open", commits: [] });

    const back = setWork(s, "12");
    expect(back.work).toBe("12");
    expect(back.scopes).toEqual({ "12": {}, "14": {} });
    expect(back.workProgress).toEqual({ "12": { state: "open", commits: [] }, "14": { state: "open", commits: [] } });

    const visited = recordVisit(s, "build", { ok: true, log: "", output: {}, commits: [] });
    expect(setWork(visited, "14").scopes["14"]?.["build"]?.visits).toBe(1);
  });

  it("markWorkDone closes the work and appends commits", () => {
    const s = markWorkDone(markWorkDone(setWork(fresh(), "14"), "14", ["a"]), "14", ["b"]);
    expect(s.workProgress["14"]).toMatchObject({ state: "done", commits: ["a", "b"] });
  });

  it("appendHistory and setSpecDir", () => {
    const s = setSpecDir(appendHistory(fresh(), { step: "init", at: "t", ok: true, next: "build" }), "specs/12-planned");
    expect(s.history).toEqual([{ step: "init", at: "t", ok: true, next: "build" }]);
    expect(s.specDir).toBe("specs/12-planned");
  });

  it("transition records where it went; blocked keeps current on the step", () => {
    const at = new Date(Date.UTC(2026, 9, 2, 9));
    const moved = transition(fresh(), "init", "build", at, true);
    expect(moved).toMatchObject({ current: "build", previous: "init", blocked: false, iterations: { init: 0, build: 0 } });
    expect(moved.history).toEqual([{ step: "init", at: at.toISOString(), ok: true, next: "build" }]);

    const stuck = transition(bumpIteration(setCurrent(fresh(), "build"), "build"), "build", "blocked", at, false);
    expect(stuck).toMatchObject({ current: "build", previous: "init", blocked: true, iterations: { build: 1 } });
    expect(stuck.history[0]?.next).toBe("blocked");
  });

  it("logTail keeps the last lines", () => {
    const log = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(logTail(log, 3)).toBe("line 48\nline 49\nline 50");
    expect(logTail("short", 3)).toBe("short");
    expect(logTail(log).split("\n")).toHaveLength(40);
  });

  it("mutations do not touch the input", () => {
    const original = fresh();
    const snapshot = structuredClone(original);
    setCurrent(bumpIteration(markWorkDone(recordVisit(setWork(original, "14"), "build", { ok: true, log: "", output: {}, commits: [] }), "14", ["a"]), "build"), "review");
    expect(original).toEqual(snapshot);
  });
});
