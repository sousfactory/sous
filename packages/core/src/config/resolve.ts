/**
 * Which flow an issue goes through, decided from its labels: the one rule
 * `sous run <issue>` and `sous watch` share. Only flows that declare
 * `allowedLabels` take part; a flow without the field is run only when
 * named with `--flow`, so a kind-less issue never lands in it by accident.
 */

/** What resolution reads of a flow: its name and the labels it declares. */
export type FlowLabels = { name: string; allowedLabels?: readonly string[] };

/**
 * The answer: the flow, or why there is none. `message` says it without
 * naming the issue, so each command prefixes it its own way. `cause` tells
 * an issue carrying several kinds (fix the issue) from several flows
 * declaring one label (fix the flows).
 */
export type Resolution =
  | { kind: "flow"; flow: string }
  | { kind: "none"; labels: string[]; message: string }
  | { kind: "several"; flows: string[]; cause: "kinds" | "flows"; message: string };

const KIND = "type:";

export const resolveFlow = (labels: readonly string[], flows: readonly FlowLabels[]): Resolution => {
  const accepting = flows.filter((f) => f.allowedLabels !== undefined && f.allowedLabels.some((l) => labels.includes(l)));
  if (accepting.length === 1) return { kind: "flow", flow: accepting[0]!.name };
  if (accepting.length === 0) {
    const listed = labels.length > 0 ? `its labels (${labels.join(", ")})` : "an issue without labels";
    return { kind: "none", labels: [...labels], message: `no flow accepts ${listed}; give it the type:* label of one flow's allowedLabels` };
  }
  const names = accepting.map((f) => f.name).sort();
  const matched = labels.filter((l) => accepting.some((f) => f.allowedLabels?.includes(l)));
  const kinds = matched.filter((l) => l.startsWith(KIND));
  if (kinds.length > 1)
    return { kind: "several", flows: names, cause: "kinds", message: `flows ${names.join(", ")} all accept it: the issue carries several type:* labels (${kinds.join(", ")}); keep one` };
  return { kind: "several", flows: names, cause: "flows", message: `flows ${names.join(", ")} all accept it: several flows declare ${matched.join(", ")} in allowedLabels; keep it in one` };
};
