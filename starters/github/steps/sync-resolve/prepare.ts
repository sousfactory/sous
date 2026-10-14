/**
 * Merges the base branch and puts the issue back on the bench, like `sync`,
 * and says when the agent is needed: `always` on a conflict, `on-fail` after
 * a merge that moved HEAD (the eval runs the checks first and the agent
 * repairs only what they find), `never` when nothing came in.
 * A merge already in progress means a crash inside prepare; it is treated
 * as a conflict because merging again would fail.
 */
import { SousError, type PrepareFn } from "sous-factory";
import { requireString } from "../_shared.js";

export type SyncPrepared = { conflict: boolean; moved: boolean };

export default (async (ctx, inputs) => {
  const baseBranch = requireString(inputs, "baseBranch", "sync-resolve");
  const { id, ref, title, body } = ctx.issue;
  if (await ctx.git.mergeInProgress(ctx.worktree)) {
    ctx.work = { id, ref, title, body };
    return { agent: "always", output: { conflict: true, moved: false } };
  }
  const before = await ctx.git.headSha(ctx.worktree);
  const result = await ctx.git.mergeInto(ctx.worktree, baseBranch);
  if (!result.ok && !result.conflicted) throw new SousError(`sync-resolve: merging ${baseBranch} into ${ctx.branch} failed:\n${result.log}`);
  ctx.work = { id, ref, title, body };
  if (result.conflicted) return { agent: "always", output: { conflict: true, moved: false } };
  if ((await ctx.git.headSha(ctx.worktree)) === before) {
    return { agent: "never", reason: `${ctx.branch} is already up to date with ${baseBranch}`, output: { conflict: false, moved: false } };
  }
  return { agent: "on-fail", reason: `merged ${baseBranch} cleanly`, output: { conflict: false, moved: true } };
}) satisfies PrepareFn<SyncPrepared>;
