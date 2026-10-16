/** Checks what the output schema cannot: the punchline differs from the setup and both fit the length the prompt asked for. */
import type { Envelope, EvalFn } from "sous-factory";

export type Joke = { setup: string; punchline: string };

export const MAX_LINE = 140;

/** The problems with `joke`, empty when it passes. */
export const problems = ({ setup, punchline }: Joke): string[] => [
  ...(setup.trim().toLowerCase() === punchline.trim().toLowerCase() ? ["the punchline repeats the setup"] : []),
  ...(setup.length > MAX_LINE ? [`the setup is ${setup.length} characters, more than ${MAX_LINE}`] : []),
  ...(punchline.length > MAX_LINE ? [`the punchline is ${punchline.length} characters, more than ${MAX_LINE}`] : []),
];

const evaluate: EvalFn = async (_ctx, _inputs, result) => {
  if (result === undefined) return { ok: false, log: "no joke was told" };
  const found = problems((result as Envelope<Joke>).output);
  return found.length === 0 ? { ok: true, log: "a joke with a setup and a punchline" } : { ok: false, log: found.map((p) => `- ${p}`).join("\n") };
};

export default evaluate;
