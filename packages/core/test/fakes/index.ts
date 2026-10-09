/**
 * `sous-factory/testing`: the in-memory fakes and the executor harness for a
 * project's own tests. A project walks its flows through
 * the real executor over these; no agent runs and nothing touches git or
 * the tracker. Test-only: the package exports this entry beside `.`, and nothing
 * in `src/` imports it.
 */
import { specDir } from "../../src/session/paths.js";
import { runFlow } from "../../src/exec/executor.js";
import type { Flow } from "../../src/config/flow.js";
import type { Session } from "../../src/exec/scope.js";
import { createSession } from "../../src/session/update.js";
import type { FakePorts } from "./executor.js";

export type { Session } from "../../src/exec/scope.js";
export { BRANCH, ctxOf, REPO, type FakeCtx, type FakeCtxOptions } from "./ctx.js";
export { fakeEventLog, type FakeEventLog } from "./eventlog.js";
export { fakeClock, portsOf, silentLog, type FakePortOverrides, type FakePorts, type Transition } from "./executor.js";
export { fakeGit, type FakeGit, type FakeGitState } from "./git.js";
export { fakeTracker, issue, type FakeTracker, type FakeTrackerOptions } from "./tracker.js";
export { agentResult, envelope, fail, fakeSandbox, ok, type AgentScript, type FakeSandbox, type FakeSandboxOptions } from "./sandbox.js";

export type WalkOptions = {
  /** A session to continue instead of a fresh one at the flow's entry. */
  session?: Session;
  /** The `specsDir` setting the fresh session's `specDir` is derived from. */
  specsDir?: string;
};

/**
 * Runs `flow` through the real executor over `ports`, from its entry
 * with a fresh session for `ports.issue` on the sandbox's branch, or from
 * `session`. Returns the final session: `history` is the step sequence.
 */
export const walk = (flow: Flow, ports: FakePorts, { session, specsDir = "specs" }: WalkOptions = {}): Promise<Session> => {
  const { issue } = ports;
  const fresh = createSession({
    flow: flow.name,
    issue: issue.id,
    title: issue.title,
    branch: ports.sandbox.branch,
    specDir: specDir(specsDir, issue.id, issue.title),
    entry: flow.entry,
  });
  return runFlow(flow, session ?? fresh, ports);
};
