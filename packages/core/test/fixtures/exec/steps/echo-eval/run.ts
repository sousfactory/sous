import type { RunFn } from "../../../../../src/index.js";

export default (async (_ctx, inputs) => ({ summary: "echo", commits: ["e1"], output: { inputs } })) satisfies RunFn;
