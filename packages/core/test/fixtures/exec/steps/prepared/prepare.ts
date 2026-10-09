import type { PrepareFn } from "../../../../../src/index.js";

export default (async (ctx, inputs) => {
  const mode = typeof inputs["mode"] === "string" ? inputs["mode"] : "run";
  if (mode === "bad") return { agent: "run", output: { note: 7 } };
  if (mode === "work") ctx.work = { id: "14", ref: "#14", title: "Work 14", body: "do 14" };
  return mode === "skip"
    ? { agent: "skip", reason: "nothing to do", output: { note: `skip for ${ctx.work.ref}` } }
    : { agent: "run", output: { note: `run for ${ctx.work.ref}` } };
}) satisfies PrepareFn;
