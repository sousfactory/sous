/**
 * A `Ctx` over the in-memory fakes for step tests: the real `buildCtx` with
 * a fake git, tracker, sandbox and event log, and a `workDone` hook that
 * records its calls.
 */
import { buildCtx, type CtxDeps } from "../../src/exec/ctx.js";
import type { Ctx, Work, WorkRecord } from "../../src/index.js";
import type { Issue } from "../../src/ports/tracker.js";
import type { Event } from "../../src/session/events.js";
import { fakeEventLog, type FakeEventLog } from "./eventlog.js";
import { fakeGit, type FakeGit } from "./git.js";
import { fakeTracker, issue as issueOf, type FakeTracker } from "./tracker.js";
import { fakeSandbox, type FakeSandbox } from "./sandbox.js";

export type FakeCtxOptions = {
  /** The run target; added to the fake tracker when missing. */
  issue?: Partial<Issue> & { id: string };
  /** The work on the bench; the run target itself by default. */
  work?: Work;
  specDir?: string;
  workProgress?: Record<string, WorkRecord>;
  git?: FakeGit;
  tracker?: FakeTracker;
  sandbox?: FakeSandbox;
  events?: Event[];
  branch?: string;
  repoRoot?: string;
  worktree?: string;
};

export type FakeCtx = {
  ctx: Ctx;
  git: FakeGit;
  tracker: FakeTracker;
  sandbox: FakeSandbox;
  events: FakeEventLog;
  /** Every `ctx.workDone` call, in order. */
  done: { work: string; commits: string[] }[];
};

export const BRANCH = "feature/1-test-issue";
export const REPO = "/repo";

export const ctxOf = (options: FakeCtxOptions = {}): FakeCtx => {
  const target = issueOf({ id: "1", title: "Test issue", ...options.issue });
  const tracker = options.tracker ?? fakeTracker();
  if (!tracker.issues.has(target.id)) tracker.issues.set(target.id, target);
  const branch = options.branch ?? BRANCH;
  const sandbox = options.sandbox ?? fakeSandbox({ worktreePath: options.worktree ?? "/tmp/worktree", branch });
  const git = options.git ?? fakeGit({ existing: ["main", branch], branches: { [sandbox.worktreePath]: branch } });
  const events = fakeEventLog(options.events ?? []);
  const deps: CtxDeps = {
    issue: { id: target.id, ref: target.ref, title: target.title, body: target.body, labels: target.labels },
    flow: "feature",
    branch,
    repoRoot: options.repoRoot ?? REPO,
    skillsDir: "/repo/.sous/skills",
    sandbox,
    git,
    tracker,
    events,
  };
  const done: FakeCtx["done"] = [];
  const ctx = buildCtx(
    deps,
    {
      work: options.work ?? { id: target.id, ref: target.ref, title: target.title, body: target.body },
      specDir: options.specDir ?? "specs/1-test-issue",
      workProgress: options.workProgress ?? {},
      previous: null,
    },
    { workDone: (work, commits) => done.push({ work, commits: [...commits] }) },
  );
  return { ctx, git, tracker, sandbox, events, done };
};
