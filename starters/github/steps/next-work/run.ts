/**
 * Picks the next open child of the issue with no open blockers and makes it
 * `ctx.work`. Which children exist, in what order, and what blocks them is
 * the tracker's knowledge, so the step only asks. With nothing to pick the
 * work is left as is; `sync` returns it to the issue. A child with children
 * of its own is refused: one level of work items is what the flows handle.
 */
import { SousError, type RunFn, type Work } from "sous-factory";

export type OpenChild = { id: string; blockedBy: string[] };

export type WorkChoice = {
  work?: string;
  /** Open children that were skipped, with the blockers still open. */
  waiting: { id: string; on: string[] }[];
};

/** Pure choice: the first of `open`, in the order given, whose blockers are all gone. */
export const chooseWork = (open: readonly OpenChild[]): WorkChoice => {
  const waiting: WorkChoice["waiting"] = [];
  for (const { id, blockedBy } of open) {
    if (blockedBy.length === 0) return { work: id, waiting };
    waiting.push({ id, on: blockedBy });
  }
  return { waiting };
};

export default (async (ctx) => {
  const ids = await ctx.tracker.children(ctx.issue.id);
  const issues = await Promise.all(ids.map((id) => ctx.tracker.getIssue(id)));
  const open: OpenChild[] = [];
  for (const i of issues.filter((i) => i.state === "open")) {
    if ((await ctx.tracker.children(i.id)).length > 0) throw new SousError(`next-work: ${i.ref} has children of its own; nested work items are not supported`);
    open.push({ id: i.id, blockedBy: await ctx.tracker.blockers(i.id) });
  }

  const { work, waiting } = chooseWork(open);
  const picked = issues.find((i) => i.id === work);
  const next: Work | null = picked === undefined ? null : { id: picked.id, ref: picked.ref, title: picked.title, body: picked.body };
  if (next !== null) ctx.work = next;

  const summary =
    next !== null
      ? `next work: ${next.ref} ${next.title}`
      : open.length === 0
        ? "no open sub-issues left"
        : `all ${open.length} open sub-issues are blocked:\n${waiting.map((w) => `- ${w.id} blocked by ${w.on.join(", ")}`).join("\n")}`;
  return { summary, commits: [], output: { work: next, remaining: open.length } };
}) satisfies RunFn;
