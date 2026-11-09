/**
 * Walks the project flows through the real executor over in-memory fakes.
 * Lifecycle steps and project evals run for real; only the agents and the
 * shell are scripted, so the flows' routing and wiring are what is tested.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadFlow, validateProject, type Flow } from "sous-factory";
import { agentResult, fail, fakeGit, fakeTracker, fakeSandbox, issue, ok, portsOf, walk, type AgentScript, type FakeGit, type FakePorts, type FakeSandboxOptions } from "sous-factory/testing";
import { diffCommand, NO_CHECKS_WARNING } from "../steps/verify/eval.js";
import { checkedSteps, type CheckedSteps } from "./checked-steps.js";

const DIFF_COMMAND = diffCommand("main");

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
/** An implement answer that committed nothing: the work was already on the branch. */
const unchanged = (session: string): AgentScript => agentResult(session, { summary: "already there", commits: [], output: { filesTouched: [], testsRun: ["npm test"] } });
/** A sync-resolve answer: the merge concluded in the fake repository, one repair commit `sha`. */
const synced = (git: FakeGit, sha: string): AgentScript => () => {
  git.state.conflict = false;
  git.state.merging = false;
  return agentResult(`s-${sha}`, { summary: "synced", commits: [sha], output: { filesTouched: ["src/A.kt"] } });
};
/** A review answer; clean without findings. */
const reviewed = (session: string, findings: Finding[] = []): AgentScript =>
  agentResult(session, { summary: "reviewed", commits: [], output: { verdict: findings.length === 0 ? "clean" : "findings", findings } });

type Check = { command: string; result: string };
const GREP: Check = { command: "grep -rn 'make it so' src/", result: "src/A.kt:3: // TODO make it so" };
/** A check-issue answer: the verdict, with the evidence for it and, for a partly false issue, the divergence. */
const checkedIssue = (verdict: string, evidence: Check[] = [GREP], divergence?: string[]): AgentScript =>
  agentResult(`c-${verdict}`, { summary: "checked", commits: [], output: { verdict, evidence, ...(divergence !== undefined ? { divergence } : {}) } });
/** The check-issue answer for an issue that still holds. */
const holds = (): AgentScript => checkedIssue("holds");

const SPEC_DIR = `specs/${ISSUE}-some-feature`;
const specText = (questions: string[]): string =>
  [
    "# Spec: Some feature",
    "",
    `- **Issue:** #${ISSUE}`,
    "- **Status:** derived",
    "",
    "## User Stories",
    "",
    "1. It is so.",
    "",
    "## Assumptions",
    "",
    "- Make it so means make it so.",
    "",
    "## Open questions",
    "",
    ...questions.map((q) => `- ${q}`),
    "",
  ].join("\n");
const writeSpec = async (worktree: string, questions: string[] = []): Promise<void> => {
  await mkdir(join(worktree, SPEC_DIR), { recursive: true });
  await writeFile(join(worktree, SPEC_DIR, "spec.md"), specText(questions));
};
/** A plan answer: the agent wrote and committed the spec, leaving `questions` open. */
const planned = (worktree: string, questions: string[] = []): AgentScript => () => {
  mkdirSync(join(worktree, SPEC_DIR), { recursive: true });
  writeFileSync(join(worktree, SPEC_DIR, "spec.md"), specText(questions));
  return agentResult("s-plan", { summary: "planned", commits: ["p1"], output: { assumptions: 1, openQuestions: questions.length } });
};

type Scenario = {
  labels: string[];
  /** How many syncs bring something in from main before it goes quiet (default 1); 0: main never has anything the branch lacks. */
  moves?: number;
  /** The first sync stops on conflicts; a `synced` answer resolves them. */
  conflict?: boolean;
  /** How many merge attempts find main moved since the last sync (another run landed); each such sync brings something in. */
  stale?: number;
  subIssues?: string[];
  /** The branch carries a spec (`/sous-plan` ran), so `plan` never calls its agent; false: the task flow has to derive one. */
  spec?: boolean;
  agent: AgentScript[] | ((git: FakeGit, worktree: string) => AgentScript[]);
  /** The `baseBranch` setting the run is on (default `main`). */
  baseBranch?: string;
  exec?: FakeSandboxOptions["exec"];
};

const worktrees: string[] = [];
afterEach(() => Promise.all(worktrees.splice(0).map((w) => rm(w, { recursive: true, force: true }))));

const setup = async ({ labels, moves = 1, conflict = false, stale = 0, subIssues = [], spec = true, agent, baseBranch = "main", exec = {} }: Scenario): Promise<FakePorts> => {
  const worktree = await mkdtemp(join(tmpdir(), "sous-project-"));
  worktrees.push(worktree);
  if (spec) await writeSpec(worktree);
  const target = issue({ id: ISSUE, title: "Some feature", body: "Make it so.", labels });
  const tracker = fakeTracker({ issues: [target, ...subIssues.map((id) => issue({ id }))], subIssues: { [ISSUE]: subIssues } });
  const repoRoot = dirname(root);
  const git = fakeGit({ existing: [baseBranch, BRANCH], branches: { [worktree]: BRANCH, [repoRoot]: baseBranch }, trees: { [baseBranch]: "t-base", [BRANCH]: "t-branch" }, ancestors: new Set([`${baseBranch}..${BRANCH}`]), upToDate: moves === 0, conflict });
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
  const sandbox = fakeSandbox({ worktreePath: worktree, branch: BRANCH, agent: typeof agent === "function" ? agent(git, worktree) : agent, exec });
  return portsOf(sandbox, { baseBranch, skillsDir: join(root, "skills"), repoRoot, tracker, git, issue: { id: target.id, ref: target.ref, title: target.title, body: target.body, labels: target.labels } });
};

const sequence = (ports: FakePorts): string[] => ports.transitions.map((t) => t.from);

describe("validate", () => {
  it("passes sous.yaml and the three flows against the real steps", () => {
    const report = validateProject(root);
    expect(report.errors).toEqual([]);
    expect(report.flows).toEqual([flowFile("bench"), flowFile("feature"), flowFile("task")]);
    expect(report.note).toBeUndefined();
  });

  it("wires the same agents everywhere: Claude checks the issue, plans, builds, fixes, resolves and reviews", () => {
    const shared = ["implement", "review", "fix", "sync", "review-full", "fix-review-full"];
    for (const [name, agentic] of [
      ["feature", ["check-issue", ...shared]],
      ["task", ["check-issue", "plan", ...shared]],
    ] as const) {
      const flow = loadFlow(flowFile(name), { stepsDir: shippedSteps });
      const agents = flow.steps.filter((e) => e.agent !== undefined).map((e) => [e.id, e.agent?.kind, e.agent?.model]);
      expect(agents.map((a) => a[0])).toEqual(agentic);
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
    const ports = await setup({ labels: ["type:feature"], subIssues: ["14"], stale: 1, agent: [holds(), built("b14"), reviewed("r14"), reviewed("rf"), reviewed("rf2")] });

    const session = await walk(feature(), ports);

    expect(sequence(ports).slice(-8)).toEqual(["sync", "review-full", "sync", "merge", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(ports.git.calls.filter((c) => c.startsWith("squashMerge"))).toHaveLength(1);
  });

  it("builds and reviews two sub-issues, closes each, syncs, reviews in full, syncs again and merges", async () => {
    const ports = await setup({
      labels: ["type:feature"],
      subIssues: ["14", "15"],
      agent: [holds(), built("b14"), reviewed("r14"), holds(), built("b15"), reviewed("r15"), reviewed("rf")],
    });

    const session = await walk(feature(), ports);

    expect(sequence(ports)).toEqual(["init", "next-work", "check-issue", "implement", "review", "close-work", "next-work", "check-issue", "implement", "review", "close-work", "next-work", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(session.blocked).toBe(false);
    expect(session.work).toBe(ISSUE);
    expect(session.specDir).toBe("specs/12-some-feature");
    expect(session.workProgress).toEqual({ "12": { state: "done", commits: ["sha1"] }, "14": { state: "done", commits: ["b14"] }, "15": { state: "done", commits: ["b15"] } });
    expect(Object.keys(session.scopes).sort()).toEqual(["12", "14", "15"]);
    expect(session.scopes["14"]?.["review"]).toMatchObject({ visits: 1, ok: true, session: "r14" });
    expect(session.scopes["12"]?.["review-full"]).toMatchObject({ visits: 1, ok: true });
    expect(session.scopes["12"]?.["merge"]).toMatchObject({ ok: true, output: { sha: "sha1" } });

    const prompts = ports.sandbox.requests.map((r) => r.prompt);
    // Each child is checked against the code before it is built.
    expect(prompts[0]).toContain("# Check issue #14 against the code");
    expect(prompts[0]).toContain("#14 Issue #14");
    expect(prompts[1]).toContain("#14 Issue #14");
    // The spec (the file on the branch) and the skills folder come from ctx; rule files are never quoted into the prompt.
    expect(prompts[1]).toContain("## Spec (the design of record)\n\n# Spec: Some feature\n");
    expect(prompts[1]).toContain(`${join(root, "skills")}/implement/SKILL.md`);
    expect(prompts[1]).not.toContain("### CODING_STANDARDS.md");
    expect(prompts[1]).not.toMatch(/gradle/i);
    expect(prompts[2]).toContain("b14^..HEAD");
    expect(prompts[3]).toContain("# Check issue #15 against the code");
    expect(prompts[4]).toContain("#15 Issue #15");
    expect(prompts[6]).toContain("main...HEAD");
    // No spec file on the checkout: the issue is the spec review-full judges against.
    expect(prompts[6]).toContain("### Acceptance text\n\n# Spec: Some feature\n");
    expect(prompts[6]).toContain(`${join(root, "skills")}/code-review/SKILL.md`);

    // The verify checks run three times: after each implement, and in sync's eval after the merge brought main in.
    expect(ports.events.of("prepare.end").map((e) => e.agent)).toEqual(["always", "always", "on-fail", "never"]);
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, "npm test", DIFF_COMMAND, "npm test", DIFF_COMMAND, "npm test"]);
    expect(ports.tracker.issues.get("14")?.state).toBe("closed");
    expect(ports.tracker.issues.get("15")?.state).toBe("closed");
    // The harness runs no lifecycle: closing is `sous run`'s, the merge step only labels and comments.
    expect(ports.tracker.issues.get(ISSUE)).toMatchObject({ state: "open", labels: ["type:feature", "sous:merged"] });
    expect(ports.tracker.comments.map((c) => c.issue)).toEqual(["14", "15", ISSUE]);
    expect(ports.git.committed.map((c) => c.message)).toEqual(["feat(#12): Some feature"]);
    expect(ports.sandbox.closed).toBe(true);
  });

  it.each(["holds", "unclear"])("checks each child before it is built, and goes on to implement when the check answers %s", async (verdict) => {
    const ports = await setup({ labels: ["type:feature"], subIssues: ["14"], agent: [checkedIssue(verdict), built("b14"), reviewed("r14"), reviewed("rf")] });

    const session = await walk(feature(), ports);

    expect(sequence(ports).slice(0, 4)).toEqual(["init", "next-work", "check-issue", "implement"]);
    expect(session.current).toBe("done");
    expect(session.scopes["14"]?.["check-issue"]).toMatchObject({ ok: true, output: { verdict } });
    expect(ports.sandbox.requests[0]?.prompt).toContain("#14 Issue #14");
  });

  it("hands what the check found diverging in a child to implement and to the child's review, which gets it as a Decisions section", async () => {
    const divergence = ["The issue names src/B.kt; the code is in src/A.kt, where the defect reproduces."];
    const ports = await setup({ labels: ["type:feature"], subIssues: ["14"], spec: false, agent: [checkedIssue("holds", [GREP], divergence), built("b14"), reviewed("r14"), reviewed("rf")] });

    const session = await walk(feature(), ports);

    expect(session.current).toBe("done");
    expect(sequence(ports).slice(0, 5)).toEqual(["init", "next-work", "check-issue", "implement", "review"]);
    expect(ports.sandbox.requests[1]?.prompt).toContain(`- ${divergence[0]}`);
    expect(ports.sandbox.requests[2]?.prompt).toContain(`## Decisions\n\n- ${divergence[0]}`);
  });

  it.each(["fixed", "false-premise"])("stops at a child whose check answers %s, with the evidence as the blocked comment, and closes nothing", async (verdict) => {
    const ports = await setup({ labels: ["type:feature"], subIssues: ["14"], agent: [checkedIssue(verdict)] });

    const session = await walk(feature(), ports);

    expect(sequence(ports)).toEqual(["init", "next-work", "check-issue"]);
    expect(ports.transitions.at(-1)).toEqual({ from: "check-issue", to: "blocked", ok: false });
    expect(session).toMatchObject({ current: "check-issue", blocked: true });
    const log = session.scopes["14"]?.["check-issue"]?.log ?? "";
    expect(log).toContain(`#14 no longer holds (${verdict})`);
    expect(log).toContain("$ grep -rn 'make it so' src/\nsrc/A.kt:3: // TODO make it so");
    expect(ports.tracker.issues.get("14")?.state).toBe("open");
    expect(ports.tracker.issues.get(ISSUE)?.state).toBe("open");
  });

  it("goes on to the next child without an agent once the human closed the child the check blocked on", async () => {
    const ports = await setup({ labels: ["type:feature"], subIssues: ["14"], agent: [checkedIssue("fixed"), reviewed("rf")] });
    const blocked = await walk(feature(), ports);
    expect(blocked).toMatchObject({ current: "check-issue", blocked: true });

    await ports.tracker.close("14", "fixed on main");
    // As `sous run` does on a resumed run: ctx.work is the session's work item, the child.
    const child = await ports.tracker.getIssue("14");
    const session = await walk(feature(), { ...ports, work: { id: child.id, ref: child.ref, title: child.title, body: child.body } }, { session: blocked });

    expect(session.current).toBe("done");
    expect(sequence(ports).slice(3)).toEqual(["check-issue", "next-work", "sync", "review-full", "sync", "merge"]);
    expect(ports.events.of("prepare.end").map((e) => [e.agent, e.reason]).slice(0, 2)).toEqual([
      ["always", undefined],
      ["never", "#14 is closed"],
    ]);
    expect(ports.sandbox.requests.map((r) => r.prompt.split("\n")[0])).toEqual(["# Check issue #14 against the code", "# Review for issue #12"]);
  });

  it("reviews and fixes the whole branch against the base when a slice's implement committed nothing", async () => {
    const ports = await setup({ labels: ["type:feature"], subIssues: ["14"], agent: [holds(), unchanged("u14"), reviewed("r14", [MAJOR]), built("f14"), reviewed("r14b"), reviewed("rf")] });

    const session = await walk(feature(), ports);

    expect(sequence(ports).slice(0, 8)).toEqual(["init", "next-work", "check-issue", "implement", "review", "fix", "review", "close-work"]);
    expect(session.current).toBe("done");
    const prompts = ports.sandbox.requests.map((r) => r.prompt);
    expect(prompts[2]).toContain("main...HEAD");
    expect(prompts[2]).not.toContain("undefined");
    expect(prompts[3]).toContain("main...HEAD");
    expect(prompts[3]).not.toContain("undefined");
  });
});

describe("task", () => {
  const task = (): Flow => loadFlow(flowFile("task"), { stepsDir });

  it("on a dev base, syncs from, reviews against and merges onto dev", async () => {
    const ports = await setup({ labels: ["type:task"], baseBranch: "dev", agent: [holds(), built("b1"), reviewed("r1"), reviewed("rf1", [MAJOR]), built("f1"), reviewed("rf2")] });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "check-issue", "plan", "implement", "review", "sync", "review-full", "fix-review-full", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(ports.events.of("prepare.end").map((e) => e.reason)).toContain("merged dev cleanly");
    expect(ports.git.calls.filter((c) => c.startsWith("mergeInto"))).toEqual([`mergeInto(${ports.sandbox.worktreePath}, dev)`, `mergeInto(${ports.sandbox.worktreePath}, dev)`]);
    expect(ports.git.calls.filter((c) => c.startsWith("squashMerge"))).toEqual([`squashMerge(${dirname(root)}, ${BRANCH}, fix(#12): Some feature)`]);
    expect(ports.tracker.comments.at(-1)?.body).toContain("Merged into `dev`");
    const prompts = ports.sandbox.requests.map((r) => r.prompt);
    expect(prompts[2]).toContain("b1^..HEAD");
    for (const i of [3, 4, 5]) {
      expect(prompts[i]).toContain("dev...HEAD");
      expect(prompts[i]).not.toContain("main...HEAD");
    }
    expect(ports.sandbox.execs).toContain("git diff --name-only dev...HEAD");
    expect(ports.sandbox.execs).not.toContain(DIFF_COMMAND);
  });

  it("reviews and fixes the branch against the base when implement committed nothing", async () => {
    const ports = await setup({ labels: ["type:task"], baseBranch: "dev", agent: [holds(), unchanged("u1"), reviewed("r1", [MAJOR]), built("f1"), reviewed("r2"), reviewed("rf")] });

    const session = await walk(task(), ports);

    expect(sequence(ports).slice(0, 8)).toEqual(["init", "check-issue", "plan", "implement", "review", "fix", "review", "sync"]);
    expect(session.current).toBe("done");
    const prompts = ports.sandbox.requests.map((r) => r.prompt);
    for (const i of [2, 3, 4]) {
      expect(prompts[i]).toContain("dev...HEAD");
      expect(prompts[i]).not.toContain("undefined");
    }
  });

  it.each(["holds", "unclear"])("checks the issue against the code first, and plans when the check answers %s", async (verdict) => {
    const ports = await setup({ labels: ["type:task"], agent: [checkedIssue(verdict), built("b1"), reviewed("r1"), reviewed("rf")] });

    const session = await walk(task(), ports);

    expect(sequence(ports).slice(0, 4)).toEqual(["init", "check-issue", "plan", "implement"]);
    expect(session.current).toBe("done");
    const prompt = ports.sandbox.requests[0]?.prompt ?? "";
    expect(prompt).toContain("# Check issue #12 against the code");
    expect(prompt).toContain("#12 Some feature\n\nMake it so.");
  });

  it.each(["fixed", "false-premise"])("stops before plan when the check answers %s, with the verdict and the evidence as the blocked comment, and leaves the issue open", async (verdict) => {
    const ports = await setup({ labels: ["type:task"], agent: [checkedIssue(verdict, [GREP, { command: "npx vitest run test/a.test.ts", result: "1 passed" }])] });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "check-issue"]);
    expect(ports.transitions.at(-1)).toEqual({ from: "check-issue", to: "blocked", ok: false });
    expect(session).toMatchObject({ current: "check-issue", blocked: true });
    const log = session.scopes["12"]?.["check-issue"]?.log ?? "";
    expect(log).toContain(`#12 no longer holds (${verdict})`);
    expect(log).toContain("$ grep -rn 'make it so' src/\nsrc/A.kt:3: // TODO make it so\n$ npx vitest run test/a.test.ts\n1 passed");
    expect(ports.sandbox.requests).toHaveLength(1);
    expect(ports.tracker.issues.get(ISSUE)?.state).toBe("open");
  });

  it("stops at a blocking verdict without evidence instead of passing it", async () => {
    const ports = await setup({ labels: ["type:task"], agent: [checkedIssue("fixed", [])] });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "check-issue"]);
    expect(session).toMatchObject({ current: "check-issue", blocked: true });
  });

  it("hands what the check found diverging to plan, which writes it into the spec it derives", async () => {
    const divergence = ["The issue names src/B.kt; the code is in src/A.kt, where the defect reproduces."];
    const ports = await setup({ labels: ["type:task"], spec: false, agent: (_git, worktree) => [checkedIssue("holds", [GREP], divergence), planned(worktree), built("b1"), reviewed("r1"), reviewed("rf")] });

    const session = await walk(task(), ports);

    expect(session.current).toBe("done");
    expect(ports.sandbox.requests[1]?.prompt).toContain(`- ${divergence[0]}`);
  });

  it("derives a spec when the branch has none: plan's agent writes it, and implement and review-full get it as ctx.spec", async () => {
    const ports = await setup({ labels: ["type:task"], spec: false, agent: (_git, worktree) => [holds(), planned(worktree), built("b1"), reviewed("r1"), reviewed("rf")] });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "check-issue", "plan", "implement", "review", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(session.scopes["12"]?.["plan"]).toMatchObject({ ok: true, log: `plan: ${SPEC_DIR}/spec.md is on the branch with 1 assumption and no open questions` });
    const prompts = ports.sandbox.requests.map((r) => r.prompt);
    expect(prompts[1]).toContain("# Derive the spec for issue #12");
    expect(prompts[2]).toContain("- Make it so means make it so.");
    expect(prompts[4]).toContain("- Make it so means make it so.");
  });

  it("stops at plan with the open questions as the blocked comment, and passes them eval-first once the file is answered", async () => {
    const ports = await setup({ labels: ["type:task"], spec: false, agent: (_git, worktree) => [holds(), planned(worktree, ["CSV or JSON? I would pick CSV."]), built("b1"), reviewed("r1"), reviewed("rf")] });

    const blocked = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "check-issue", "plan"]);
    expect(blocked.current).toBe("plan");
    expect(blocked.blocked).toBe(true);
    expect(blocked.scopes["12"]?.["plan"]?.log).toContain("- CSV or JSON? I would pick CSV.");
    expect(ports.transitions.at(-1)).toEqual({ from: "plan", to: "blocked", ok: false });

    await writeSpec(ports.sandbox.worktreePath);
    const session = await walk(task(), ports, { session: blocked });

    expect(session.current).toBe("done");
    expect(ports.sandbox.requests.map((r) => r.prompt.split("\n")[0])).toEqual(["# Check issue #12 against the code", "# Derive the spec for issue #12", "# Build for issue #12", "# Review for issue #12", "# Review for issue #12"]);
  });
  const BUILD = "npm test";

  it("goes init -> check-issue -> plan -> implement -> review -> sync -> review-full -> sync -> merge; a clean merge whose checks pass never reaches the sync agent", async () => {
    const ports = await setup({ labels: ["type:task"], agent: [holds(), built("b1"), reviewed("r1"), reviewed("rf")] });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "check-issue", "plan", "implement", "review", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(Object.keys(session.scopes)).toEqual(["12"]);
    expect(session.workProgress).toEqual({ "12": { state: "done", commits: ["sha1"] } });
    expect(ports.events.of("prepare.end").map((e) => [e.agent, e.reason])).toEqual([
      ["always", undefined],
      ["never", `${SPEC_DIR}/spec.md is on the branch`],
      ["on-fail", "merged main cleanly"],
      ["never", `${BRANCH} is already up to date with main`],
    ]);
    expect(session.scopes["12"]?.["sync"]).toMatchObject({ visits: 2, ok: true, prepared: { agent: "never", output: { conflict: false, moved: false } } });
    expect(ports.sandbox.requests).toHaveLength(4);
    // implement's eval, then sync's eval after the merge that moved HEAD; the quiet second sync checks nothing.
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD]);
    expect(ports.git.committed.map((c) => c.message)).toEqual(["fix(#12): Some feature"]);
    expect(ports.tracker.issues.get(ISSUE)).toMatchObject({ state: "open", labels: ["type:task", "sous:merged"] });
  });

  it("syncs again when main moved after the last sync, and reviews what it brought in before merging", async () => {
    const ports = await setup({ labels: ["type:task"], stale: 1, agent: [holds(), built("b1"), reviewed("r1"), reviewed("rf"), reviewed("rf2")] });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "check-issue", "plan", "implement", "review", "sync", "review-full", "sync", "merge", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(session.scopes["12"]?.["merge"]).toMatchObject({ visits: 2, ok: true, output: { stale: false, sha: "sha1" } });
    // Only one squash landed; the stale visit merged and cleaned up nothing.
    expect(ports.git.committed.map((c) => c.message)).toEqual(["fix(#12): Some feature"]);
    expect(ports.git.removedWorktrees).toHaveLength(1);
    expect(ports.tracker.comments.filter((c) => c.body.startsWith("Merged into"))).toHaveLength(1);
  });

  it("stops blocked when main moved under the merge three times", async () => {
    const ports = await setup({ labels: ["type:task"], stale: 3, agent: [holds(), built("b1"), reviewed("r1"), reviewed("rf"), reviewed("rf2"), reviewed("rf3")] });

    const session = await walk(task(), ports);

    expect(sequence(ports).filter((s) => s === "merge")).toHaveLength(3);
    expect(session).toMatchObject({ current: "merge", blocked: true });
    expect(ports.git.calls.some((c) => c.startsWith("squashMerge"))).toBe(false);
  });

  it("as shipped, with no checks filled in yet: every eval passes with the warning in its log and runs nothing", async () => {
    const ports = await setup({ labels: ["type:task"], agent: [holds(), built("b1"), reviewed("r1"), reviewed("rf")] });

    const session = await walk(loadFlow(flowFile("task"), { stepsDir: shippedSteps }), ports);

    expect(sequence(ports)).toEqual(["init", "check-issue", "plan", "implement", "review", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(session.scopes["12"]?.["implement"]).toMatchObject({ ok: true, log: NO_CHECKS_WARNING });
    expect(ports.sandbox.execs).toEqual([]);
  });

  it("checks nothing again when main never brought anything in: implement's eval already built that HEAD", async () => {
    const ports = await setup({ labels: ["type:task"], moves: 0, agent: [holds(), built("b1"), reviewed("r1"), reviewed("rf")] });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "check-issue", "plan", "implement", "review", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD]);
  });

  it("hands failing checks after a clean merge to the sync agent, whose repair the eval checks and review-full reviews", async () => {
    const ports = await setup({
      labels: ["type:task"],
      agent: (git) => [holds(), built("b1"), reviewed("r1"), synced(git, "f1"), reviewed("rf")],
      // implement's eval passes; the merged branch fails sync's eval before the agent; it passes after the repair.
      exec: { [BUILD]: [ok("BUILD SUCCESSFUL\n"), fail("e: A.kt:3 type mismatch\n"), ok("BUILD SUCCESSFUL\n")] },
    });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "check-issue", "plan", "implement", "review", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(ports.events.of("prepare.end").map((e) => e.agent)).toEqual(["always", "never", "on-fail", "never"]);
    const prompts = ports.sandbox.requests.map((r) => r.prompt);
    expect(prompts[3]).toContain("# Bring main into the branch of issue #12");
    expect(prompts[3]).toContain("## The evaluation already ran");
    expect(prompts[3]).toContain("$ npm test (exit 1)\ne: A.kt:3 type mismatch");
    expect(ports.sandbox.requests[3]).not.toHaveProperty("resumeSession");
    expect(prompts[4]).toContain("main...HEAD");
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD]);
  });

  it("resolves a conflict in sync, with the checks as its eval, then reviews in full", async () => {
    const ports = await setup({ labels: ["type:task"], conflict: true, agent: (git) => [holds(), built("b1"), reviewed("r1"), synced(git, "m1"), reviewed("rf")] });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "check-issue", "plan", "implement", "review", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(ports.events.of("prepare.end").map((e) => e.agent)).toEqual(["always", "never", "always", "never"]);
    expect(ports.sandbox.requests[3]?.prompt).toContain("A merge in progress (`git status`) stopped on conflicts");
    // implement's eval, then sync's eval after the agent; prepare ran no checks on a conflict.
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD]);
  });

  it("reviews again when main moved during the review, and merges once a sync finds main quiet", async () => {
    const ports = await setup({ labels: ["type:task"], moves: 2, agent: [holds(), built("b1"), reviewed("r1"), reviewed("rf1"), reviewed("rf2")] });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "check-issue", "plan", "implement", "review", "sync", "review-full", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(session.scopes["12"]?.["review-full"]).toMatchObject({ visits: 2, ok: true, session: "rf2" });
    expect(session.scopes["12"]?.["sync"]).toMatchObject({ visits: 3 });
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD]);
  });

  it("blocks when the slice review hits its cap of three visits with blocking findings", async () => {
    const ports = await setup({
      labels: ["type:task"],
      agent: [holds(), built("b1"), reviewed("r1", [MAJOR]), built("f1"), reviewed("r2", [MAJOR]), built("f2"), reviewed("r3", [MAJOR])],
    });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "check-issue", "plan", "implement", "review", "fix", "review", "fix", "review"]);
    expect(ports.transitions.at(-1)).toEqual({ from: "review", to: "blocked", ok: false });
    expect(session).toMatchObject({ current: "review", blocked: true });
    expect(session.scopes["12"]?.["review"]).toMatchObject({ visits: 3, ok: false, log: "major src/A.kt:3 wrong", session: "r3" });
    expect(session.scopes["12"]?.["fix"]).toMatchObject({ visits: 2, commits: ["f2"], session: "s-f2" });

    const requests = ports.sandbox.requests;
    expect(requests).toHaveLength(7);
    expect(requests[3]?.resumeSession).toBe("s-b1");
    expect(requests[3]?.prompt).toContain("major src/A.kt:3 wrong");
    expect(requests[5]?.resumeSession).toBe("s-f1");
    // implement and both fixes ran the verify checks; sync was never reached.
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD]);
    expect(ports.tracker.issues.get(ISSUE)?.state).toBe("open");
  });

  it("blocks when review-full hits its cap of four visits", async () => {
    const ports = await setup({
      labels: ["type:task"],
      moves: 0,
      agent: [holds(), built("b1"), reviewed("r1"), reviewed("rf1", [MAJOR]), built("f1"), reviewed("rf2", [MAJOR]), built("f2"), reviewed("rf3", [MAJOR]), built("f3"), reviewed("rf4", [MAJOR])],
    });

    const session = await walk(task(), ports);

    expect(sequence(ports).slice(5)).toEqual(["sync", "review-full", "fix-review-full", "review-full", "fix-review-full", "review-full", "fix-review-full", "review-full"]);
    expect(ports.transitions.at(-1)).toEqual({ from: "review-full", to: "blocked", ok: false });
    expect(session.scopes["12"]?.["review-full"]).toMatchObject({ visits: 4, ok: false });
  });

  it("retries implement in the same session with the failed verify transcript when its eval fails, then goes on", async () => {
    const ports = await setup({
      labels: ["type:task"],
      agent: [holds(), built("b1"), built("b2"), reviewed("r1"), reviewed("rf")],
      exec: { [BUILD]: [fail("e: A.kt:3 type mismatch\n"), ok("BUILD SUCCESSFUL\n")] },
    });

    const session = await walk(task(), ports);

    expect(sequence(ports)).toEqual(["init", "check-issue", "plan", "implement", "review", "sync", "review-full", "sync", "merge"]);
    expect(session.current).toBe("done");
    expect(session.iterations).toMatchObject({ implement: 2 });
    expect(session.scopes["12"]?.["implement"]).toMatchObject({ visits: 1, ok: true, session: "s-b2", log: "$ npm test (exit 0)\nBUILD SUCCESSFUL" });

    const requests = ports.sandbox.requests;
    expect(requests).toHaveLength(5);
    expect(requests[2]?.resumeSession).toBe("s-b1");
    expect(requests[2]?.prompt).toContain("did not pass evaluation");
    expect(requests[2]?.prompt).toContain("$ npm test (exit 1)\ne: A.kt:3 type mismatch");
    expect(requests[3]?.prompt).toContain("b2^..HEAD");
    expect(ports.sandbox.execs).toEqual([DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD, DIFF_COMMAND, BUILD]);
  });
});
