/**
 * Pure glue between an `AgentRequest` and an agent process, kept free of
 * I/O so it is testable without an agent: provider selection, envelope
 * extraction and validation. Prompt and retry texts belong to the executor.
 */
import type { Agent } from "../config/flow.js";
import { validator } from "../config/schema.js";
import type { Envelope } from "../index.js";
import { skillsSchema } from "../skills.js";
import { claude } from "./agents/claude.js";
import { codex } from "./agents/codex.js";
import type { Provider } from "./agents/provider.js";

export const RESULT_TAG = "result";

export const selectAgent = ({ kind }: Agent): Provider => (kind === "claude" ? claude : codex);

export type ParsedEnvelope = { ok: true; envelope: Envelope } | { ok: false; reason: string; rawMatched: string | undefined };

/** Contents of the last `<tag>…</tag>` pair in `text`, or undefined. */
export const lastTagContent = (text: string, tag: string = RESULT_TAG): string | undefined => {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let last: string | undefined;
  let from = 0;
  for (;;) {
    const openAt = text.indexOf(open, from);
    if (openAt === -1) break;
    const start = openAt + open.length;
    const closeAt = text.indexOf(close, start);
    if (closeAt === -1) break;
    last = text.slice(start, closeAt);
    from = closeAt + close.length;
  }
  return last;
};

export const unwrapFences = (text: string): string => text.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/)?.[1]?.trim() ?? text;

/** The envelope schema around a step's `run.output` schema. */
export const envelopeSchema = (output: Record<string, unknown>): Record<string, unknown> => ({
  type: "object",
  required: ["summary", "commits", "output", "skills"],
  properties: {
    summary: { type: "string" },
    commits: { type: "array", items: { type: "string" } },
    output,
    skills: skillsSchema,
  },
});

/** One compiled validator per output schema object; steps are loaded once, so this is one per step. */
const validators = new WeakMap<Record<string, unknown>, (value: unknown) => string | undefined>();

const envelopeValidator = (output: Record<string, unknown>) => {
  const cached = validators.get(output);
  if (cached !== undefined) return cached;
  const validate = validator(envelopeSchema(output));
  validators.set(output, validate);
  return validate;
};

export const parseEnvelope = (stdout: string, outputSchema: Record<string, unknown>): ParsedEnvelope => {
  const raw = lastTagContent(stdout);
  if (raw === undefined) return { ok: false, reason: `no <${RESULT_TAG}> tag in the agent output`, rawMatched: undefined };
  let json: unknown;
  try {
    json = JSON.parse(unwrapFences(raw.trim()));
  } catch (error) {
    return { ok: false, reason: `<${RESULT_TAG}> is not valid JSON: ${(error as Error).message}`, rawMatched: raw };
  }
  const problem = envelopeValidator(outputSchema)(json);
  if (problem !== undefined) return { ok: false, reason: `<${RESULT_TAG}> failed schema validation: ${problem}`, rawMatched: raw };
  return { ok: true, envelope: json as Envelope };
};
