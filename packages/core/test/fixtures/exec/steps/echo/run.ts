import type { RunFn } from "../../../../../src/index.js";

export default (async (ctx, inputs) => ({
  summary: "echo",
  commits: [],
  output: { inputs, work: ctx.work, previous: ctx.previous, iteration: ctx.iteration ?? null },
})) satisfies RunFn;
