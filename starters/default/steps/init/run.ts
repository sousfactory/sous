/**
 * Guards the run target: the issue is open and the worktree is on the
 * session's branch. Whether the issue is somebody's child does not matter:
 * its label put it in this flow. The spec is not this step's business:
 * `sous run` reads it from the checkout at every start into `ctx.spec`,
 * from the plan session's file or from the issue itself. Claiming the issue
 * is the run's lifecycle.
 */
import { SousError, type RunFn } from "sous-factory";

export default (async (ctx) => {
  const issue = await ctx.tracker.getIssue(ctx.issue.id);
  if (issue.state !== "open") throw new SousError(`init: ${issue.ref} is ${issue.state}; sous runs open issues only`);
  const checkedOut = await ctx.git.currentBranch(ctx.worktree);
  if (checkedOut !== ctx.branch) throw new SousError(`init: the worktree is on ${checkedOut}, the session expects ${ctx.branch}`);
  return { summary: `init: ${issue.ref} is open, the worktree is on ${ctx.branch}`, commits: [], output: {} };
}) satisfies RunFn;
