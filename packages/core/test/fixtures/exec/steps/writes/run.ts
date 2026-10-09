import type { RunFn } from "../../../../../src/index.js";

export default (async (ctx, inputs) => {
  const seen = { specDir: ctx.specDir, workProgress: ctx.workProgress };
  if (typeof inputs["specDir"] === "string") ctx.specDir = inputs["specDir"];
  if (Array.isArray(inputs["done"])) ctx.workDone(inputs["done"] as string[]);
  return { summary: "writes", commits: [], output: seen };
}) satisfies RunFn;
