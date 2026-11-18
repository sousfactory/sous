/**
 * Which flow an issue goes through, decided from its labels: the one rule
 * `sous run <issue>` and `sous watch` share. Only flows that declare
 * `allowedLabels` take part; a flow without the field is run only when
 * named with `--flow`, so a kind-less issue never lands in it by accident.
 */
import { flowName } from "./flow.js";
import { readYaml } from "./schema.js";
import { listFlows } from "./validate.js";

/** What resolution reads of a flow: its name, the labels it declares and, when read from disk, its file. */
export type FlowLabels = { name: string; file?: string; allowedLabels?: readonly string[] };

/**
 * The answer: the flow, or why there is none. `message` says it without
 * naming the issue, so each command prefixes it its own way. `cause` tells
 * an issue carrying labels of several flows (fix the issue) from several
 * flows declaring one label (fix the flows).
 */
export type Resolution =
  | { kind: "flow"; flow: string }
  | { kind: "none"; labels: string[]; message: string }
  | { kind: "several"; flows: string[]; cause: "kinds" | "flows"; message: string };

/**
 * The flows of a project as resolution sees them, read from the flow files
 * alone (`.yaml` or `.yml`): both commands build their input here, and the
 * daemon can read a repository on another engine version without its schema.
 */
export const flowLabelsOf = (flowsDir: string): FlowLabels[] =>
  listFlows(flowsDir).map((file) => {
    const doc = readYaml(file) as { allowedLabels?: unknown } | null;
    const allowed = doc?.allowedLabels;
    return { name: flowName(file), file, ...(Array.isArray(allowed) ? { allowedLabels: allowed.map(String) } : {}) };
  });

export const resolveFlow = (labels: readonly string[], flows: readonly FlowLabels[]): Resolution => {
  const accepting = flows.filter((f) => f.allowedLabels !== undefined && f.allowedLabels.some((l) => labels.includes(l)));
  if (accepting.length === 1) return { kind: "flow", flow: accepting[0]!.name };
  if (accepting.length === 0) {
    const listed = labels.length > 0 ? `its labels (${labels.join(", ")})` : "an issue without labels";
    return { kind: "none", labels: [...labels], message: `no flow accepts ${listed}; give it the type:* label of one flow's allowedLabels` };
  }
  const names = accepting.map((f) => f.name).sort();
  const matched = labels.filter((l) => accepting.some((f) => f.allowedLabels?.includes(l)));
  // A label two flows declare stays ambiguous however the issue is labelled: the flows are the cause.
  const shared = matched.filter((l) => accepting.filter((f) => f.allowedLabels?.includes(l)).length > 1);
  if (shared.length > 0)
    return { kind: "several", flows: names, cause: "flows", message: `flows ${names.join(", ")} all accept it: several flows declare ${shared.join(", ")} in allowedLabels; keep it in one` };
  return { kind: "several", flows: names, cause: "kinds", message: `flows ${names.join(", ")} all accept it: the issue carries labels of several flows (${matched.join(", ")}); keep one` };
};
