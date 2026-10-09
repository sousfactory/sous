import type { RunFn } from "../../../../../src/index.js";

export default (async () => ({ summary: "merged", commits: [], output: { conflict: false } })) satisfies RunFn;
