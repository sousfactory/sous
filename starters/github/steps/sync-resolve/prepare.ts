/**
 * Merges the base branch and puts the issue back on the bench, like `sync`,
 * but runs the agent only when there is something to repair: conflicts, or
 * failing checks after a clean merge (passed on as `checkLog`).
 * A merge already in progress means a crash inside prepare; it is treated
 * as a conflict because merging again would fail.
 */
import { SousError, type PrepareFn } from "sous-factory";
import { requireString } from "../_shared.js";
import verify from "../verify/eval.js";

export type SyncPrepared = { conflict: boolean; moved: boolean; checkLog?: string };

export default (async (ctx, inputs) => {
  const baseBranch = requireString(inputs, "baseBranch", "sync-resolve");
  const { id, ref, title, body } = ctx.issue;
  if (await ctx.git.mergeInProgress(ctx.worktree)) {
    ctx.work = { id, ref, title, body };
    return { agent: "run", output: { conflict: true, moved: false } };
  }
  const before = await ctx.git.headSha(ctx.worktree);
  const result = await ctx.git.mergeInto(ctx.worktree, baseBranch);
  if (!result.ok && !result.conflicted) throw new SousError(`sync-resolve: merging ${baseBranch} into ${ctx.branch} failed:\n${result.log}`);
  ctx.work = { id, ref, title, body };
  if (result.conflicted) return { agent: "run", output: { conflict: true, moved: false } };
  if ((await ctx.git.headSha(ctx.worktree)) === before) {
    return { agent: "skip", reason: `${ctx.branch} is already up to date with ${baseBranch}`, output: { conflict: false, moved: false } };
  }
  const checks = await verify(ctx, inputs);
  return checks.ok
    ? { agent: "skip", reason: `merged ${baseBranch} cleanly; the checks pass`, output: { conflict: false, moved: true } }
    : { agent: "run", output: { conflict: false, moved: true, checkLog: checks.log } };
}) satisfies PrepareFn<SyncPrepared>;
