import type { EvalFn } from "../../../../../src/index.js";

/** Ok unless the envelope says `ok: false`; the log shows what the eval saw. */
export default (async (ctx, _inputs, result, prepared) => {
  const output = (result?.output ?? {}) as { ok?: boolean };
  const note = (prepared?.output as { note?: string } | undefined)?.note;
  return {
    ok: output.ok !== false,
    log: `agent=${String(prepared?.agent)} note=${String(note)} result=${result === undefined ? "none" : "some"} iteration=${String(ctx.iteration)}`,
  };
}) satisfies EvalFn;
