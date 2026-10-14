/**
 * The merge is concluded and the verify checks pass. Nothing to check when
 * the merge brought nothing in (prepare said `never`): the branch was
 * verified by the step before. Otherwise the checks run, before the agent
 * on `on-fail` and after it on every iteration.
 */
import type { EvalFn } from "sous-factory";
import verify from "../verify/eval.js";
import type { SyncPrepared } from "./prepare.js";

export default (async (ctx, inputs, result, prepared) => {
  const merged = prepared?.output as SyncPrepared | undefined;
  if (merged !== undefined && !merged.conflict && !merged.moved) return { ok: true, log: `sync-resolve: ${prepared?.reason ?? "nothing came in"}; nothing to check` };
  if (await ctx.git.mergeInProgress(ctx.worktree)) {
    return { ok: false, log: "sync-resolve: the merge is still in progress; resolve every conflict and commit the merge" };
  }
  return verify(ctx, inputs, result, prepared);
}) satisfies EvalFn;
