import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCtx, ctxPlaceholders, repoFiles, type CtxDeps, type CtxState } from "../../src/exec/ctx.js";
import { fakeEventLog } from "../fakes/eventlog.js";
import { fakeGit } from "../fakes/git.js";
import { fakeTracker, issue } from "../fakes/tracker.js";
import { fakeSandbox, ok } from "../fakes/sandbox.js";

describe("ctx", () => {
  let worktree: string;
  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "sous-ctx-"));
    await writeFile(join(worktree, "CODING_STANDARDS.md"), "# Rules\n\nbe nice\n");
    await mkdir(join(worktree, "docs", "adr", "nested"), { recursive: true });
    await writeFile(join(worktree, "docs", "adr", "002-b.md"), "second\n");
    await writeFile(join(worktree, "docs", "adr", "001-a.md"), "first\n");
    await writeFile(join(worktree, "docs", "adr", "nested", "003-c.md"), "third");
  });
  afterEach(() => rm(worktree, { recursive: true, force: true }));

  const deps = (): CtxDeps => {
    const gh = fakeTracker({ issues: [issue({ id: "12", title: "Some slug" })] });
    return {
      issue: issue({ id: "12", title: "Some slug" }),
      flow: "feature",
      branch: "feature/12-some-slug",
      repoRoot: "/repo",
      skillsDir: "/repo/.sous/skills",
      sandbox: fakeSandbox({ worktreePath: worktree, exec: { "git status": ok("clean") } }),
      git: fakeGit(),
      tracker: gh,
      events: fakeEventLog([{ type: "run.end", at: "t", runId: "r", outcome: "done" }]),
      repoLock: (fn) => fn(),
    };
  };
  const self = { id: "12", ref: "#12", title: "Some slug", body: "" };
  const state = (overrides: Partial<CtxState> = {}): CtxState => ({ work: self, specDir: "specs/12-some-slug", workProgress: { "12": { state: "open", commits: [] } }, previous: null, ...overrides });

  it("repoFiles renders each file under a ### heading; a directory expands to its files, sorted and recursive", () => {
    expect(repoFiles(worktree, ["CODING_STANDARDS.md", "docs/adr"])).toBe(
      ["### CODING_STANDARDS.md\n\n# Rules\n\nbe nice", "### docs/adr/001-a.md\n\nfirst", "### docs/adr/002-b.md\n\nsecond", "### docs/adr/nested/003-c.md\n\nthird"].join("\n\n"),
    );
    expect(() => repoFiles(worktree, ["missing.md"])).toThrow("cannot read missing.md");
  });

  it("exposes the run facts, the moving state and synchronous file access to the worktree", () => {
    const ctx = buildCtx(deps(), state({ work: { id: "14", ref: "#14", title: "Work", body: "" }, workProgress: { "14": { state: "open", commits: [] } }, previous: "build", iteration: 2 }));
    expect(ctx).toMatchObject({
      issue: { id: "12", ref: "#12", title: "Some slug" },
      flow: "feature",
      work: { id: "14" },
      branch: "feature/12-some-slug",
      worktree,
      repoRoot: "/repo",
      specDir: "specs/12-some-slug",
      skillsDir: "/repo/.sous/skills",
      previous: "build",
      iteration: 2,
      workProgress: { "14": { state: "open", commits: [] } },
    });
    expect(ctx.readFile("docs/adr/001-a.md")).toBe("first\n");
    expect(ctx.readFile(join(worktree, "docs/adr/002-b.md"))).toBe("second\n");
    expect(ctx.repoFiles(["docs/adr/nested"])).toBe("### docs/adr/nested/003-c.md\n\nthird");
    expect(() => ctx.readFile("nope.md")).toThrow("cannot read nope.md");
  });

  it("omits iteration outside eval and routes and runs exec through the sandbox", async () => {
    const d = deps();
    const ctx = buildCtx(d, state());
    expect(ctx).not.toHaveProperty("iteration");
    expect(ctx.previous).toBeNull();
    expect(await ctx.exec("git status")).toEqual({ code: 0, stdout: "clean", stderr: "" });
    expect(await ctx.exec("whatever", { cwd: "sub" })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect((d.sandbox as ReturnType<typeof fakeSandbox>).execCalls).toEqual([
      { command: "git status", cwd: undefined },
      { command: "whatever", cwd: "sub" },
    ]);
    expect(ctx.git).toBe(d.git);
    expect(ctx.tracker).toBe(d.tracker);
  });

  it("gives modules the tracker, the event log, the sandbox close and the workDone write", async () => {
    const d = deps();
    const done: unknown[] = [];
    const ctx = buildCtx(d, state({ work: { id: "14", ref: "#14", title: "Work", body: "" } }), { workDone: (work, commits) => done.push({ work, commits }) });
    ctx.workDone(["a", "b"]);
    expect(done).toEqual([{ work: "14", commits: ["a", "b"] }]);
    ctx.work = self;
    ctx.workDone([]);
    expect(done.at(-1)).toEqual({ work: "12", commits: [] });
    expect((await ctx.events.readAll()).map((e) => e.type)).toEqual(["run.end"]);
    expect(await ctx.repoLock(async () => "under the lock")).toBe("under the lock");
    await ctx.sandbox.close();
    expect((d.sandbox as ReturnType<typeof fakeSandbox>).closed).toBe(true);
    await ctx.tracker.setStateLabel("12", "sous:merged");
    expect((await d.tracker.getIssue("12")).labels).toEqual(["sous:merged"]);
  });

  it("refuses workDone outside a module call", () => {
    const ctx = buildCtx(deps(), state({ work: { id: "14", ref: "#14", title: "Work", body: "" } }));
    expect(() => ctx.workDone(["a"])).toThrow("modules only");
  });

  it("ctxPlaceholders carries the seven allowed values; the work is the issue itself until a module changes it", () => {
    const d = deps();
    expect(ctxPlaceholders(buildCtx(d, state({ work: { id: "14", ref: "#14", title: "w", body: "" } })))).toEqual({
      "ctx.issue.id": "12",
      "ctx.issue.ref": "#12",
      "ctx.work.id": "14",
      "ctx.work.ref": "#14",
      "ctx.worktree": worktree,
      "ctx.specDir": "specs/12-some-slug",
      "ctx.skillsDir": d.skillsDir,
    });
    expect(ctxPlaceholders(buildCtx(d, state()))["ctx.work.id"]).toBe("12");
  });
});
