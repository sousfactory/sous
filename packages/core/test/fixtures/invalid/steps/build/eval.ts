import type { EvalFn } from "../../../../../src/index.js";

export default (async (_ctx, _inputs, result) => ({
  ok: result !== undefined && result.output !== null,
  log: "",
})) satisfies EvalFn;
