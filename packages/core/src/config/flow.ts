/**
 * Flow files (`<flowsDir>/<name>.yaml`). `parseFlow` reads the file alone so
 * `validate` can report every step problem at once; `loadFlow` also loads
 * the steps and throws on the first problem.
 */
import { basename, extname, join, resolve } from "node:path";
import { loadStep, type Step } from "./step.js";
import { checker, readYaml } from "./schema.js";

export const DONE = "done";
export const BLOCKED = "blocked";
export const TERMINALS: readonly string[] = [DONE, BLOCKED];

export type AgentKind = "claude" | "codex";
export type Agent = { kind: AgentKind; model: string };

export type Route = { to: string; when?: string; else?: true };

/** One entry of the flow's `steps:` as written in the YAML. */
export type FlowEntry = {
  id: string;
  uses: string;
  agent?: Agent;
  with: Record<string, string>;
  resume?: string;
  routes: Route[];
  maxIterations?: number;
  loop?: boolean;
  /** Reserved for human approval gates; `validate` rejects it until they exist. */
  gate?: unknown;
};

export type FlowFile = {
  /** File name without extension: `task`, `feature`. */
  name: string;
  /** Absolute path. */
  file: string;
  entry: string;
  /** Issue labels this flow accepts; `sous run` refuses an issue with none of them. Absent: any issue. */
  allowedLabels?: string[];
  /** Overrides the `lifecycle` setting, so a flow that only exercises things (`steps`) never claims or closes an issue. */
  lifecycle?: "core" | "steps";
  steps: FlowEntry[];
};

export type LoadedEntry = FlowEntry & { step: Step };
export type Flow = Omit<FlowFile, "steps"> & { steps: LoadedEntry[] };

type FlowDoc = { entry: string; allowedLabels?: string[]; lifecycle?: "core" | "steps"; steps: FlowEntry[] };

const check = checker<FlowDoc>({
  type: "object",
  required: ["entry", "steps"],
  additionalProperties: false,
  properties: {
    entry: { type: "string", minLength: 1 },
    allowedLabels: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
    lifecycle: { enum: ["core", "steps"] },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "uses", "routes"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          uses: { type: "string", minLength: 1 },
          agent: {
            type: "object",
            required: ["kind", "model"],
            additionalProperties: false,
            properties: { kind: { enum: ["claude", "codex"] }, model: { type: "string", minLength: 1 } },
          },
          with: { type: "object", additionalProperties: { type: "string" } },
          resume: { type: "string" },
          routes: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["to"],
              additionalProperties: false,
              properties: { to: { type: "string", minLength: 1 }, when: { type: "string" }, else: { const: true } },
            },
          },
          maxIterations: { type: "integer", minimum: 1 },
          loop: { type: "boolean" },
          gate: {},
        },
      },
    },
  },
});

export const flowName = (file: string): string => basename(file, extname(file));

export const parseFlow = (file: string): FlowFile => {
  const abs = resolve(file);
  const doc = check(readYaml(abs), abs);
  return {
    name: flowName(abs),
    file: abs,
    entry: doc.entry,
    ...(doc.allowedLabels !== undefined ? { allowedLabels: doc.allowedLabels } : {}),
    ...(doc.lifecycle !== undefined ? { lifecycle: doc.lifecycle } : {}),
    steps: doc.steps.map((s) => ({ ...s, with: s.with ?? {} })),
  };
};

/** Whether an issue with `labels` may run through `flow`; a flow without `allowedLabels` takes any issue. */
export const acceptsLabels = (flow: Pick<FlowFile, "allowedLabels">, labels: readonly string[]): boolean =>
  flow.allowedLabels === undefined || flow.allowedLabels.some((label) => labels.includes(label));

/** `uses` is a step name, not a path, so a flow cannot reach outside the step library. */
export const STEP_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export const resolveUses = (uses: string, stepsDir: string): string => join(stepsDir, uses);

/** `stepsDir` is absolute, usually `projectDirs(root, settings).steps`. */
export type LoadOptions = { stepsDir: string };

/**
 * Loads a flow with every step it uses, as a test of a flow or step would.
 * Throws a `SousError` on the first problem; `validateProject` lists them all.
 */
export const loadFlow = (file: string, { stepsDir }: LoadOptions): Flow => {
  const parsed = parseFlow(file);
  return { ...parsed, steps: parsed.steps.map((entry) => ({ ...entry, step: loadStep(resolveUses(entry.uses, stepsDir)) })) };
};
