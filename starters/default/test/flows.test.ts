/**
 * Walks the project flows through the real executor over in-memory fakes.
 * Lifecycle steps and project evals run for real; only the agents and the
 * shell are scripted, so the flows' routing and wiring are what is tested.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadFlow, validateProject, type Flow } from "sous-factory";
import { agentResult, fail, fakeGit, fakeTracker, fakeSandbox, issue, ok, portsOf, walk, type AgentScript, type FakeGit, type FakePorts, type FakeSandboxOptions } from "sous-factory/testing";
import { BASE_BRANCH, diffCommand, NO_CHECKS_WARNING } from "../steps/verify/eval.js";
import { checkedSteps, type CheckedSteps } from "./checked-steps.js";

const DIFF_COMMAND = diffCommand(BASE_BRANCH);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flowFile = (name: string): string => join(root, "flows", `${name}.yaml`);
/** The steps as shipped (an empty check list). */
const shippedSteps = join(root, "steps");
/** The same steps with `npm test` as the project's check, so the delivery flows run checks for real. */
let checked: CheckedSteps;
let stepsDir: string;
beforeAll(async () => {
  checked = await checkedSteps([{ command: "npm test" }]);
  stepsDir = checked.stepsDir;
});
afterAll(() => checked.remove());

const ISSUE = "12";
const BRANCH = "feature/12-some-feature";

type Finding = { severity: string; file: string; line?: number; message: string };
const MAJOR: Finding = { severity: "major", file: "src/A.kt", line: 3, message: "wrong" };

/** An implement or fix answer: one commit `sha`, session `s-<sha>`. */
const built = (sha: string): AgentScript => agentResult(`s-${sha}`, { summary: "built", commits: [sha], output: { filesTouched: ["src/A.kt"], testsRun: ["npm test"] } });
/** A sync-resolve answer: the merge concluded in the fake repository, one repair commit `sha`. */
const synced = (git: FakeGit, sha: string): AgentScript => () => {
  git.state.conflict = false;
  git.state.merging = false;
  return agentResult(`s-${sha}`, { summary: "synced", commits: [sha], output: { filesTouched: ["src/A.kt"] } });
};
/** A review answer; clean without findings. */
const reviewed = (session: string, findings: Finding[] = []): AgentScript =>
  agentResult(session, { summary: "reviewed", commits: [], output: { verdict: findings.length === 0 ? "clean" : "findings", findings } });

type Scenario = {
  labels: string[];
  /** How many syncs bring something in from main before it goes quiet (default 1); 0: main never has anything the branch lacks. */
  moves?: number;
  /** The first sync stops on conflicts; a `synced` answer resolves them. */
  conflict?: boolean;
  /** How many merge attempts find main moved since the last sync (another run landed); each such sync brings something in. */
  stale?: number;
  subIssues?: string[];
  agent: AgentScript[] | ((git: FakeGit) => AgentScript[]);
  exec?: FakeSandboxOptions["exec"];
};

const worktrees: string[] = [];
afterEach(() => Promise.all(worktrees.splice(0).map((w) => rm(w, { recursive: true, force: true }))));

const setup = async ({ labels, moves = 1, conflict = false, stale = 0, subIssues = [], agent, exec = {} }: Scenario): Promise<FakePorts> => {
  const worktree = await mkdtemp(join(tmpdir(), "sous-project-"));
  worktrees.push(worktree);
  const target = issue({ id: ISSUE, title: "Some feature", body: "Make it so.", labels });
  const tracker = fakeTracker({ issues: [target, ...subIssues.map((id) => issue({ id }))], subIssues: { [ISSUE]: subIssues } });
  const git = fakeGit({ existing: ["main", BRANCH], branches: { [worktree]: BRANCH }, trees: { main: "t-main", [BRANCH]: "t-branch" }, ancestors: new Set([`main..${BRANCH}`]), upToDate: moves === 0, conflict });
  const merge = git.mergeInto.bind(git);
  let merged = 0;
  git.mergeInto = async (cwd, source) => {
    const out = await merge(cwd, source);
    if (++merged >= moves) git.state.upToDate = true;
    return out;
  };
  // Main moved under the merge: the next sync brings it in, then main is quiet again.
  const ancestor = git.isAncestor.bind(git);
  let staleLeft = stale;
  git.isAncestor = async (cwd, a, b) => {
    if (staleLeft === 0) return ancestor(cwd, a, b);
    staleLeft--;
    merged = 0;
    moves = 1;
    git.state.upToDate = false;
    return false;
  };
  const sandbox = fakeSandbox({ worktreePath: worktree, branch: BRANCH, agent: typeof agent === "function" ? agent(git) : agent, exec });
  return portsOf(sandbox, { skillsDir: join(root, "skills"), repoRoot: dirname(root), tracker, git, issue: { id: target.id, ref: target.ref, title: target.title, body: target.body, labels: target.labels } });
};

const sequence = (ports: FakePorts): string[] => ports.transitions.map((t) => t.from);

describe("validate", () => {
  it("passes sous.yaml and the three flows against the real steps", () => {
    const report = validateProject(root);
    expect(report.errors).toEqual([]);
    expect(report.flows).toEqual([flowFile("bench"), flowFile("feature"), flowFile("task")]);
    expect(report.note).toBeUndefined();
  });

  it("wires the same agents everywhere: Claude builds, fixes, resolves and reviews", () => {
    for (const name of ["feature", "task"]) {
      const flow = loadFlow(flowFile(name), { stepsDir: shippedSteps });
      const agents = flow.steps.filter((e) => e.agent !== undefined).map((e) => [e.id, e.agent?.kind, e.agent?.model]);
      expect(agents.map((a) => a[0])).toEqual(["implement", "review", "fix", "sync", "review-full", "fix-review-full"]);
      for (const [, kind, model] of agents) expect([kind, model]).toEqual(["claude", "claude-opus-5-5"]);
    }
  });
});

describe("allowedLabels", () => {
  // The plan phase labels every issue with one of these, so each kind of issue has exactly one flow.
  it("task takes type:task and type:bug, feature takes type:feature, bench takes any issue", () => {
    expect(loadFlow(flowFile("task"), { stepsDir: shippedSteps }).allowedLabels).toEqual(["type:task", "type:bug"]);
    expect(loadFlow(flowFile("feature"), { stepsDir: shippedSteps }).allowedLabels).toEqual(["type:feature"]);
    expect(loadFlow(flowFile("bench"), { stepsDir: shippedSteps })).not.toHaveProperty("allowedLabels");
  });
});

describe("bench", () => {
  const bench = (): Flow => loadFlow(flowFile("bench"), { stepsDir: shippedSteps });
  const told = (session: string, setup: string, punchline: string): AgentScript => agentResult(session, { summary: "told", commits: [], output: { setup, punchline } });

  it("greets the issue, asks for a joke about it, retries a joke the eval rejects in the same session, and is done", async () => {
    const ports = await setup({
      labels: [],
      agent: [told("j1", "Same line.", "Same line."), told("j2", "Why did the feature cross the road?", "To get merged.")],
    });

    const session = await walk(bench(), ports);

    expect(sequence(ports)).toEqual(["hello-world", "tell-a-joke"]);
    expect(session).toMatchObject({ current: "done", blocked: false, work: ISSUE, iterations: { "tell-a-joke": 2 } });
    expect(session.scopes[ISSUE]?.["hello-world"]).toMatchObject({ ok: true, output: { greeting: "Hello, Some feature!", name: "Some feature", work: ISSUE } });
    expect(session.scopes[ISSUE]?.["tell-a-joke"]).toMatchObject({ ok: true, session: "j2", output: { setup: "Why did the feature cross the road?", punchline: "To get merged." } });

    const requests = ports.sandbox.requests;
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ agent: { kind: "claude", model: "claude-haiku-4-5-20251001" } });
    expect(requests[0]?.prompt).toContain(`# A joke for issue #${ISSUE}`);
    expect(requests[0]?.prompt).toContain("joke about **Some feature**");
    expect(requests[0]?.prompt).toContain("## Output contract");
    expect(requests[1]).toMatchObject({ resumeSession: "j1" });
    expect(requests[1]?.prompt).toContain("the punchline repeats the setup");

    expect(ports.sandbox.execs).toEqual([]);
    expect(ports.git.committed).toEqual([]);
    expect(ports.tracker.comments).toEqual([]);
    // The harness runs no lifecycle, so no label here; `sous run` claims the issue (unless the flow says `lifecycle: steps`).
    expect(ports.tracker.issues.get(ISSUE)).toMatchObject({ state: "open", labels: [] });
  });
});

describe("feature", () => {
  const feature = (): Flow => loadFlow(flowFile("feature"), { stepsDir });

  it("syncs again when main moved after the last sync, and merges once", async () => {
    const ports = await setup({ labels: ["type:feature"], subIssues: ["14"], stale: 1, agent: [built("b14"), reviewed("r14"), reviewed("rf"), reviewed("rf2")] });

    const session = await walk(feature(), ports);

    expect(sequence(ports).slice(-8)).toEqual(["sync", "review-full", "sync", "merge", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(ports.git.calls.filter((c) => c.startsWith("squashMerge"))).toHaveLength(1);
  });

  it("builds and reviews two sub-issues, closes each, syncs, reviews in full, syncs again and merges", async () => {
    const ports = await setup({
      labels: ["type:feature"],
      subIssues: ["14", "15"],
      agent: [built("b14"), reviewed("r14"), built("b15"), reviewed("r15"), reviewed("rf")],
    });

    const session = await walk(feature(), ports);

    expect(sequence(ports)).toEqual(["init", "next-work", "implement", "review", "close-work", "next-work", "implement", "review", "close-work", "next-work", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(session.blocked).toBe(false);
    expect(session.work).toBe(ISSUE);
    expect(session.specDir).toBe("specs/12-some-feature");
    expect(session.workProgress).toEqual({ "12": { state: "done", commits: ["sha2"] }, "14": { state: "done", commits: ["b14"] }, "15": { state: "done", commits: ["b15"] } });
    expect(Object.keys(session.scopes).sort()).toEqual(["12", "14", "15"]);
    expect(session.scopes["14"]?.["review"]).toMatchObject({ visits: 1, ok: true, session: "r14" });
    expect(session.scopes["12"]?.["review-full"]).toMatchObject({ visits: 1, ok: true });
    expect(session.scopes["12"]?.["merge"]).toMatchObject({ ok: true, output: { sha: "sha2" } });

    const prompts = ports.sandbox.requests.map((r) => r.prompt);
    expect(prompts[0]).toContain("#14 Issue #14");
    // The spec path and skills folder come from ctx; rule files are never quoted into the prompt.
    expect(prompts[0]).toContain("specs/12-some-feature/spec.md");
    expect(prompts[0]).toContain(`${join(root, "skills")}/implement/SKILL.md`);
    expect(prompts[0]).not.toContain("### CODING_STANDARDS.md");
    expect(prompts[0]).not.toMatch(/gradle/i);
    expect(prompts[1]).toContain("b14^..HEAD");
    expect(prompts[2]).toContain("#15 Issue #15");
    expect(prompts[4]).toContain("main...HEAD");
    expect(prompts[4]).toContain("Generated by sous from issue #12");
    expect(prompts[4]).toContain(`${join(root, "skills")}/code-review/SKILL.md`);

    // The verify checks run three times: after each implement, and in sync's eval after the merge brought main in.
    expect(ports.events.of("prepare.end").map((e) => e.agent)).toEqual(["on-fail", "never"]);
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, "npm test", DIFF_COMMAND, "npm test", DIFF_COMMAND, "npm test"]);
    expect(ports.tracker.issues.get("14")?.state).toBe("closed");
    expect(ports.tracker.issues.get("15")?.state).toBe("closed");
    // The harness runs no lifecycle: closing is `sous run`'s, the merge step only labels and comments.
    expect(ports.tracker.issues.get(ISSUE)).toMatchObject({ state: "open", labels: ["type:feature", "sous:merged"] });
    expect(ports.tracker.comments.map((c) => c.issue)).toEqual(["14", "15", ISSUE]);
    expect(ports.git.committed.map((c) => c.message)).toEqual(["spec(#12): stub from issue", "feat(#12): Some feature"]);
    expect(ports.sandbox.closed).toBe(true);
  });
});

describe("task", () => {
  const task = (): Flow => loadFlow(flowFile("task"), { stepsDir });
  const BUILD = "npm test";

  it("goes init -> implement -> review -> sync -> review-full -> sync -> merge; a clean merge whose checks pass never reaches the sync agent", async () => {
    const ports = await setup({ labels: ["type:task"], agent: [built("b1"), reviewed("r1"), reviewed("rf")] });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "implement", "review", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(Object.keys(session.scopes)).toEqual(["12"]);
    expect(session.workProgress).toEqual({ "12": { state: "done", commits: ["sha2"] } });
    expect(ports.events.of("prepare.end").map((e) => [e.agent, e.reason])).toEqual([
      ["on-fail", "merged main cleanly"],
      ["never", `${BRANCH} is already up to date with main`],
    ]);
    expect(session.scopes["12"]?.["sync"]).toMatchObject({ visits: 2, ok: true, prepared: { agent: "never", output: { conflict: false, moved: false } } });
    expect(ports.sandbox.requests).toHaveLength(3);
    // implement's eval, then sync's eval after the merge that moved HEAD; the quiet second sync checks nothing.
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD]);
    expect(ports.git.committed.map((c) => c.message)).toEqual(["spec(#12): stub from issue", "fix(#12): Some feature"]);
    expect(ports.tracker.issues.get(ISSUE)).toMatchObject({ state: "open", labels: ["type:task", "sous:merged"] });
  });

  it("syncs again when main moved after the last sync, and reviews what it brought in before merging", async () => {
    const ports = await setup({ labels: ["type:task"], stale: 1, agent: [built("b1"), reviewed("r1"), reviewed("rf"), reviewed("rf2")] });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "implement", "review", "sync", "review-full", "sync", "merge", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(session.scopes["12"]?.["merge"]).toMatchObject({ visits: 2, ok: true, output: { stale: false, sha: "sha2" } });
    // Only one squash landed; the stale visit merged and cleaned up nothing.
    expect(ports.git.committed.map((c) => c.message)).toEqual(["spec(#12): stub from issue", "fix(#12): Some feature"]);
    expect(ports.git.removedWorktrees).toHaveLength(1);
    expect(ports.tracker.comments.filter((c) => c.body.startsWith("Merged into"))).toHaveLength(1);
  });

  it("stops blocked when main moved under the merge three times", async () => {
    const ports = await setup({ labels: ["type:task"], stale: 3, agent: [built("b1"), reviewed("r1"), reviewed("rf"), reviewed("rf2"), reviewed("rf3")] });

    const session = await walk(task(), ports);

    expect(sequence(ports).filter((s) => s === "merge")).toHaveLength(3);
    expect(session).toMatchObject({ current: "merge", blocked: true });
    expect(ports.git.calls.some((c) => c.startsWith("squashMerge"))).toBe(false);
  });

  it("as shipped, with no checks filled in yet: every eval passes with the warning in its log and runs nothing", async () => {
    const ports = await setup({ labels: ["type:task"], agent: [built("b1"), reviewed("r1"), reviewed("rf")] });

    const session = await walk(loadFlow(flowFile("task"), { stepsDir: shippedSteps }), ports);

    expect(sequence(ports)).toEqual(["init", "implement", "review", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(session.scopes["12"]?.["implement"]).toMatchObject({ ok: true, log: NO_CHECKS_WARNING });
    expect(ports.sandbox.execs).toEqual([]);
  });

  it("checks nothing again when main never brought anything in: implement's eval already built that HEAD", async () => {
    const ports = await setup({ labels: ["type:task"], moves: 0, agent: [built("b1"), reviewed("r1"), reviewed("rf")] });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "implement", "review", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD]);
  });

  it("hands failing checks after a clean merge to the sync agent, whose repair the eval checks and review-full reviews", async () => {
    const ports = await setup({
      labels: ["type:task"],
      agent: (git) => [built("b1"), reviewed("r1"), synced(git, "f1"), reviewed("rf")],
      // implement's eval passes; the merged branch fails sync's eval before the agent; it passes after the repair.
      exec: { [BUILD]: [ok("BUILD SUCCESSFUL\n"), fail("e: A.kt:3 type mismatch\n"), ok("BUILD SUCCESSFUL\n")] },
    });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "implement", "review", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(ports.events.of("prepare.end").map((e) => e.agent)).toEqual(["on-fail", "never"]);
    const prompts = ports.sandbox.requests.map((r) => r.prompt);
    expect(prompts[2]).toContain("# Bring main into the branch of issue #12");
    expect(prompts[2]).toContain("## The evaluation already ran");
    expect(prompts[2]).toContain("$ npm test (exit 1)\ne: A.kt:3 type mismatch");
    expect(ports.sandbox.requests[2]).not.toHaveProperty("resumeSession");
    expect(prompts[3]).toContain("main...HEAD");
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD]);
  });

  it("resolves a conflict in sync, with the checks as its eval, then reviews in full", async () => {
    const ports = await setup({ labels: ["type:task"], conflict: true, agent: (git) => [built("b1"), reviewed("r1"), synced(git, "m1"), reviewed("rf")] });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "implement", "review", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(ports.events.of("prepare.end").map((e) => e.agent)).toEqual(["always", "never"]);
    expect(ports.sandbox.requests[2]?.prompt).toContain("A merge in progress (`git status`) stopped on conflicts");
    // implement's eval, then sync's eval after the agent; prepare ran no checks on a conflict.
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD]);
  });

  it("reviews again when main moved during the review, and merges once a sync finds main quiet", async () => {
    const ports = await setup({ labels: ["type:task"], moves: 2, agent: [built("b1"), reviewed("r1"), reviewed("rf1"), reviewed("rf2")] });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "implement", "review", "sync", "review-full", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(session.scopes["12"]?.["review-full"]).toMatchObject({ visits: 2, ok: true, session: "rf2" });
    expect(session.scopes["12"]?.["sync"]).toMatchObject({ visits: 3 });
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD]);
  });

  it("blocks when the slice review hits its cap of three visits with blocking findings", async () => {
    const ports = await setup({
      labels: ["type:task"],
      agent: [built("b1"), reviewed("r1", [MAJOR]), built("f1"), reviewed("r2", [MAJOR]), built("f2"), reviewed("r3", [MAJOR])],
    });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "implement", "review", "fix", "review", "fix", "review"]);
    expect(ports.transitions.at(-1)).toEqual({ from: "review", to: "blocked", ok: false });
    expect(session).toMatchObject({ current: "review", blocked: true });
    expect(session.scopes["12"]?.["review"]).toMatchObject({ visits: 3, ok: false, log: "major src/A.kt:3 wrong", session: "r3" });
    expect(session.scopes["12"]?.["fix"]).toMatchObject({ visits: 2, commits: ["f2"], session: "s-f2" });

    const requests = ports.sandbox.requests;
    expect(requests).toHaveLength(6);
    expect(requests[2]?.resumeSession).toBe("s-b1");
    expect(requests[2]?.prompt).toContain("major src/A.kt:3 wrong");
    expect(requests[4]?.resumeSession).toBe("s-f1");
    // implement and both fixes ran the verify checks; sync was never reached.
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD]);
    expect(ports.tracker.issues.get(ISSUE)?.state).toBe("open");
  });

  it("blocks when review-full hits its cap of four visits", async () => {
    const ports = await setup({
      labels: ["type:task"],
      moves: 0,
      agent: [built("b1"), reviewed("r1"), reviewed("rf1", [MAJOR]), built("f1"), reviewed("rf2", [MAJOR]), built("f2"), reviewed("rf3", [MAJOR]), built("f3"), reviewed("rf4", [MAJOR])],
    });

    const session = await walk(task(), ports);

    expect(sequence(ports).slice(3)).toEqual(["sync", "review-full", "fix-review-full", "review-full", "fix-review-full", "review-full", "fix-review-full", "review-full"]);
    expect(ports.transitions.at(-1)).toEqual({ from: "review-full", to: "blocked", ok: false });
    expect(session.scopes["12"]?.["review-full"]).toMatchObject({ visits: 4, ok: false });
  });

  it("retries implement in the same session with the failed verify transcript when its eval fails, then goes on", async () => {
    const ports = await setup({
      labels: ["type:task"],
      agent: [built("b1"), built("b2"), reviewed("r1"), reviewed("rf")],
      exec: { [BUILD]: [fail("e: A.kt:3 type mismatch\n"), ok("BUILD SUCCESSFUL\n")] },
    });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "implement", "review", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(session.iterations).toMatchObject({ implement: 2 });
    expect(session.scopes["12"]?.["implement"]).toMatchObject({ visits: 1, ok: true, session: "s-b2", log: "$ npm test (exit 0)\nBUILD SUCCESSFUL" });

    const requests = ports.sandbox.requests;
    expect(requests).toHaveLength(4);
    expect(requests[1]?.resumeSession).toBe("s-b1");
    expect(requests[1]?.prompt).toContain("did not pass evaluation");
    expect(requests[1]?.prompt).toContain("$ npm test (exit 1)\ne: A.kt:3 type mismatch");
    expect(requests[2]?.prompt).toContain("b2^..HEAD");
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD]);
  });
});
