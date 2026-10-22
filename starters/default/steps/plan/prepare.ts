/**
 * Decides whether a spec has to be derived: a `spec.md` already in the
 * worktree, committed on the branch by `/sous-plan` or by this step on an
 * earlier run, means the agent does not run and the eval only confirms the
 * file. One file check per run of a planned issue, never a tracker call.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, Inputs, PrepareFn } from "sous-factory";

export type PlanPrepared = { exists: boolean };

/** Where the run reads `ctx.spec` from: the spec folder in the worktree. */
export const specFile = (ctx: Pick<Ctx, "worktree" | "specDir">): string => join(ctx.worktree, ctx.specDir, "spec.md");

export default (async (ctx: Ctx, _inputs: Inputs = {}) => {
  if (existsSync(specFile(ctx))) return { agent: "never", reason: `${ctx.specDir}/spec.md is on the branch`, output: { exists: true } };
  return { agent: "always", output: { exists: false } };
}) satisfies PrepareFn<PlanPrepared>;
