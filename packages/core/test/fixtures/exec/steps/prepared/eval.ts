import type { EvalFn } from "../../../../../src/index.js";

/**
 * Ok unless the envelope says `ok: false`, or `fail` is set and no result
 * has arrived yet (an eval that is red until an agent has worked); the log
 * shows what the eval saw.
 */
export default (async (ctx, inputs, result, prepared) => {
  const output = (result?.output ?? {}) as { ok?: boolean };
  const note = (prepared?.output as { note?: string } | undefined)?.note;
  const redWithoutResult = inputs["fail"] === true && result === undefined;
  return {
    ok: output.ok !== false && !redWithoutResult,
    log: `agent=${String(prepared?.agent)} note=${String(note)} result=${result === undefined ? "none" : "some"} iteration=${String(ctx.iteration)}`,
  };
}) satisfies EvalFn;
