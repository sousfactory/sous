import type { RunFn } from "../../../../../src/index.js";

export default (async (_ctx, inputs) => ({ summary: "squashed", commits: [], output: { commits: inputs["commits"] } })) satisfies RunFn;
