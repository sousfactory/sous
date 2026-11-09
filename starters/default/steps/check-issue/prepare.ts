/**
 * Skips the check on an issue that is already closed. A run blocked on
 * `fixed` or `false-premise` leaves closing to the human; when the run is
 * started again, the closed issue (a feature's child, or the task itself)
 * needs no agent, and the feature flow routes on `closed` to the next child.
 * `ctx.work` is a snapshot without a state, so this is one tracker read per
 * visit, deliberately.
 */
import type { Ctx, Inputs, PrepareFn } from "sous-factory";

export type CheckIssuePrepared = { verdict: "open" | "closed" };

export default (async (ctx: Ctx, _inputs: Inputs = {}) => {
  const issue = await ctx.tracker.getIssue(ctx.work.id);
  if (issue.state === "closed") return { agent: "never", reason: `${ctx.work.ref} is closed`, output: { verdict: "closed" } };
  return { agent: "always", output: { verdict: "open" } };
}) satisfies PrepareFn<CheckIssuePrepared>;
