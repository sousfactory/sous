/**
 * The static checks `sous validate` and `sous run` apply before any step
 * does work. Problems are collected instead of thrown so one run lists
 * them all.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileCondition, compileTemplate, placeholderMismatch, preparedName } from "../expr/compile.js";
import { isAgentic, loadStep, type Step } from "./step.js";
import { DONE, parseFlow, resolveUses, STEP_NAME, TERMINALS, type LoadOptions, type FlowEntry, type FlowFile, type Route } from "./flow.js";
import { DEFAULT_SETTINGS, loadSettings, projectDirs, SETTINGS_FILE, type Settings } from "./settings.js";
import { messageOf, schemaProblem } from "./schema.js";

/** Loader messages start with the file; the error carries it separately, so drop the duplicate. */
const withoutFile = (file: string, message: string): string => (message.startsWith(`${file}: `) ? message.slice(file.length + 2) : message);

export type Rule =
  | "settings"
  | "flow"
  | "duplicate-id"
  | "entry"
  | "route-target"
  | "route-shape"
  | "routes-coverage"
  | "reachable"
  | "done-reachable"
  | "uses"
  | "step"
  | "output-schema"
  | "placeholders"
  | "with"
  | "agent"
  | "expression"
  | "gate";

export type ValidationError = { file: string; id?: string; rule: Rule; message: string };

type Collect = (rule: Rule, message: string, id?: string) => void;

const isLiteralTrue = (when: string | undefined): boolean => when?.trim() === "true";

/** A route without `when` always matches; `else: true` only spells that out. */
const isUnconditional = (route: Route): boolean => route.when === undefined;

const checkRoutes = (entry: FlowEntry, ids: ReadonlySet<string>, fail: Collect): void => {
  const last = entry.routes.length - 1;
  entry.routes.forEach((route, i) => {
    if (!ids.has(route.to) && !TERMINALS.includes(route.to)) fail("route-target", `route to "${route.to}" names no step id, done or blocked`, entry.id);
    if (route.when !== undefined && route.else === true) fail("route-shape", `route to "${route.to}" has both when and else`, entry.id);
    if (isUnconditional(route) && i !== last) fail("routes-coverage", `unconditional route to "${route.to}" must be the last route`, entry.id);
    if (route.when !== undefined) compileOrFail(route.when, `routes[${i}].when`, entry.id, fail);
  });
  const lastRoute = entry.routes[last];
  const covered = (lastRoute !== undefined && isUnconditional(lastRoute)) || entry.routes.every((r) => isLiteralTrue(r.when));
  if (!covered) fail("routes-coverage", "the last route must be an else, or every when must be the literal true", entry.id);
};

const compileOrFail = (src: string, where: string, id: string, fail: Collect, template = false): void => {
  try {
    if (template) compileTemplate(src);
    else compileCondition(src);
  } catch (error: unknown) {
    fail("expression", `${where}: ${messageOf(error)}`, id);
  }
};

const checkExpressions = (entry: FlowEntry, fail: Collect): void => {
  for (const [name, value] of Object.entries(entry.with)) compileOrFail(value, `with.${name}`, entry.id, fail, true);
  if (entry.resume !== undefined) compileOrFail(entry.resume, "resume", entry.id, fail, true);
};

const preparedProperties = (step: Step): string[] => {
  const properties = step.prepare?.output["properties"];
  return typeof properties === "object" && properties !== null ? Object.keys(properties) : [];
};

const checkStep = (entry: FlowEntry, step: Step, fail: Collect): void => {
  if (step.run?.output !== undefined) {
    const problem = schemaProblem(step.run.output);
    if (problem !== undefined) fail("output-schema", `${step.file}: run.output is not a valid JSON Schema: ${problem}`, entry.id);
  }
  if (step.prepare !== undefined) {
    const problem = schemaProblem(step.prepare.output);
    if (problem !== undefined) fail("output-schema", `${step.file}: prepare.output is not a valid JSON Schema: ${problem}`, entry.id);
  }
  if (step.run?.kind === "prompt") {
    const { undeclared, unused } = placeholderMismatch(step.placeholders, Object.keys(step.inputs), preparedProperties(step));
    for (const p of undeclared) fail("placeholders", `${step.run.promptFile}: placeholder {{${p}}} is not a declared input${preparedName(p) !== undefined ? " or a property of prepare.output" : ""}`, entry.id);
    for (const i of unused) if (step.inputs[i]?.prompt !== false) fail("placeholders", `${step.run.promptFile}: input "${i}" has no placeholder in the prompt`, entry.id);
  }
  for (const [name, input] of Object.entries(step.inputs)) {
    if (input.required && !Object.hasOwn(entry.with, name)) fail("with", `required input "${name}" of ${step.name} is not in with`, entry.id);
  }
  for (const name of Object.keys(entry.with)) {
    if (!Object.hasOwn(step.inputs, name)) fail("with", `with names "${name}", which is not an input of ${step.name}`, entry.id);
  }
  if (isAgentic(step) && entry.agent === undefined) fail("agent", `${step.name} is agentic; agent is required`, entry.id);
  if (!isAgentic(step) && entry.agent !== undefined) fail("agent", `${step.name} is deterministic; agent must be absent`, entry.id);
};

const checkEntryUses = (entry: FlowEntry, stepsDir: string, fail: Collect): void => {
  if (!STEP_NAME.test(entry.uses)) {
    fail("uses", `uses "${entry.uses}" must be a step name under stepsDir, not a path`, entry.id);
    return;
  }
  const dir = resolveUses(entry.uses, stepsDir);
  if (!existsSync(join(dir, "step.yaml"))) {
    fail("uses", `uses "${entry.uses}" does not resolve to a step folder (${dir})`, entry.id);
    return;
  }
  let step: Step;
  try {
    step = loadStep(dir);
  } catch (error: unknown) {
    fail("step", messageOf(error), entry.id);
    return;
  }
  checkStep(entry, step, fail);
};

const reachableFrom = (flow: FlowFile): Set<string> => {
  const byId = new Map(flow.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const queue = [flow.entry];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    for (const route of byId.get(id)?.routes ?? []) queue.push(route.to);
  }
  return seen;
};

const checkGraph = (flow: FlowFile, fail: Collect): void => {
  const ids = new Set(flow.steps.map((s) => s.id));
  if (!ids.has(flow.entry)) {
    fail("entry", `entry "${flow.entry}" names no step id`);
    return;
  }
  const reachable = reachableFrom(flow);
  for (const entry of flow.steps) {
    if (!reachable.has(entry.id)) fail("reachable", `step is not reachable from entry "${flow.entry}"`, entry.id);
  }
  if (!reachable.has(DONE)) fail("done-reachable", `"${DONE}" is not reachable from entry "${flow.entry}"`);
};

/** Everything except the parse itself, which `validateFlowFile` reports. */
export const validateFlow = (flow: FlowFile, { stepsDir }: LoadOptions): ValidationError[] => {
  const errors: ValidationError[] = [];
  const fail: Collect = (rule, message, id) => errors.push({ file: flow.file, ...(id !== undefined ? { id } : {}), rule, message });
  const ids = new Set<string>();
  for (const entry of flow.steps) {
    if (ids.has(entry.id)) fail("duplicate-id", `id "${entry.id}" is used more than once`, entry.id);
    ids.add(entry.id);
  }
  checkGraph(flow, fail);
  for (const entry of flow.steps) {
    if (entry.gate !== undefined) fail("gate", "gate is not supported yet", entry.id);
    checkRoutes(entry, ids, fail);
    checkExpressions(entry, fail);
    checkEntryUses(entry, stepsDir, fail);
  }
  return errors;
};

export const validateFlowFile = (file: string, options: LoadOptions): ValidationError[] => {
  try {
    return validateFlow(parseFlow(file), options);
  } catch (error: unknown) {
    const abs = resolve(file);
    return [{ file: abs, rule: "flow", message: withoutFile(abs, messageOf(error)) }];
  }
};

export type ProjectReport = {
  errors: ValidationError[];
  /** Absolute flow files that were checked. */
  flows: string[];
  /** Set when `<flowsDir>/` is missing or empty. */
  note?: string;
};

/** Empty when the directory is missing. */
export const listFlows = (flowsDir: string): string[] => {
  if (!existsSync(flowsDir)) return [];
  return readdirSync(flowsDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => join(flowsDir, f));
};

/**
 * Validates `sous.yaml` and every flow under a project root (`.sous/`), with
 * the steps they use; a project's own test can assert it has no errors.
 * Broken settings are reported and the default folders used, so the flows
 * are still checked.
 */
export const validateProject = (root: string): ProjectReport => {
  const errors: ValidationError[] = [];
  const settingsFile = join(root, SETTINGS_FILE);
  let settings: Settings = DEFAULT_SETTINGS;
  try {
    settings = loadSettings(settingsFile);
  } catch (error: unknown) {
    errors.push({ file: settingsFile, rule: "settings", message: withoutFile(settingsFile, messageOf(error)) });
  }
  const dirs = projectDirs(root, settings);
  const flows = listFlows(dirs.flows);
  for (const file of flows) errors.push(...validateFlowFile(file, { stepsDir: dirs.steps }));
  const note = flows.length === 0 ? `no flows under ${dirs.flows}; nothing to validate` : undefined;
  return { errors, flows, ...(note !== undefined ? { note } : {}) };
};
