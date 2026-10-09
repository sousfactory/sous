import type { RunFn, Work } from "../../../../../src/index.js";

export default (async (ctx, inputs) => {
  const next = inputs["work"] as Work | undefined;
  ctx.work = next ?? { id: ctx.issue.id, ref: ctx.issue.ref, title: ctx.issue.title, body: ctx.issue.body };
  return { summary: "scope", commits: [], output: { work: ctx.work } };
}) satisfies RunFn;
