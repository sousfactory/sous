/** A visit whose prepare skipped the agent already passed; otherwise the merge must be concluded and verify must pass. */
import type { EvalFn } from "sous-factory";
import verify from "../verify/eval.js";

export default (async (ctx, inputs, result, prepared) => {
  if (prepared?.agent === "skip") return { ok: true, log: `sync-resolve: ${prepared.reason ?? "nothing to repair"}` };
  if (await ctx.git.mergeInProgress(ctx.worktree)) {
    return { ok: false, log: "sync-resolve: the merge is still in progress; resolve every conflict and commit the merge" };
  }
  return verify(ctx, inputs, result, prepared);
}) satisfies EvalFn;
