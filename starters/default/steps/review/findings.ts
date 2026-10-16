/**
 * Review findings and the rule for which ones block. Shared by the review
 * eval and `merge`, which lists a run's minor findings from the event log;
 * there steps appear under their flow ids, so the output's shape is the only
 * way to recognise a review.
 */

export type Severity = "blocker" | "major" | "minor" | "nit";

/** One review finding, as the `review` output schema declares it. */
export type Finding = { severity: Severity; file: string; line?: number; message: string };

export const BLOCKING_SEVERITIES: ReadonlySet<string> = new Set<Severity>(["blocker", "major"]);

export const isBlocking = (finding: Finding): boolean => BLOCKING_SEVERITIES.has(finding.severity);

/** `severity file:line message`, one line, for eval logs and comments. */
export const formatFinding = (f: Finding): string => `${f.severity} ${f.file}${f.line !== undefined ? `:${f.line}` : ""} ${f.message}`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isFinding = (value: unknown): value is Finding =>
  isRecord(value) && typeof value["severity"] === "string" && typeof value["file"] === "string" && typeof value["message"] === "string";

/**
 * Recognises a review by shape: any output with a `findings` array. Entries
 * that are not findings are dropped; undefined means not a review output.
 */
export const findingsOf = (output: unknown): Finding[] | undefined => {
  if (!isRecord(output) || !Array.isArray(output["findings"])) return undefined;
  return output["findings"].filter(isFinding);
};
