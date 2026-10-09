/**
 * Lands one sub-issue: comments its commits, closes it, marks the work done.
 * Idempotent so a rerun after a crash posts no second comment. The parent
 * issue is left for `merge` to close.
 */
import { SousError, type RunFn } from "sous-factory";

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

/** `commits` as wired: an array of shas, or the same as a JSON string (a `with:` value that is not one whole `${{ }}` is text). */
export const commitsInput = (value: unknown): string[] => {
  if (isStrings(value)) return [...new Set(value)];
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new SousError(`close-work: input "commits" is not a JSON array: ${value}`);
    }
    if (isStrings(parsed)) return [...new Set(parsed)];
  }
  throw new SousError(`close-work: input "commits" must be an array of shas or a JSON array string`);
};

export const closeWorkComment = (parent: string, branch: string, commits: readonly string[]): string =>
  [`Landed on \`${branch}\` for ${parent}.`, "", ...(commits.length > 0 ? commits.map((c) => `- ${c}`) : ["_No commits reported._"])].join("\n");

export default (async (ctx, inputs) => {
  const work = ctx.work;
  if (work.id === ctx.issue.id) throw new SousError(`close-work: ${work.ref} is the issue itself, not a sub-issue; merge closes it`);
  const commits = commitsInput(inputs["commits"]);

  const closed = await ctx.tracker.isClosed(work.id);
  if (!closed) {
    await ctx.tracker.comment(work.id, closeWorkComment(ctx.issue.ref, ctx.branch, commits));
    await ctx.tracker.close(work.id);
  }
  if (ctx.workProgress[work.id]?.state !== "done") ctx.workDone(commits);

  return {
    summary: closed ? `close-work: ${work.ref} was already closed` : `close-work: closed ${work.ref} with ${commits.length} commit${commits.length === 1 ? "" : "s"}`,
    commits: [],
    output: { work },
  };
}) satisfies RunFn;
