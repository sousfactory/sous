import type { EvalFn } from "../../../../../src/index.js";

/** Ok unless `pass` is "no"; the log shows what the eval saw. */
export default (async (ctx, inputs, result) => ({
  ok: inputs["pass"] !== "no",
  log: `pass=${String(inputs["pass"])} iteration=${String(ctx.iteration)} result=${result === undefined ? "none" : "some"}`,
})) satisfies EvalFn;
