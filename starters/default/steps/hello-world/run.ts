/** Smallest deterministic step, for the bench flow: its `output` feeds the next step through `steps.*`. */
import type { RunFn } from "sous-factory";

export const greet = (name: string): string => `Hello, ${name}!`;

export default (async (ctx, inputs) => {
  const raw = inputs["name"];
  const name = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "world";
  const greeting = greet(name);
  return { summary: `hello-world: ${greeting} (work ${ctx.work.ref} in ${ctx.worktree})`, commits: [], output: { greeting, name, work: ctx.work.id } };
}) satisfies RunFn;
