/**
 * Pure glue between an `AgentRequest` and a sandcastle run, kept free of I/O
 * so it is testable without an agent: provider selection, envelope
 * extraction and validation, option assembly. Prompt and retry texts belong
 * to the executor.
 */
import { claudeCode, codex, type AgentProvider, type AgentStreamEvent, type SandboxRunOptions } from "@ai-hero/sandcastle";
import type { Agent } from "../config/flow.js";
import { validator } from "../config/schema.js";
import type { Envelope } from "../index.js";
import type { AgentRequest } from "../ports/sandbox.js";
import { skillsSchema } from "../skills.js";

export const RESULT_TAG = "result";

export const selectAgent = ({ kind, model }: Agent): AgentProvider =>
  kind === "claude" ? claudeCode(model, { permissionMode: "bypassPermissions" }) : codex(model);

export type ParsedEnvelope = { ok: true; envelope: Envelope } | { ok: false; reason: string; rawMatched: string | undefined };

/** Contents of the last `<tag>…</tag>` pair in `text`, or undefined (sandcastle's rule). */
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

export type RunOptionsDeps = {
  agent: AgentProvider;
  idleTimeoutSeconds: number;
  /** The tool call collector. */
  onEvent?: (event: AgentStreamEvent) => void;
  /** The run's interrupt: aborting it kills the agent process and rejects the run. */
  signal?: AbortSignal;
};

export const buildRunOptions = (req: AgentRequest, deps: RunOptionsDeps): SandboxRunOptions => ({
  agent: deps.agent,
  prompt: req.prompt,
  ...(req.resumeSession !== undefined ? { resumeSession: req.resumeSession } : {}),
  idleTimeoutSeconds: deps.idleTimeoutSeconds,
  logging: { type: "file", path: req.logPath, ...(deps.onEvent !== undefined ? { onAgentStreamEvent: deps.onEvent } : {}) },
  ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
});
