import type { PrepareFn } from "../../../../../src/index.js";

export default (async (ctx, inputs) => {
  const mode = typeof inputs["mode"] === "string" ? inputs["mode"] : "always";
  if (mode === "bad") return { agent: "always", output: { note: 7 } };
  if (mode === "work") ctx.work = { id: "14", ref: "#14", title: "Work 14", body: "do 14" };
  if (mode === "never") return { agent: "never", reason: "nothing to do", output: { note: `never for ${ctx.work.ref}` } };
  if (mode === "on-fail") return { agent: "on-fail", reason: "checking first", output: { note: `on-fail for ${ctx.work.ref}` } };
  return { agent: "always", output: { note: `always for ${ctx.work.ref}` } };
}) satisfies PrepareFn;
