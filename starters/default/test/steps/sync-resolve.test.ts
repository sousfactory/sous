/**
 * `sync-resolve` unit tests over the fakes, then the step through the real
 * executor in a one-step flow so prepare, the three verdicts and eval are
 * covered together.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadFlow, loadStep, type EvalFn, type Prepared, type PrepareFn } from "sous-factory";
import { agentResult, BRANCH, ctxOf, fail, fakeGit, fakeSandbox, ok, portsOf, walk, type FakeGit } from "sous-factory/testing";
import type { SyncPrepared } from "../../steps/sync-resolve/prepare.js";
import { BASE_BRANCH, diffCommand } from "../../steps/verify/eval.js";
import { checkedSteps, type CheckedSteps } from "../checked-steps.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stepDir = join(root, "steps", "sync-resolve");
const BUILD = "npm test";
const DIFF_COMMAND = diffCommand(BASE_BRANCH);
const work14 = { id: "14", ref: "#14", title: "Work 14", body: "do 14" };
const inputs = { baseBranch: "main" };

/** The step over a copy of `steps/` whose verify runs `npm test`; the shipped copy has no checks to fail. */
let checked: CheckedSteps;
let prepare: PrepareFn<SyncPrepared>;
let syncEval: EvalFn;
beforeAll(async () => {
  checked = await checkedSteps([{ command: BUILD }]);
  prepare = ((await import(join(checked.stepsDir, "sync-resolve", "prepare.ts"))) as { default: PrepareFn<SyncPrepared> }).default;
  syncEval = ((await import(join(checked.stepsDir, "sync-resolve", "eval.ts"))) as { default: EvalFn }).default;
});
afterAll(() => checked.remove());

describe("sync-resolve step", () => {
  it("is agentic with a prepare; its placeholders are the declared input and ctx values", () => {
    const step = loadStep(stepDir);
    expect(step.run?.kind).toBe("prompt");
    expect(step.prepare?.module).toBe(join(stepDir, "prepare.ts"));
    expect(step.eval).toEqual({ kind: "module", module: join(stepDir, "eval.ts") });
    expect(Object.keys(step.inputs)).toEqual(["baseBranch"]);
    expect(Object.keys((step.prepare?.output["properties"] ?? {}) as object)).toEqual(["conflict", "moved"]);
    expect([...step.placeholders].filter((p) => !p.startsWith("ctx.")).sort()).toEqual(["baseBranch"]);
  });
});

describe("sync-resolve prepare", () => {
  it("never runs the agent when nothing came in, with the issue itself back on the bench", async () => {
    const f = ctxOf({ work: work14, git: fakeGit({ upToDate: true }) });
    expect(await prepare(f.ctx, inputs)).toEqual({ agent: "never", reason: `${BRANCH} is already up to date with main`, output: { conflict: false, moved: false } });
    expect(f.ctx.work).toEqual({ id: "1", ref: "#1", title: "Test issue", body: f.ctx.issue.body });
    expect(f.sandbox.execs).toEqual([]);
  });

  it("leaves the checks to the eval after a clean merge: the agent runs only if they fail", async () => {
    const f = ctxOf({ work: work14 });
    expect(await prepare(f.ctx, inputs)).toEqual({ agent: "on-fail", reason: "merged main cleanly", output: { conflict: false, moved: true } });
    expect(f.sandbox.execs).toEqual([]);
    expect(f.ctx.work.id).toBe("1");
  });

  it("always runs the agent on a conflict, without running the checks", async () => {
    const f = ctxOf({ work: work14, git: fakeGit({ conflict: true }) });
    expect(await prepare(f.ctx, inputs)).toEqual({ agent: "always", output: { conflict: true, moved: false } });
    expect(f.git.state.merging).toBe(true);
    expect(f.sandbox.execs).toEqual([]);
    expect(f.ctx.work.id).toBe("1");
  });

  it("treats a merge already in progress as a conflict and does not merge again", async () => {
    const f = ctxOf({ git: fakeGit({ merging: true }) });
    expect(await prepare(f.ctx, inputs)).toEqual({ agent: "always", output: { conflict: true, moved: false } });
    expect(f.git.calls).toEqual(["mergeInProgress(/tmp/worktree)"]);
  });

  it("throws on a merge failure that is not a conflict and leaves the work alone", async () => {
    const git = fakeGit();
    git.mergeInto = async () => ({ ok: false, conflicted: false, log: "fatal: not something we can merge" });
    const f = ctxOf({ work: work14, git });
    await expect(prepare(f.ctx, inputs)).rejects.toThrow(`sync-resolve: merging main into ${BRANCH} failed:\nfatal: not something we can merge`);
    expect(f.ctx.work).toEqual(work14);
  });

  it("requires baseBranch", async () => {
    await expect(prepare(ctxOf().ctx, {})).rejects.toThrow('sync-resolve: input "baseBranch" must be a non-empty string');
  });
});

describe("sync-resolve eval", () => {
  const conflicted: Prepared<SyncPrepared> = { agent: "always", output: { conflict: true, moved: false } };
  const merged: Prepared<SyncPrepared> = { agent: "on-fail", reason: "merged main cleanly", output: { conflict: false, moved: true } };

  it("passes without checking anything when the merge brought nothing in", async () => {
    const f = ctxOf();
    expect(await syncEval(f.ctx, inputs, undefined, { agent: "never", reason: `${BRANCH} is already up to date with main`, output: { conflict: false, moved: false } })).toEqual({
      ok: true,
      log: `sync-resolve: ${BRANCH} is already up to date with main; nothing to check`,
    });
    expect(f.git.calls).toEqual([]);
    expect(f.sandbox.execs).toEqual([]);
  });

  it("fails while the merge is still in progress, without running the checks", async () => {
    const f = ctxOf({ git: fakeGit({ merging: true }) });
    expect(await syncEval(f.ctx, inputs, undefined, conflicted)).toEqual({ ok: false, log: "sync-resolve: the merge is still in progress; resolve every conflict and commit the merge" });
    expect(f.sandbox.execs).toEqual([]);
  });

  it("runs the verify checks on a merged branch, before any agent and after one", async () => {
    const red = ctxOf({ sandbox: fakeSandbox({ exec: { [BUILD]: fail("red", 1) } }) });
    expect(await syncEval(red.ctx, inputs, undefined, merged)).toEqual({ ok: false, log: `$ ${BUILD} (exit 1)\nred` });
    const green = ctxOf({ sandbox: fakeSandbox({ exec: { [BUILD]: ok("BUILD SUCCESSFUL") } }) });
    expect(await syncEval(green.ctx, inputs, undefined, merged)).toMatchObject({ ok: true });
    const resolved = ctxOf({ sandbox: fakeSandbox({ exec: { [BUILD]: ok("BUILD SUCCESSFUL") } }) });
    expect(await syncEval(resolved.ctx, inputs, { summary: "", commits: ["m1"], output: { filesTouched: [] } }, conflicted)).toMatchObject({ ok: true });
    expect(resolved.sandbox.execs).toContain(BUILD);
  });
});

describe("sync-resolve through the executor", () => {
  const dirs: string[] = [];
  afterEach(() => Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))));

  const flow = async () => {
    const dir = await mkdtemp(join(tmpdir(), "sous-sync-resolve-"));
    dirs.push(dir);
    const file = join(dir, "sync.yaml");
    await writeFile(file, "entry: sync\nsteps:\n  - id: sync\n    uses: sync-resolve\n    agent: { kind: claude, model: claude-x }\n    with: { baseBranch: main }\n    routes:\n      - to: done\n");
    return loadFlow(file, { stepsDir: checked.stepsDir });
  };

  /** The agent concludes the merge in the fake repository and answers. */
  const resolves = (git: FakeGit) => () => {
    git.state.merging = false;
    return agentResult("s1", { summary: "resolved", commits: ["m1"], output: { filesTouched: ["src/A.kt"] }, skills: [] });
  };

  it("a clean merge with passing checks runs the checks once and never calls the agent", async () => {
    const ports = portsOf(fakeSandbox({ exec: { [BUILD]: ok("BUILD SUCCESSFUL") } }), { skillsDir: join(root, "skills") });
    const session = await walk(await flow(), ports);
    expect(session.current).toBe("done");
    expect(ports.sandbox.requests).toEqual([]);
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD]);
    expect(ports.events.of("prepare.end")).toEqual([expect.objectContaining({ agent: "on-fail", reason: "merged main cleanly" })]);
    expect(ports.events.of("iteration.eval.end")).toEqual([expect.objectContaining({ n: 0, ok: true })]);
  });

  it("a conflict calls the agent, whose work the eval judges with the verify checks", async () => {
    const git = fakeGit({ conflict: true });
    const ports = portsOf(fakeSandbox({ agent: [resolves(git)], exec: { [BUILD]: ok("BUILD SUCCESSFUL") } }), { git, skillsDir: join(root, "skills") });
    const session = await walk(await flow(), ports);
    expect(session.current).toBe("done");
    expect(ports.sandbox.requests).toHaveLength(1);
    expect(ports.sandbox.requests[0]?.prompt).toContain("Bring main into the branch of issue #1");
    expect(ports.sandbox.requests[0]?.prompt).not.toContain("## The evaluation already ran");
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD]);
  });

  it("failing checks after a clean merge start the agent with their transcript appended, and the checks run again after it", async () => {
    const git = fakeGit();
    const ports = portsOf(fakeSandbox({ agent: [resolves(git)], exec: { [BUILD]: [fail("e: A.kt: unresolved reference", 1), ok("BUILD SUCCESSFUL")] } }), { git, skillsDir: join(root, "skills") });
    const session = await walk(await flow(), ports);
    expect(session.current).toBe("done");
    expect(ports.sandbox.requests).toHaveLength(1);
    expect(ports.sandbox.requests[0]).not.toHaveProperty("resumeSession");
    expect(ports.sandbox.requests[0]?.prompt).toContain(`## The evaluation already ran`);
    expect(ports.sandbox.requests[0]?.prompt).toContain(`$ ${BUILD} (exit 1)\ne: A.kt: unresolved reference`);
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD]);
  });
});
