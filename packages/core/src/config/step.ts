/**
 * `step.yaml`: schema, defaults and loader. Relative paths resolve against
 * the step folder. The placeholder check against `inputs` lives in
 * `validate`, not here, so every error is listed rather than the first.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SousError } from "../exec/errors.js";
import { placeholdersOf } from "../expr/compile.js";
import { checker, messageOf, readYaml } from "./schema.js";

export const STEP_FILE = "step.yaml";
export const AGENTIC_MAX_ITERATIONS = 3;
export const AGENTIC_LOOP = true;

/** `prompt: false`: read by the step's prepare or eval, never rendered into the prompt. */
export type StepInput = { required: boolean; description?: string; prompt?: false };

export type StepRun =
  | { kind: "prompt"; promptFile: string; prompt: string; output: Record<string, unknown> }
  | { kind: "module"; module: string; output?: Record<string, unknown> };

export type StepEval = { kind: "module"; module: string } | { kind: "shell"; shell: string };

/** A module run once per visit before the agent; `output` is the JSON Schema of what it returns as `output`. */
export type StepPrepare = { module: string; output: Record<string, unknown> };

export type Step = {
  name: string;
  description?: string;
  /** Absolute step folder. */
  dir: string;
  /** Absolute `step.yaml` path. */
  file: string;
  inputs: Record<string, StepInput>;
  /** Absent for an eval-only step, where the eval does the work. */
  run?: StepRun;
  eval?: StepEval;
  /** Agentic steps only: decides whether the agent runs and computes values for the prompt and the eval. */
  prepare?: StepPrepare;
  /** Ignored for a module step, which runs once. */
  maxIterations: number;
  /** `false` stops after the first eval failure instead of retrying; a missing envelope is still retried. */
  loop: boolean;
  /** Every `{{name}}` of the prompt, `ctx.*` included. */
  placeholders: Set<string>;
};

export const isAgentic = (step: Step): boolean => step.run?.kind === "prompt";

type StepDoc = {
  name: string;
  description?: string;
  inputs?: Record<string, { required?: boolean; description?: string; prompt?: boolean }>;
  run?: { prompt: string; output: Record<string, unknown>; module?: never } | { module: string; output?: Record<string, unknown>; prompt?: never };
  eval?: string | { shell: string };
  prepare?: { module: string; output: Record<string, unknown> };
  maxIterations?: number;
  loop?: boolean;
};

const check = checker<StepDoc>({
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    inputs: {
      type: "object",
      propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: { required: { type: "boolean" }, description: { type: "string" }, prompt: { type: "boolean" } },
      },
    },
    run: {
      type: "object",
      oneOf: [
        {
          required: ["prompt", "output"],
          additionalProperties: false,
          properties: { prompt: { type: "string", minLength: 1 }, output: { type: "object" } },
        },
        {
          required: ["module"],
          additionalProperties: false,
          properties: { module: { type: "string", minLength: 1 }, output: { type: "object" } },
        },
      ],
    },
    eval: {
      oneOf: [
        { type: "string", minLength: 1 },
        { type: "object", required: ["shell"], additionalProperties: false, properties: { shell: { type: "string", minLength: 1 } } },
      ],
    },
    prepare: {
      type: "object",
      required: ["module", "output"],
      additionalProperties: false,
      properties: { module: { type: "string", minLength: 1 }, output: { type: "object" } },
    },
    maxIterations: { type: "integer", minimum: 1 },
    loop: { type: "boolean" },
  },
});

/** Sandcastle would execute `` !`command` `` in a prompt, so a prompt file must not contain one. */
const SHELL_SEQUENCE = /!`[^`]*`/;

const readPrompt = (file: string): string => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error: unknown) {
    throw new SousError(`${file}: ${messageOf(error)}`);
  }
  const hit = SHELL_SEQUENCE.exec(text);
  if (hit !== null) throw new SousError(`${file}: prompt contains a shell sequence ${hit[0]}`);
  return text;
};

const runOf = (doc: NonNullable<StepDoc["run"]>, dir: string): StepRun => {
  if (doc.prompt !== undefined) {
    const promptFile = resolve(dir, doc.prompt);
    return { kind: "prompt", promptFile, prompt: readPrompt(promptFile), output: doc.output };
  }
  return { kind: "module", module: resolve(dir, doc.module), ...(doc.output !== undefined ? { output: doc.output } : {}) };
};

const evalOf = (doc: NonNullable<StepDoc["eval"]>, dir: string): StepEval =>
  typeof doc === "string" ? { kind: "module", module: resolve(dir, doc) } : { kind: "shell", shell: doc.shell };

/** Loads `<dir>/step.yaml`; throws a `SousError` naming the file on any problem. */
export const loadStep = (dir: string): Step => {
  const absDir = resolve(dir);
  const file = join(absDir, STEP_FILE);
  const doc = check(readYaml(file), file);
  if (doc.run === undefined && doc.eval === undefined) throw new SousError(`${file}: neither run nor eval; a step needs at least one`);
  if (doc.prepare !== undefined && doc.run?.prompt === undefined) throw new SousError(`${file}: prepare needs run.prompt; only an agentic step has an agent to prepare`);
  const run = doc.run === undefined ? undefined : runOf(doc.run, absDir);
  return {
    name: doc.name,
    ...(doc.description !== undefined ? { description: doc.description } : {}),
    dir: absDir,
    file,
    inputs: Object.fromEntries(
      Object.entries(doc.inputs ?? {}).map(([name, input]) => [
        name,
        { required: input.required ?? true, ...(input.description !== undefined ? { description: input.description } : {}), ...(input.prompt === false ? { prompt: false as const } : {}) },
      ]),
    ),
    ...(run !== undefined ? { run } : {}),
    ...(doc.eval !== undefined ? { eval: evalOf(doc.eval, absDir) } : {}),
    ...(doc.prepare !== undefined ? { prepare: { module: resolve(absDir, doc.prepare.module), output: doc.prepare.output } } : {}),
    maxIterations: doc.maxIterations ?? AGENTIC_MAX_ITERATIONS,
    loop: doc.loop ?? AGENTIC_LOOP,
    placeholders: run?.kind === "prompt" ? placeholdersOf(run.prompt) : new Set(),
  };
};
