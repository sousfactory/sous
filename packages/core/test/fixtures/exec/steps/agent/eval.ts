import type { EvalFn } from "../../../../../src/index.js";

/** Ok unless the envelope says `ok: false`; the log is the envelope's or names the iteration. */
export default (async (ctx, _inputs, result) => {
  const output = (result?.output ?? {}) as { ok?: boolean; log?: string };
  return { ok: output.ok !== false, log: output.log ?? `eval of iteration ${String(ctx.iteration)}` };
}) satisfies EvalFn;
