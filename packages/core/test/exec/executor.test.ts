import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentOutputError, AgentProcessError } from "../../src/exec/errors.js";
import { runFlow } from "../../src/exec/executor.js";
import { failedEvalSection, retryPrompt } from "../../src/exec/prompt.js";
import { openVisit, recordVisit, updateVisit, type Session } from "../../src/exec/scope.js";
import type { Event } from "../../src/session/events.js";
import { foldTimeline } from "../../src/session/timeline.js";
import { bumpIteration, markBlocked, setWork } from "../../src/session/update.js";
import { fakeEventLog } from "../fakes/eventlog.js";
import { answer, CODEX, entryOf, flowOf, portsOf, sessionOf, visit } from "../fakes/executor.js";
import { fakeGit } from "../fakes/git.js";
import { agentResult, fail, fakeSandbox, ok } from "../fakes/sandbox.js";
import { issue } from "../fakes/tracker.js";

const work14 = { id: "14", ref: "#14", title: "Work 14", body: "do 14" };

const runStart: Event = { type: "run.start", at: "2026-10-02T08:00:00.000Z", runId: "r1", pid: 1, host: "h", sha: "x", flow: "test" };

describe("runFlow: agentic steps", () => {
  it("loops agent -> eval until eval passes, resuming the visit's session with the retry prompt", async () => {
    const sandbox = fakeSandbox({ agent: [answer("s1", false, "fail 1"), answer("s2", false, "fail 2"), answer("s3")] });
    const build = entryOf("build", "agent", { with: { task: "${{ ctx.issue.title }}" } });
    const ports = portsOf(sandbox);

    const { session, requests, next } = await visit(build, undefined, ports);

    expect(next).toBe("done");
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({ agent: { kind: "claude", model: "claude-x" }, logPath: `${ports.logsDir}/1/r1-1-1-build-1.log`, outputSchema: build.step.run?.output });
    expect(requests[0]?.prompt).toContain("Do Test issue in /tmp/worktree for #1.");
    expect(requests[0]?.prompt).toContain("## Output contract");
    expect(requests[0]).not.toHaveProperty("resumeSession");
    expect(requests[1]).toMatchObject({ resumeSession: "s1", prompt: retryPrompt("fail 1"), logPath: `${ports.logsDir}/1/r1-1-1-build-2.log` });
    expect(requests[2]).toMatchObject({ resumeSession: "s2", prompt: retryPrompt("fail 2") });

    expect(session.current).toBe("done");
    expect(session.scopes["1"]?.["build"]).toEqual({ visits: 1, ok: true, log: "eval of iteration 3", output: { ok: true }, commits: ["c-s3"], session: "s3" });
    expect(session.iterations["build"]).toBe(3);
    expect(ports.events.of("output").map((o) => [o.iteration, o.sessionId, o.eval.ok, o.eval.logTail])).toEqual([
      [1, "s1", false, "fail 1"],
      [2, "s2", false, "fail 2"],
      [3, "s3", true, "eval of iteration 3"],
    ]);
    const close = ports.events.of("span.close")[0];
    expect(session.history).toEqual([{ step: "build", at: close?.at, ok: true, next: "done" }]);
    expect(ports.transitions).toEqual([{ from: "build", to: "done", ok: true }]);
  });

  it("goes to blocked without consulting the routes when the default cap of 3 is exhausted", async () => {
    const sandbox = fakeSandbox({ agent: [answer("s1", false, "nope"), answer("s2", false, "nope"), answer("s3", false, "nope"), answer("s4")] });
    const build = entryOf("build", "agent", { with: { task: "x" }, routes: [{ to: "done" }] });
    const ports = portsOf(sandbox);

    const { session, requests, next } = await visit(build, undefined, ports);

    expect(requests).toHaveLength(3);
    expect(next).toBe("blocked");
    expect(session).toMatchObject({ current: "build", blocked: true, iterations: { build: 3 } });
    expect(session.scopes["1"]?.["build"]).toMatchObject({ visits: 1, ok: false, log: "nope", session: "s3" });
    expect(session.history).toEqual([expect.objectContaining({ step: "build", ok: false, next: "blocked" })]);
  });

  it("takes maxIterations from the entry over the step over the default", async () => {
    const twice = fakeSandbox({ agent: [answer("a", false), answer("b", false), answer("c", false)], exec: { verify: fail("red") } });
    const stepCap = await visit(entryOf("review", "agent-shell", { with: { task: "x" }, agent: CODEX }), undefined, portsOf(twice));
    expect(stepCap.requests).toHaveLength(2);
    expect(stepCap.next).toBe("blocked");

    const once = fakeSandbox({ agent: [answer("a", false), answer("b", false)] });
    const entryCap = await visit(entryOf("build", "agent", { with: { task: "x" }, maxIterations: 1 }), undefined, portsOf(once));
    expect(entryCap.requests).toHaveLength(1);
    expect(entryCap.next).toBe("blocked");
  });

  it("loop: false routes a failed eval after one request instead of retrying", async () => {
    const sandbox = fakeSandbox({ agent: [answer("r1", false, "blocking findings"), answer("r2")] });
    const review = entryOf("review", "agent", {
      agent: CODEX,
      with: { task: "judge" },
      loop: false,
      routes: [
        { to: "done", when: "res.ok" },
        { to: "fix", else: true },
      ],
    });
    const ports = portsOf(sandbox);

    const { session, requests, next } = await visit(review, undefined, ports);

    expect(requests).toHaveLength(1);
    expect(next).toBe("fix");
    expect(session.blocked).toBe(false);
    expect(session.history[0]).toEqual(expect.objectContaining({ step: "review", ok: false, next: "fix" }));
    expect(session.scopes["1"]?.["review"]).toMatchObject({ ok: false, log: "blocking findings" });
    expect(ports.transitions.map((t) => t.to)).toEqual(["fix", "done"]);
  });

  it("resumes the session named by resume: on the first iteration only", async () => {
    const sandbox = fakeSandbox({ agent: [answer("f1", false, "still red"), answer("f2")] });
    const fix = entryOf("fix", "agent", { with: { task: "fix" }, resume: "${{ steps.fix?.session ?? steps.build.session }}" });
    const initial = recordVisit(sessionOf("fix"), "build", { ok: true, log: "", output: {}, commits: ["b"], session: "b1" });

    const { requests } = await visit(fix, initial, portsOf(sandbox));

    expect(requests[0]?.resumeSession).toBe("b1");
    expect(requests[1]?.resumeSession).toBe("f1");
  });

  it("a second visit of a step resumes its own previous session through steps.<id>.session", async () => {
    const sandbox = fakeSandbox({ agent: [answer("f1"), answer("f2")] });
    const fix = entryOf("fix", "agent", { with: { task: "fix" }, resume: "${{ steps.fix?.session }}", routes: [{ to: "again", when: "steps.fix.visits < 2" }, { to: "done" }] });
    const again = entryOf("again", "void", { routes: [{ to: "fix" }] });
    const ports = portsOf(sandbox);

    const session = await runFlow(flowOf(fix, again), sessionOf("fix"), ports);

    expect(sandbox.requests.map((r) => r.resumeSession)).toEqual([undefined, "f1"]);
    expect(session.scopes["1"]?.["fix"]).toMatchObject({ visits: 2, session: "f2" });
    expect(session.history.map((h) => h.next)).toEqual(["again", "fix", "done"]);
  });
});

describe("runFlow: skill audit", () => {
  it("records a skills event per agent call and warns about each problem without failing the step", async () => {
    const root = await mkdtemp(join(tmpdir(), "sous-exec-skills-"));
    await mkdir(join(root, "skills", "tdd"), { recursive: true });
    await writeFile(join(root, "skills", "tdd", "SKILL.md"), "red, green, refactor\n");
    const warnings: string[] = [];
    const claimed = { ...answer("s1"), envelope: { ...answer("s1").envelope, skills: [{ name: "tdd", status: "followed" as const }] } };
    const sandbox = fakeSandbox({ agent: [{ ...claimed, toolCalls: [{ name: "Bash", input: { command: `head -1 ${root}/skills/tdd/SKILL.md` } }] }] });
    const ports = portsOf(sandbox, { skillsDir: join(root, "skills"), log: { info: () => undefined, warn: (line) => warnings.push(line) } });

    try {
      const { next } = await visit(entryOf("build", "agent", { with: { task: "it, following `/tdd`," } }), undefined, ports);

      expect(next).toBe("done");
      expect(ports.events.of("skills")).toEqual([
        expect.objectContaining({
          spanId: "r1-1",
          n: 1,
          expected: ["tdd"],
          reported: [{ name: "tdd", status: "followed" }],
          read: [{ name: "tdd", full: true }],
          problems: [],
        }),
      ]);
      expect(warnings).toEqual([]);

      const lazy = portsOf(fakeSandbox({ agent: [{ ...answer("s2"), toolCalls: [] }] }), { skillsDir: join(root, "skills"), log: { info: () => undefined, warn: (line) => warnings.push(line) } });
      expect((await visit(entryOf("build", "agent", { with: { task: "it, following `/tdd`," } }), undefined, lazy)).next).toBe("done");
      expect(warnings).toEqual(["build: skills: tdd: the instructions point to it, but the skills list leaves it out"]);
      expect(ports.events.types()).toEqual(expect.arrayContaining(["iteration.agent.end", "skills", "iteration.eval.start"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runFlow: agent failures", () => {
  it("records invalid output as a failed iteration and resumes that session with the error", async () => {
    const sandbox = fakeSandbox({ agent: [new AgentOutputError("<result> is not valid JSON", "{x", "s1", "/logs/build-1.2.log"), answer("s1")] });
    const ports = portsOf(sandbox);

    const { session, requests, next } = await visit(entryOf("build", "agent", { with: { task: "x" } }), undefined, ports);

    expect(next).toBe("done");
    expect(requests[1]).toMatchObject({ resumeSession: "s1", prompt: retryPrompt("<result> is not valid JSON") });
    expect(ports.events.of("iteration.agent.end").map((e) => [e.outcome, e.sessionId, e.logPath])).toEqual([
      ["invalid-output", "s1", "/logs/build-1.2.log"],
      ["ok", "s1", undefined],
    ]);
    expect(ports.events.of("iteration.eval.start")).toHaveLength(1);
    expect(ports.events.of("output")[0]).toMatchObject({
      iteration: 1,
      sessionId: "s1",
      envelope: { summary: "agent output did not validate: <result> is not valid JSON", commits: [], output: null },
      eval: { ok: false, logTail: "<result> is not valid JSON" },
    });
    expect(session.iterations["build"]).toBe(2);
  });

  it("starts over with the original prompt after a process failure without a session, and resumes with the error when there is one", async () => {
    const noSession = fakeSandbox({ agent: [new AgentProcessError("claude exited with code 137", { exitCode: 137, logTail: "last line" }), answer("s2")] });
    const first = await visit(entryOf("build", "agent", { with: { task: "x" } }), undefined, portsOf(noSession));
    expect(first.next).toBe("done");
    expect(first.requests[1]?.prompt).toBe(first.requests[0]?.prompt);
    expect(first.requests[1]).not.toHaveProperty("resumeSession");
    expect(first.ports.events.of("output")[0]?.eval.logTail).toBe("claude exited with code 137\n\nAgent log:\nlast line");

    const withSession = fakeSandbox({ agent: [new AgentProcessError("idle timeout", { sessionId: "s1" }), answer("s1")] });
    const second = await visit(entryOf("build", "agent", { with: { task: "x" } }), undefined, portsOf(withSession));
    expect(second.requests[1]).toMatchObject({ resumeSession: "s1", prompt: retryPrompt("idle timeout") });
    expect(second.ports.events.of("iteration.agent.end")[0]).toMatchObject({ outcome: "process-failed", sessionId: "s1" });
  });

  it("counts failures against maxIterations also with loop: false and blocks when exhausted", async () => {
    const crash = (n: number) => new AgentProcessError(`codex exited with code 1 (${n})`, { exitCode: 1 });
    const sandbox = fakeSandbox({ agent: [crash(1), crash(2), answer("r3")] });
    const review = entryOf("review", "agent", { agent: CODEX, with: { task: "x" }, loop: false, maxIterations: 2 });
    const ports = portsOf(sandbox);

    const { session, requests, next } = await visit(review, undefined, ports);

    expect(requests).toHaveLength(2);
    expect(next).toBe("blocked");
    expect(session).toMatchObject({ blocked: true, iterations: { review: 2 } });
    expect(session.scopes["1"]?.["review"]).toMatchObject({ ok: false, log: "codex exited with code 1 (2)" });
    // The failure's placeholder envelope is in the event log only, never the record: on re-entry it would count as the work.
    expect(session.scopes["1"]?.["review"]?.output).toBeUndefined();
    expect(ports.events.of("output").map((e) => e.envelope.output)).toEqual([null, null]);
    expect(ports.events.of("iteration.eval.start")).toEqual([]);
  });

  it("loop: false still retries invalid output", async () => {
    const sandbox = fakeSandbox({ agent: [new AgentOutputError("no <result> tag", undefined, "r1"), answer("r1")] });
    const { requests, next } = await visit(entryOf("review", "agent", { with: { task: "x" }, loop: false }), undefined, portsOf(sandbox));
    expect(requests).toHaveLength(2);
    expect(next).toBe("done");
  });

  it("propagates any other error from the sandbox, leaving the span open", async () => {
    const ports = portsOf(fakeSandbox({ agent: [new Error("sandcastle exploded")] }));
    await expect(visit(entryOf("build", "agent", { with: { task: "x" } }), undefined, ports)).rejects.toThrow("sandcastle exploded");
    expect(ports.events.types()).toEqual(["span.open", "iteration.agent.start"]);
    expect(ports.persisted).toHaveLength(1);
  });
});

describe("runFlow: deterministic steps", () => {
  it("runs the module once and records its envelope as iteration 1, without eval events when there is no eval", async () => {
    const ports = portsOf();
    const { session, next } = await visit(entryOf("start", "echo", { with: { a: "${{ ctx.issue.id }}", b: "lit" } }), undefined, ports);

    expect(next).toBe("done");
    expect(ports.events.types()).toEqual(["span.open", "output", "span.close"]);
    expect(ports.events.of("output")[0]).toMatchObject({ step: "start", iteration: 1, scope: "1", envelope: { output: { inputs: { a: "1", b: "lit" }, work: { id: "1" }, previous: null } } });
    expect(ports.events.of("output")[0]).not.toHaveProperty("sessionId");
    expect(session.scopes["1"]?.["start"]).toEqual({ visits: 1, ok: true, log: "", output: { inputs: { a: "1", b: "lit" }, work: expect.objectContaining({ id: "1" }), previous: null, iteration: null }, commits: [] });
    expect(ports.sandbox.requests).toEqual([]);
  });

  it("evaluates once and routes a failed eval; a void module records no output", async () => {
    const check = entryOf("check", "echo-eval", {
      with: { pass: "no" },
      routes: [
        { to: "done", when: "res.ok" },
        { to: "fix", when: "!res.ok && result.output.inputs.pass === 'no'" },
        { to: "blocked" },
      ],
    });
    const ports = portsOf();
    const { session, next } = await visit(check, undefined, ports);

    expect(next).toBe("fix");
    expect(session.scopes["1"]?.["check"]).toMatchObject({ ok: false, log: "pass=no iteration=1 result=some", commits: ["e1"] });
    expect(ports.events.types().slice(0, 5)).toEqual(["span.open", "iteration.eval.start", "iteration.eval.end", "output", "span.close"]);

    const nothing = await visit(entryOf("noop", "void"), undefined, portsOf());
    expect(nothing.next).toBe("done");
    expect(nothing.ports.events.of("output")).toEqual([]);
    expect(nothing.session.scopes["1"]?.["noop"]).toEqual({ visits: 1, ok: true, log: "", commits: [] });
  });

  it("runs an eval-only step's eval once with no result and routes on it", async () => {
    const routes = [
      { to: "done", when: "res.ok" },
      { to: "fix", else: true as const },
    ];
    const ports = portsOf();
    const { session, next } = await visit(entryOf("verify", "eval-only", { with: { pass: "no" }, routes }), undefined, ports);

    expect(next).toBe("fix");
    expect(session.scopes["1"]?.["verify"]).toEqual({ visits: 1, ok: false, log: "pass=no iteration=1 result=none", commits: [] });
    expect(ports.events.types()).toEqual(["span.open", "iteration.eval.start", "iteration.eval.end", "span.close", "span.open", "span.close"]);
    expect(ports.events.of("output")).toEqual([]);
    expect(ports.sandbox.requests).toEqual([]);

    const green = await visit(entryOf("verify", "eval-only", { routes }));
    expect(green.next).toBe("done");
    expect(green.session.scopes["1"]?.["verify"]).toMatchObject({ ok: true, log: "pass=undefined iteration=1 result=none" });
  });

  it("crashes when the module throws, recording neither output nor transition", async () => {
    const ports = portsOf();
    await expect(visit(entryOf("boom", "throw"), undefined, ports)).rejects.toThrow("module exploded");
    expect(ports.events.types()).toEqual(["span.open"]);
    expect(ports.persisted[0]?.history).toEqual([]);
  });

  it("runs a shell eval in the worktree: ok iff exit 0, log = stdout + stderr", async () => {
    const sandbox = fakeSandbox({ agent: [answer("a"), answer("b")], exec: { verify: [fail("red\n"), ok("green\n")] } });
    const ports = portsOf(sandbox);
    const { session, requests, next } = await visit(entryOf("build", "agent-shell", { with: { task: "x" } }), undefined, ports);

    expect(next).toBe("done");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.prompt).toBe(retryPrompt("red\n"));
    expect(sandbox.execs).toEqual(["verify", "verify"]);
    expect(session.scopes["1"]?.["build"]).toMatchObject({ ok: true, log: "green\n" });
  });
});

describe("runFlow: with, routes and scope", () => {
  it("evaluates with: at visit start over ctx and steps; a whole-string expression keeps its type", async () => {
    const a = entryOf("a", "echo", { with: { a: "${{ ctx.issue.title }}", b: "${{ ({ n: ctx.issue.id }) }}" }, routes: [{ to: "b" }] });
    const b = entryOf("b", "echo", { with: { a: "${{ steps.a.output.inputs.a + '!' }}", b: "after ${{ ctx.previous }} #${{ steps.a.output.inputs.b.n }}" } });
    const ports = portsOf();

    const session = await runFlow(flowOf(a, b), sessionOf("a"), ports);

    expect(session.scopes["1"]?.["b"]?.output).toEqual({ inputs: { a: "Test issue!", b: "after a #1" }, work: expect.objectContaining({ id: "1" }), previous: "a", iteration: null });
  });

  it("names the input when a with: expression throws", async () => {
    const b = entryOf("b", "echo", { with: { a: "${{ steps.missing.output.x }}" } });
    await expect(visit(b)).rejects.toThrow("b: with.a: ");
  });

  it("picks the first matching route; a trailing route without when is the fallthrough", async () => {
    const routes = [
      { to: "never", when: "false" },
      { to: "second", when: "res.ok && result.output.inputs.a === 'go'" },
      { to: "third", when: "res.ok" },
      { to: "fallback" },
    ];
    expect((await visit(entryOf("s", "echo", { with: { a: "go" }, routes }))).next).toBe("second");
    expect((await visit(entryOf("s", "echo", { with: { a: "stop" }, routes }))).next).toBe("third");
    expect((await visit(entryOf("s", "echo-eval", { with: { pass: "no" }, routes }))).next).toBe("fallback");
  });

  it("sees ctx.iteration and steps in routes, and throws when nothing matches", async () => {
    const sandbox = fakeSandbox({ agent: [answer("s1", false, "x"), answer("s2")] });
    const build = entryOf("build", "agent", { with: { task: "t" }, routes: [{ to: "done", when: "ctx.iteration === 2 && steps.build.visits === 1 && steps.build.ok" }, { to: "blocked" }] });
    expect((await visit(build, undefined, portsOf(sandbox))).next).toBe("done");

    const none = entryOf("s", "echo", { routes: [{ to: "done", when: "false" }] });
    await expect(visit(none)).rejects.toThrow("s: no route matched");
  });

  it("routes to done and blocked by name; blocked keeps current without a counter", async () => {
    const stuck = await visit(entryOf("next-work", "echo", { routes: [{ to: "blocked" }] }));
    expect(stuck.session).toMatchObject({ current: "next-work", blocked: true });
    expect(stuck.ports.transitions).toEqual([{ from: "next-work", to: "blocked", ok: true }]);

    const finished = await visit(entryOf("merge", "echo"));
    expect(finished.session.current).toBe("done");
    expect(finished.ports.persisted.at(-1)?.current).toBe("done");
  });

  it("gives every agent call its own log file: another work item and a re-visit of the step in the same scope", async () => {
    const sandbox = fakeSandbox({ agent: [answer("u1"), answer("u2"), answer("v1")] });
    const pick14 = entryOf("pick-14", "set-work", { with: { work: "${{ ({ id: '14', ref: '#14', title: 'Work 14', body: 'do 14' }) }}" }, routes: [{ to: "build" }] });
    const build = entryOf("build", "agent", {
      with: { task: "${{ ctx.work.title }}" },
      routes: [
        { to: "build", when: "ctx.work.id === '14' && steps.build.visits < 2" },
        { to: "pick-15", when: "ctx.work.id === '14'" },
        { to: "done" },
      ],
    });
    const pick15 = entryOf("pick-15", "set-work", { with: { work: "${{ ({ id: '15', ref: '#15', title: 'Work 15', body: 'do 15' }) }}" }, routes: [{ to: "build" }] });
    const ports = portsOf(sandbox);

    await runFlow(flowOf(pick14, build, pick15), sessionOf("pick-14"), ports);

    const paths = sandbox.requests.map((r) => r.logPath);
    expect(paths).toEqual([`${ports.logsDir}/1/r1-2-14-build-1.log`, `${ports.logsDir}/1/r1-3-14-build-1.log`, `${ports.logsDir}/1/r1-5-15-build-1.log`]);
    expect(ports.events.of("iteration.agent.start").map((e) => e.logPath)).toEqual(paths);
  });

  it("scopes steps.* by work item: a module that assigns ctx.work opens the scope, visits count per scope, span.open names it", async () => {
    const sandbox = fakeSandbox({ agent: [answer("u1"), answer("u2"), answer("f1")] });
    const pick = entryOf("next-work", "set-work", { with: { work: "${{ ({ id: '14', ref: '#14', title: 'Work 14', body: 'do 14' }) }}" }, routes: [{ to: "build" }] });
    const build = entryOf("build", "agent", {
      with: { task: "${{ ctx.work.id + ': ' + ctx.work.title }}" },
      routes: [
        { to: "build", when: "steps.build.visits < 2" },
        { to: "sync" },
      ],
    });
    const sync = entryOf("sync", "set-work", { routes: [{ to: "full-build", when: "steps.build === undefined && ctx.work.id === ctx.issue.id" }, { to: "blocked" }] });
    const fullBuild = entryOf("full-build", "agent", { with: { task: "${{ ctx.work.title }}" } });
    const ports = portsOf(sandbox);

    const session = await runFlow(flowOf(pick, build, sync, fullBuild), sessionOf("next-work"), ports);

    expect(session.current).toBe("done");
    expect(session.work).toBe("1");
    expect(session.workProgress).toEqual({ "1": { state: "open", commits: [] }, "14": { state: "open", commits: [] } });
    expect(Object.keys(session.scopes).sort()).toEqual(["1", "14"]);
    expect(session.scopes["14"]?.["build"]).toMatchObject({ visits: 2, session: "u2", commits: ["c-u2"] });
    expect(session.scopes["14"]).not.toHaveProperty("next-work");
    expect(session.scopes["1"]?.["next-work"]).toMatchObject({ visits: 1, output: { work: work14 } });
    // A record stays in the scope its visit opened in, even when the visit moved the work elsewhere.
    expect(session.scopes["14"]?.["sync"]).toMatchObject({ visits: 1, output: { work: { id: "1" } } });
    expect(session.scopes["1"]?.["full-build"]).toMatchObject({ visits: 1, session: "f1" });
    expect(sandbox.requests.map((r) => r.prompt.split("\n")[0])).toEqual(["Do 14: Work 14 in /tmp/worktree for #1.", "Do 14: Work 14 in /tmp/worktree for #1.", "Do Test issue in /tmp/worktree for #1."]);
    expect(ports.events.of("span.open").map((s) => [s.step, s.scope])).toEqual([
      ["next-work", "1"],
      ["build", "14"],
      ["build", "14"],
      ["sync", "14"],
      ["full-build", "1"],
    ]);
    // span.close names the scope after the visit's writes: next-work picked #14, sync put the issue back.
    expect(ports.events.of("span.close").map((c) => c.scopeAfter)).toEqual(["14", "14", "14", "1", "1"]);
    expect(ports.events.of("output").map((o) => [o.step, o.scope])).toEqual([
      ["next-work", "1"],
      ["build", "14"],
      ["build", "14"],
      ["sync", "14"],
      ["full-build", "1"],
    ]);
  });

  it("starts in the scope and work item the session and ports describe", async () => {
    const initial = setWork(sessionOf("build"), "14");
    const { session, requests } = await visit(entryOf("build", "agent", { with: { task: "${{ ctx.work.title }}" } }), initial, portsOf(fakeSandbox({ agent: [answer("s1")] }), { work: work14 }));
    expect(requests[0]?.prompt).toContain("Do Work 14 in");
    expect(session.scopes["14"]?.["build"]).toMatchObject({ visits: 1 });
  });

  it("records a module's other writes after the call: ctx.workDone into session.workProgress, an assigned ctx.specDir into the session", async () => {
    const initial = setWork(sessionOf("close-work"), "14");
    const entry = entryOf("close-work", "writes", { with: { specDir: "specs/1-planned", done: "${{ ['a', 'b'] }}" }, routes: [{ to: "next" }] });
    const next = entryOf("next", "writes", { with: { done: "${{ ['c'] }}" } });
    const ports = portsOf(fakeSandbox(), { work: work14 });

    const session = await runFlow(flowOf(entry, next), initial, ports);

    expect(session.specDir).toBe("specs/1-planned");
    expect(session.workProgress).toEqual({ "1": { state: "open", commits: [] }, "14": { state: "done", commits: ["a", "b", "c"] } });
    // The module saw the record as it was before its own write, and the later step sees the recorded one.
    expect(session.scopes["14"]?.["close-work"]?.output).toEqual({ specDir: "specs/1-test-issue", workProgress: { "1": { state: "open", commits: [] }, "14": { state: "open", commits: [] } } });
    expect(session.scopes["14"]?.["next"]?.output).toEqual({ specDir: "specs/1-planned", workProgress: { "1": { state: "open", commits: [] }, "14": { state: "done", commits: ["a", "b"] } } });
    expect(ports.persisted.at(-1)?.specDir).toBe("specs/1-planned");
  });

  it("marks the issue's own progress entry when a module calls ctx.workDone with the issue on the bench", async () => {
    const entry = entryOf("finish", "writes", { with: { done: "${{ ['a'] }}" } });
    const session = await runFlow(flowOf(entry), sessionOf("finish"), portsOf());
    expect(session.work).toBe("1");
    expect(session.workProgress).toEqual({ "1": { state: "done", commits: ["a"] } });
  });
});

describe("runFlow: events and persistence", () => {
  it("emits the full sequence for one agentic visit with two iterations and one deterministic visit, in clock order", async () => {
    const sandbox = fakeSandbox({ agent: [answer("s1", false, "red"), answer("s2")] });
    const build = entryOf("build", "agent", { with: { task: "x" }, routes: [{ to: "verify", when: "res.ok" }, { to: "blocked" }] });
    const verify = entryOf("verify", "echo-eval");
    const git = fakeGit();
    git.committed.push({ cwd: "/tmp/worktree", message: "work", sha: "head1" });
    const ports = portsOf(sandbox, { git });

    const session = await runFlow(flowOf(build, verify), sessionOf("build"), ports);

    expect(ports.events.types()).toEqual([
      "span.open",
      "iteration.agent.start", "iteration.agent.end", "iteration.eval.start", "iteration.eval.end", "output",
      "iteration.agent.start", "iteration.agent.end", "iteration.eval.start", "iteration.eval.end", "output",
      "span.close",
      "span.open", "iteration.eval.start", "iteration.eval.end", "output", "span.close",
    ]);
    const ats = ports.events.events.map((e) => e.at);
    expect([...ats].sort()).toEqual(ats);

    const { spans } = foldTimeline([runStart, ...ports.events.events]);
    expect(spans.map((s) => [s.id, s.step, s.scope])).toEqual([["r1-1", "build", "1"], ["r1-2", "verify", "1"]]);
    expect(spans[0]).toMatchObject({ ok: true, next: "verify", headSha: "head1", runId: "r1" });
    const [first, second] = spans[0]?.iterations ?? [];
    expect(first).toMatchObject({ n: 1, agent: { kind: "claude", model: "claude-x", outcome: "ok", sessionId: "s1", commits: ["c-s1"] }, eval: { ok: false } });
    expect(first?.agent).not.toHaveProperty("resumedSession");
    expect(second).toMatchObject({ n: 2, agent: { outcome: "ok", sessionId: "s2", resumedSession: "s1", commits: ["c-s2"] }, eval: { ok: true } });
    expect(spans[0]?.endedAt).toBe(session.history[0]?.at);
    expect(spans[1]).toMatchObject({ ok: true, next: "done", iterations: [{ n: 1, eval: { ok: true } }] });
    expect(ports.events.of("output").map((o) => o.spanId)).toEqual(["r1-1", "r1-1", "r1-2"]);
  });

  it("names spans span-<n> without a run id and appends to a log with earlier events", async () => {
    const events = fakeEventLog([runStart]);
    const ports = portsOf(fakeSandbox(), { events });
    await runFlow(flowOf(entryOf("a", "void", { routes: [{ to: "b" }] }), entryOf("b", "void")), sessionOf("a"), { ...ports, runId: "" });
    expect(events.of("span.open").map((s) => [s.spanId, s.runId])).toEqual([["span-1", ""], ["span-2", ""]]);
  });

  it("writes the scope record at three points: visits at span open, session after each agent call, the rest at the end", async () => {
    const sandbox = fakeSandbox({ agent: [answer("s1", false, "x"), answer("s2")] });
    const build = entryOf("build", "agent", { with: { task: "t" }, routes: [{ to: "verify" }] });
    const verify = entryOf("verify", "echo-eval");
    const ports = portsOf(sandbox);

    await runFlow(flowOf(build, verify), sessionOf("build"), ports);

    const records = ports.persisted.map((s) => s.scopes["1"]?.["build"]);
    // build: span open, agent call 1, agent call 2, transition; verify: span open, transition.
    expect(ports.persisted.map((s) => s.current)).toEqual(["build", "build", "build", "verify", "verify", "done"]);
    expect(records[0]).toEqual({ visits: 1, ok: true, log: "", commits: [] });
    expect(records[1]).toEqual({ visits: 1, ok: true, log: "", commits: [], session: "s1" });
    expect(records[2]).toEqual({ visits: 1, ok: true, log: "", commits: [], session: "s2" });
    expect(records[3]).toEqual({ visits: 1, ok: true, log: "eval of iteration 2", output: { ok: true }, commits: ["c-s2"], session: "s2" });
    expect(ports.persisted.map((s) => s.iterations["build"])).toEqual([0, 1, 2, 2, 2, 2]);
    expect(ports.persisted.map((s) => s.history.length)).toEqual([0, 0, 0, 1, 1, 2]);
  });

  it("appends span.open and iteration.agent.start, and persists once, before the agent is invoked", async () => {
    const ports = portsOf();
    const seen: { events: string[]; persisted: number }[] = [];
    const sandbox = fakeSandbox({
      agent: [
        () => {
          seen.push({ events: ports.events.types(), persisted: ports.persisted.length });
          return agentResult("s1", { summary: "", commits: [], output: { ok: true } });
        },
      ],
    });
    await visit(entryOf("build", "agent", { with: { task: "x" } }), undefined, { ...ports, sandbox });
    expect(seen).toEqual([{ events: ["span.open", "iteration.agent.start"], persisted: 1 }]);
  });

  it("does nothing when the session is already done or blocked at done", async () => {
    const ports = portsOf();
    const session = await runFlow(flowOf(entryOf("a", "void")), sessionOf("done"), ports);
    expect(session.current).toBe("done");
    expect(ports.persisted).toEqual([]);
    expect(ports.events.events).toEqual([]);
  });

  it("throws when the session points at an unknown step", async () => {
    await expect(runFlow(flowOf(entryOf("a", "void")), sessionOf("ghost"), portsOf())).rejects.toThrow('flow "test" has no step "ghost"');
  });
});

describe("runFlow: re-entry after blocked and resume after a crash", () => {
  /** Blocked in build after three iterations, the last answer recorded with `ok: false`. */
  const blockedAt = (output: unknown): Session => {
    let s = sessionOf("build");
    s = bumpIteration(bumpIteration(bumpIteration(s, "build"), "build"), "build");
    s = recordVisit(s, "build", { ok: false, log: "nope", output, commits: ["c3"], session: "s3" });
    return markBlocked(s);
  };

  it("re-enters at eval with the counter reset and the recorded result; a passing eval moves on without an agent call", async () => {
    const ports = portsOf();
    const build = entryOf("build", "agent", { with: { task: "x" }, routes: [{ to: "review", when: "res.ok && ctx.iteration === 0 && steps.build.visits === 1" }, { to: "blocked" }] });

    const { session, requests, next } = await visit(build, blockedAt({ ok: true, log: "fixed by hand" }), ports);

    expect(requests).toHaveLength(0);
    expect(next).toBe("review");
    expect(session.blocked).toBe(false);
    expect(session.scopes["1"]?.["build"]).toEqual({ visits: 1, ok: true, log: "fixed by hand", output: { ok: true, log: "fixed by hand" }, commits: ["c3"], session: "s3" });
    expect(session.iterations["build"]).toBe(0);
    const { spans } = foldTimeline(ports.events.events);
    expect(spans[0]?.iterations).toEqual([{ n: 0, eval: expect.objectContaining({ ok: true }) }]);
    expect(ports.events.of("output")).toEqual([]);
  });

  it("re-enters at eval and, when it still fails, starts a fresh session with the prompt rendered again, not the old session with the old log", async () => {
    const sandbox = fakeSandbox({ agent: [answer("s4")] });
    const ports = portsOf(sandbox, { issue: issue({ id: "1", title: "Edited since" }) });
    const { session, requests, next } = await visit(entryOf("build", "agent", { with: { task: "${{ ctx.issue.title }}" } }), blockedAt({ ok: false, log: "still broken" }), ports);

    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("resumeSession");
    expect(requests[0]?.prompt).toContain("Do Edited since in /tmp/worktree for #1.");
    expect(requests[0]?.prompt).not.toContain(failedEvalSection("still broken"));
    expect(next).toBe("done");
    expect(session.scopes["1"]?.["build"]).toMatchObject({ visits: 1, ok: true, session: "s4" });
    expect(session.iterations["build"]).toBe(1);
  });

  it("re-entry after blocked honours resume: as a first visit does, so a fix step still joins the implementer's session", async () => {
    const sandbox = fakeSandbox({ agent: [answer("f2")] });
    const fix = entryOf("build", "agent", { with: { task: "x" }, resume: "${{ steps.plan.session }}" });
    const stuck = recordVisit(blockedAt({ ok: false, log: "still broken" }), "plan", { ok: true, log: "", output: {}, commits: [], session: "p1" });

    const { requests, next } = await visit(fix, stuck, portsOf(sandbox));

    expect(requests).toEqual([expect.objectContaining({ resumeSession: "p1" })]);
    expect(requests[0]?.prompt).not.toBe(retryPrompt("still broken"));
    expect(next).toBe("done");
  });

  it("continues a crashed visit from its counter and session, eval first, then the agent", async () => {
    const sandbox = fakeSandbox({ agent: [answer("s3", false, "crash log")] });
    let crashed = bumpIteration(bumpIteration(sessionOf("build"), "build"), "build");
    crashed = updateVisit(recordVisit(crashed, "build", { ok: false, log: "", output: undefined, commits: [] }), "build", { session: "s2" });
    const ports = portsOf(sandbox);

    const { session, requests, next } = await visit(entryOf("build", "agent", { with: { task: "x" } }), crashed, ports);

    // No recorded output: the eval judges nothing and passes, so the agent is not needed.
    expect(requests).toEqual([]);
    expect(next).toBe("done");
    expect(session.scopes["1"]?.["build"]).toMatchObject({ visits: 1, session: "s2" });

    const failing = updateVisit(crashed, "build", { output: { ok: false, log: "earlier" } });
    const rerun = await visit(entryOf("build", "agent", { with: { task: "x" } }), failing, portsOf(fakeSandbox({ agent: [answer("s3")] })));
    expect(rerun.requests).toEqual([expect.objectContaining({ resumeSession: "s2", prompt: retryPrompt("earlier") })]);
    expect(rerun.session.iterations["build"]).toBe(3);
    expect(rerun.ports.events.of("iteration.agent.start")[0]?.n).toBe(3);
  });

  it("runs the agent again when a step without an eval re-enters with no recorded result", async () => {
    let crashed = bumpIteration(sessionOf("plain"), "plain");
    crashed = updateVisit(recordVisit(crashed, "plain", { ok: false, log: "", output: undefined, commits: [] }), "plain", { session: "s1" });
    const sandbox = fakeSandbox({ agent: [answer("s2")] });

    const { session, requests, next } = await visit(entryOf("plain", "agent-plain", { with: { task: "x" } }), crashed, portsOf(sandbox));

    expect(requests).toEqual([expect.objectContaining({ resumeSession: "s1" })]);
    expect(requests[0]?.prompt).not.toBe(retryPrompt(""));
    expect(next).toBe("done");
    expect(session.scopes["1"]?.["plain"]).toMatchObject({ visits: 1, ok: true, session: "s2" });

    const blocked = await visit(entryOf("plain", "agent-plain", { with: { task: "x" } }), markBlocked(crashed), portsOf(fakeSandbox({ agent: [answer("s3")] })));
    expect(blocked.requests).toHaveLength(1);
    expect(blocked.requests[0]).not.toHaveProperty("resumeSession");
    expect(blocked.next).toBe("done");
  });

  it("re-enters a step blocked on failed iterations by running the agent again, not by passing on the failure", async () => {
    const crash = new AgentProcessError("codex exited with code 1", { exitCode: 1 });
    const plain = entryOf("plain", "agent-plain", { with: { task: "x" }, maxIterations: 1 });

    const first = await visit(plain, undefined, portsOf(fakeSandbox({ agent: [crash] })));
    expect(first.next).toBe("blocked");
    expect(first.session.scopes["1"]?.["plain"]).toEqual({ visits: 1, ok: false, log: "codex exited with code 1", output: undefined, commits: [] });

    const second = await visit(plain, first.session, portsOf(fakeSandbox({ agent: [answer("s9")] })));
    expect(second.requests).toHaveLength(1);
    expect(second.next).toBe("done");
    expect(second.session.scopes["1"]?.["plain"]).toMatchObject({ visits: 1, ok: true, output: { ok: true }, commits: ["c-s9"], session: "s9" });
  });

  it("opens a second visit with the first visit's result cleared, keeping only its session", async () => {
    const build = entryOf("build", "agent", { with: { task: "x" }, routes: [{ to: "build", when: "steps.build.visits === 1" }, { to: "done" }] });
    const ports = portsOf(fakeSandbox({ agent: [answer("s1"), answer("s2")] }));

    await runFlow(flowOf(build), sessionOf("build"), ports);

    expect(ports.transitions.map((t) => t.to)).toEqual(["build", "done"]);
    const opened = ports.persisted.find((s) => s.scopes["1"]?.["build"]?.visits === 2);
    expect(opened?.scopes["1"]?.["build"]).toEqual({ visits: 2, ok: true, log: "", output: undefined, commits: [], session: "s1" });
  });

  it("a second visit stopped after its agent call re-enters on its own empty record, not on the first visit's output", async () => {
    // Visit 1 recorded a result; visit 2 opened and persisted its agent call (session s2) before the process died.
    let s = recordVisit(sessionOf("plain"), "plain", { ok: true, log: "", output: { outcome: "first" }, commits: ["c-s1"], session: "s1" });
    s = updateVisit(bumpIteration(openVisit(s, "plain"), "plain"), "plain", { session: "s2" });

    const rerun = await visit(entryOf("plain", "agent-plain", { with: { task: "x" } }), s, portsOf(fakeSandbox({ agent: [answer("s3")] })));

    expect(rerun.requests).toEqual([expect.objectContaining({ resumeSession: "s2" })]);
    expect(rerun.next).toBe("done");
    expect(rerun.session.scopes["1"]?.["plain"]).toMatchObject({ visits: 2, ok: true, output: { ok: true }, commits: ["c-s3"], session: "s3" });
  });

  it("passes a step without an eval on re-entry when its result was recorded, and routes on it", async () => {
    const stopped = markBlocked(recordVisit(bumpIteration(sessionOf("plain"), "plain"), "plain", { ok: true, log: "", output: { outcome: "stopped" }, commits: [], session: "s1" }));
    const plain = entryOf("plain", "agent-plain", { with: { task: "x" }, routes: [{ to: "blocked", when: "steps.plain.output.outcome === 'stopped'" }, { to: "done" }] });

    const { requests, next } = await visit(plain, stopped);

    expect(requests).toEqual([]);
    expect(next).toBe("blocked");
  });

  it("re-runs a deterministic step that was blocked through its routes", async () => {
    const stuck = markBlocked(recordVisit(sessionOf("next-work"), "next-work", { ok: true, log: "", output: {}, commits: [] }));
    const pick = entryOf("next-work", "echo", { routes: [{ to: "done" }] });
    const { session, next } = await visit(pick, stuck);
    expect(next).toBe("done");
    expect(session.scopes["1"]?.["next-work"]).toMatchObject({ visits: 1, ok: true });
    expect(session.blocked).toBe(false);
  });
});

describe("runFlow: prepare", () => {
  const prepared = (mode?: string, overrides: Parameters<typeof entryOf>[2] = {}) =>
    entryOf("sync", "prepared", { with: { task: "merge", ...(mode !== undefined ? { mode } : {}) }, ...overrides });

  it("runs prepare before the agent, fills {{prepared.*}} (a missing value empty), hands it to the eval and records it", async () => {
    const sandbox = fakeSandbox({ agent: [answer("s1")] });
    const ports = portsOf(sandbox);
    const entry = prepared(undefined, { routes: [{ to: "done", when: "prepared.agent === 'always' && steps.sync.prepared.output.note === 'always for #1'" }, { to: "blocked" }] });

    const { session, requests, next } = await visit(entry, undefined, ports);

    expect(next).toBe("done");
    expect(requests[0]?.prompt).toContain("Do merge (). Note: always for #1. Extra: []");
    expect(ports.events.types().slice(0, 4)).toEqual(["span.open", "prepare.start", "prepare.end", "iteration.agent.start"]);
    expect(ports.events.of("prepare.end")[0]).toEqual(expect.objectContaining({ spanId: "r1-1", agent: "always" }));
    expect(session.scopes["1"]?.["sync"]).toMatchObject({ ok: true, log: "agent=always note=always for #1 result=some iteration=1", prepared: { agent: "always", output: { note: "always for #1" } } });
    // Persisted with the prepare result before the agent is called.
    expect(ports.persisted[1]?.scopes["1"]?.["sync"]).toMatchObject({ prepared: { agent: "always" } });
    expect(ports.persisted[1]?.iterations["sync"]).toBe(0);
  });

  it("never: the eval runs once with no result and the visit routes on it, whatever it says", async () => {
    const ports = portsOf();
    const entry = prepared("never", { routes: [{ to: "next", when: "res.ok && prepared.reason === 'nothing to do' && ctx.iteration === 1" }, { to: "blocked" }] });

    const { session, requests, next } = await visit(entry, undefined, ports);

    expect(requests).toEqual([]);
    expect(next).toBe("next");
    expect(ports.events.types().slice(0, 6)).toEqual(["span.open", "prepare.start", "prepare.end", "iteration.eval.start", "iteration.eval.end", "span.close"]);
    expect(ports.events.of("prepare.end")[0]).toEqual(expect.objectContaining({ agent: "never", reason: "nothing to do" }));
    expect(ports.events.of("output")).toEqual([]);
    expect(session.scopes["1"]?.["sync"]).toEqual({ visits: 1, ok: true, log: "agent=never note=never for #1 result=none iteration=1", commits: [], prepared: { agent: "never", reason: "nothing to do", output: { note: "never for #1" } } });
    expect(session.iterations["sync"]).toBe(0);
    const { spans } = foldTimeline(ports.events.events);
    expect(spans[0]?.prepare).toEqual({ startedAt: expect.any(String), endedAt: expect.any(String), agent: "never", reason: "nothing to do" });
  });

  it("on-fail: a green eval settles the visit as iteration 0 without an agent call", async () => {
    const ports = portsOf();
    const entry = prepared("on-fail", { routes: [{ to: "next", when: "res.ok && prepared.reason === 'checking first' && ctx.iteration === 0" }, { to: "blocked" }] });

    const { session, requests, next } = await visit(entry, undefined, ports);

    expect(requests).toEqual([]);
    expect(next).toBe("next");
    expect(ports.events.types().slice(0, 6)).toEqual(["span.open", "prepare.start", "prepare.end", "iteration.eval.start", "iteration.eval.end", "span.close"]);
    expect(ports.events.of("prepare.end")[0]).toEqual(expect.objectContaining({ agent: "on-fail", reason: "checking first" }));
    expect(ports.events.of("iteration.eval.end")[0]).toEqual(expect.objectContaining({ n: 0, ok: true }));
    expect(session.scopes["1"]?.["sync"]).toEqual({ visits: 1, ok: true, log: "agent=on-fail note=on-fail for #1 result=none iteration=0", commits: [], prepared: { agent: "on-fail", reason: "checking first", output: { note: "on-fail for #1" } } });
    expect(session.iterations["sync"]).toBe(0);
  });

  it("on-fail: a red eval starts the agent fresh with the eval log appended to the prompt, then the loop judges its work", async () => {
    const sandbox = fakeSandbox({ agent: [answer("s1")] });
    const ports = portsOf(sandbox);
    const entry = prepared("on-fail", { with: { task: "merge", mode: "on-fail", fail: "${{ true }}" } });

    const { session, requests, next } = await visit(entry, undefined, ports);

    expect(next).toBe("done");
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("resumeSession");
    expect(requests[0]?.prompt).toContain("Do merge (on-fail). Note: on-fail for #1. Extra: []");
    expect(requests[0]?.prompt).toContain(failedEvalSection("agent=on-fail note=on-fail for #1 result=none iteration=0"));
    expect(requests[0]?.prompt.indexOf("## The evaluation already ran")).toBeLessThan(requests[0]?.prompt.indexOf("## Output contract") ?? -1);
    expect(ports.events.types().slice(0, 6)).toEqual(["span.open", "prepare.start", "prepare.end", "iteration.eval.start", "iteration.eval.end", "iteration.agent.start"]);
    expect(ports.events.of("iteration.eval.end").map((e) => [e.n, e.ok])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(session.scopes["1"]?.["sync"]).toMatchObject({ visits: 1, ok: true, log: "agent=on-fail note=on-fail for #1 result=some iteration=1", session: "s1", prepared: { agent: "on-fail" } });
    expect(session.iterations["sync"]).toBe(1);
  });

  it("on-fail: the agent's retries stay in its session with the retry prompt, and the cap counts the agent calls only", async () => {
    const sandbox = fakeSandbox({ agent: [answer("s1", false, "still red"), answer("s2")] });
    const entry = prepared("on-fail", { with: { task: "merge", mode: "on-fail", fail: "${{ true }}" }, maxIterations: 2 });

    const { requests, next } = await visit(entry, undefined, portsOf(sandbox));

    expect(next).toBe("done");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ resumeSession: "s1", prompt: retryPrompt("agent=on-fail note=on-fail for #1 result=some iteration=1") });
  });

  it("a crashed visit without a session to resume gets the failed eval's log appended to the original prompt", async () => {
    let stuck = bumpIteration(sessionOf("sync"), "sync");
    stuck = recordVisit(stuck, "sync", { ok: false, log: "red", output: { ok: false }, commits: [], prepared: { agent: "always", output: { note: "from before" } } });
    const sandbox = fakeSandbox({ agent: [answer("s2")] });

    const { requests, next } = await visit(prepared(), stuck, portsOf(sandbox));

    expect(next).toBe("done");
    expect(requests[0]).not.toHaveProperty("resumeSession");
    expect(requests[0]?.prompt).toContain("Do merge (). Note: from before. Extra: []");
    expect(requests[0]?.prompt).toContain(failedEvalSection("agent=always note=from before result=some iteration=0"));
  });

  it("records prepare's module writes after the call: the prompt and the session see the new work item, the record stays in the visit's scope", async () => {
    const sandbox = fakeSandbox({ agent: [answer("s1")] });
    const { session, requests } = await visit(prepared("work"), undefined, portsOf(sandbox));

    expect(requests[0]?.prompt).toContain("Note: always for #14.");
    expect(session.work).toBe("14");
    expect(session.scopes["1"]?.["sync"]).toMatchObject({ visits: 1, session: "s1", prepared: { output: { note: "always for #14" } } });
  });

  it("crashes when prepare's output does not match prepare.output", async () => {
    const ports = portsOf();
    await expect(visit(prepared("bad"), undefined, ports)).rejects.toThrow("sync: prepare output does not match prepare.output: /note must be string");
    expect(ports.events.types()).toEqual(["span.open", "prepare.start"]);
  });

  it("prepares again on re-entry after blocked, evals the recorded result first, then starts the agent fresh without the old log", async () => {
    let stuck = bumpIteration(sessionOf("sync"), "sync");
    stuck = recordVisit(stuck, "sync", { ok: false, log: "red", output: { ok: false }, commits: [], session: "s1", prepared: { agent: "always", output: { note: "from before" } } });
    const sandbox = fakeSandbox({ agent: [answer("s2")] });
    const ports = portsOf(sandbox);

    const { session, requests, next } = await visit(prepared(), markBlocked(stuck), ports);

    expect(ports.events.of("prepare.start")).toHaveLength(1);
    expect(ports.events.types().slice(0, 5)).toEqual(["span.open", "prepare.start", "prepare.end", "iteration.eval.start", "iteration.eval.end"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("resumeSession");
    expect(requests[0]?.prompt).toContain("Do merge (). Note: always for #1. Extra: []");
    expect(requests[0]?.prompt).not.toContain("## The evaluation already ran");
    expect(next).toBe("done");
    expect(session.scopes["1"]?.["sync"]).toMatchObject({ visits: 1, session: "s2", prepared: { output: { note: "always for #1" } } });
  });

  it("continues a visit that crashed after prepare: no second visit count, no second prepare, the agent gets the original prompt", async () => {
    const crashed = updateVisit(recordVisit(sessionOf("sync"), "sync", { ok: true, log: "", output: undefined, commits: [] }), "sync", { prepared: { agent: "always", output: { note: "recorded" } } });
    const sandbox = fakeSandbox({ agent: [answer("s1")] });
    const ports = portsOf(sandbox);

    const { session, requests } = await visit(prepared(), crashed, ports);

    expect(ports.events.of("prepare.start")).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toContain("Note: recorded.");
    expect(requests[0]).not.toHaveProperty("resumeSession");
    expect(session.scopes["1"]?.["sync"]).toMatchObject({ visits: 1 });
  });

  it("prepares again on the next visit of the step: the transition into it forgets the old result", async () => {
    const sync = prepared("never", { routes: [{ to: "again", when: "steps.sync.visits < 2" }, { to: "done" }] });
    const again = entryOf("again", "echo", { with: { a: "${{ steps.sync.prepared.output.note }}" }, routes: [{ to: "sync" }] });
    const ports = portsOf();

    const session = await runFlow(flowOf(sync, again), sessionOf("sync"), ports);

    expect(ports.events.of("prepare.start")).toHaveLength(2);
    expect(session.scopes["1"]?.["again"]?.output).toMatchObject({ inputs: { a: "never for #1" } });
    expect(session.scopes["1"]?.["sync"]).toMatchObject({ visits: 2, prepared: { agent: "never" } });
  });
});
