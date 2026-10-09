import type { EvalFn } from "../../../../../src/index.js";

/** The eval of an eval-only step: `result` is always undefined, `ctx.iteration` is 1. */
export default (async (ctx, inputs, result) => ({
  ok: inputs["pass"] !== "no",
  log: `pass=${String(inputs["pass"])} iteration=${String(ctx.iteration)} result=${result === undefined ? "none" : "some"}`,
})) satisfies EvalFn;
