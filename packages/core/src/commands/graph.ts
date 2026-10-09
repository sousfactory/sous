/**
 * `sous graph <flow>`: the flow as a Mermaid `stateDiagram-v2`, straight
 * from the YAML. Every agentic entry also gets the implicit `exhausted` edge
 * to `blocked`, which the YAML never spells out.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BLOCKED, DONE, parseFlow, resolveUses, STEP_NAME, type Agent, type FlowEntry, type FlowFile } from "../config/flow.js";
import { loadStep, type Step } from "../config/step.js";
import { loadSettings, projectDirs, SETTINGS_FILE } from "../config/settings.js";
import { listFlows } from "../config/validate.js";
import { messageOf } from "../config/schema.js";

export type GraphDeps = {
  root: string;
  out: (line: string) => void;
  err: (line: string) => void;
};

export type GraphEdge = { from: string; to: string; label?: string };

/**
 * How a step does its work: an agent `prompt`, a deterministic `module`, or
 * `eval` alone (the eval is the work, as in `verify`).
 */
export type StepKind = "prompt" | "module" | "eval";

/**
 * A flow entry as declared, without its inputs. `kind`, `prepare` and
 * `evalGate` are only known when the step loaded from `stepsDir`.
 */
export type TopologyNode = { id: string; uses: string; agent?: Agent; kind?: StepKind; prepare?: true; evalGate?: true; description?: string };

type Shape = { kind: StepKind; prepare?: true; evalGate?: true };

export const shapeOf = (step: Step): Shape =>
  step.run === undefined
    ? { kind: "eval" }
    : { kind: step.run.kind, ...(step.prepare !== undefined ? { prepare: true as const } : {}), ...(step.eval !== undefined ? { evalGate: true as const } : {}) };

/** Empty when `uses` is not a step name or does not load: the graph still draws a broken project. */
const shapeIn = (stepsDir: string, uses: string): Partial<Shape> & { description?: string } => {
  if (!STEP_NAME.test(uses)) return {};
  try {
    const step = loadStep(resolveUses(uses, stepsDir));
    return { ...shapeOf(step), ...(step.description !== undefined ? { description: step.description } : {}) };
  } catch {
    return {};
  }
};

/** A route (`when` absent for the fallthrough), or the implicit `exhausted → blocked` edge of an agentic entry. */
export type TopologyEdge = { from: string; to: string; when?: string; exhausted?: true };

/** The flow as data: what `renderGraph` draws and `sous ui` lays out. */
export type Topology = { entry: string; nodes: TopologyNode[]; edges: TopologyEdge[] };

export const USAGE = "usage: sous graph <flow>";
export const LABEL_MAX = 40;

/** Mermaid state ids cannot contain `-`; the display name keeps it. */
export const nodeId = (id: string): string => id.replaceAll("-", "_");

export const kindOf = (entry: FlowEntry): string => (entry.agent !== undefined ? `agentic (${entry.agent.kind})` : "deterministic");

/** `;` ends a Mermaid statement, so it is softened to `,`. */
export const shorten = (condition: string): string => {
  const flat = condition.replace(/\s+/g, " ").replaceAll(";", ",").trim();
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat;
};

/** With `stepsDir`, every node also gets its step's shape. */
export const topology = (flow: FlowFile, stepsDir?: string): Topology => ({
  entry: flow.entry,
  nodes: flow.steps.map((entry) => ({
    id: entry.id,
    uses: entry.uses,
    ...(entry.agent !== undefined ? { agent: entry.agent } : {}),
    ...(stepsDir !== undefined ? shapeIn(stepsDir, entry.uses) : {}),
  })),
  edges: flow.steps.flatMap((entry): TopologyEdge[] => [
    ...entry.routes.map((r) => ({ from: entry.id, to: r.to, ...(r.when !== undefined ? { when: r.when } : {}) })),
    ...(entry.agent !== undefined ? [{ from: entry.id, to: BLOCKED, exhausted: true as const }] : []),
  ]),
});

export const graphEdges = (flow: FlowFile): GraphEdge[] =>
  topology(flow).edges.map((e) => ({
    from: e.from,
    to: e.to,
    ...(e.exhausted === true ? { label: "exhausted" } : e.when !== undefined ? { label: shorten(e.when) } : {}),
  }));

const declare = (id: string, kind: string): string[] => [`    state "${id}" as ${nodeId(id)}`, `    ${nodeId(id)} : ${kind}`];

export const renderGraph = (flow: FlowFile): string => {
  const edges = graphEdges(flow);
  const terminals = [DONE, BLOCKED].filter((t) => edges.some((e) => e.to === t));
  return [
    "stateDiagram-v2",
    ...flow.steps.flatMap((s) => declare(s.id, kindOf(s))),
    ...terminals.flatMap((t) => declare(t, "terminal")),
    `    [*] --> ${nodeId(flow.entry)}`,
    ...edges.map((e) => `    ${nodeId(e.from)} --> ${nodeId(e.to)}${e.label !== undefined ? ` : ${e.label}` : ""}`),
    ...terminals.map((t) => `    ${nodeId(t)} --> [*]`),
  ].join("\n");
};

export const graphCommand = async (args: readonly string[], deps: GraphDeps): Promise<number> => {
  const [name, ...rest] = args;
  const { flows } = projectDirs(deps.root, loadSettings(join(deps.root, SETTINGS_FILE)));
  const file = name === undefined ? undefined : join(flows, `${name}.yaml`);
  if (file === undefined || rest.length > 0 || !existsSync(file)) {
    const known = listFlows(flows).map((f) => f.replace(/^.*\/|\.ya?ml$/g, ""));
    deps.err(`${USAGE} (known: ${known.length > 0 ? known.join(", ") : "none"})`);
    return 2;
  }
  try {
    deps.out(renderGraph(parseFlow(file)));
  } catch (error: unknown) {
    deps.err(messageOf(error));
    return 2;
  }
  return 0;
};
