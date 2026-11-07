import type { EvalFn } from "../../../../../src/index.js";

/** Ok when the command's JSON says count 0; the log shows the envelope it got. */
export default (async (_ctx, _inputs, result) => ({
  ok: (result?.output as { json?: { count?: number } } | undefined)?.json?.count === 0,
  log: JSON.stringify(result ?? null),
})) satisfies EvalFn;
