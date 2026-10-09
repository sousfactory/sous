import type { RunFn } from "../../../../../src/index.js";

export default (async () => {
  throw new Error("module exploded");
}) satisfies RunFn;
