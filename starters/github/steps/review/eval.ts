/**
 * Fails on any blocking finding; the log lists only those, so it is empty
 * for a clean review. The step's `loop: false` sends that log to `fix`
 * rather than back to the reviewer. Only a review-shaped output can pass:
 * anything else is a review that did not happen, never a clean one.
 */
import type { EvalFn } from "sous-factory";
import { findingsOf, formatFinding, isBlocking } from "./findings.js";

export default (async (_ctx, _inputs, result) => {
  if (result === undefined) return { ok: false, log: "review: no review output" };
  const findings = findingsOf(result.output);
  if (findings === undefined) return { ok: false, log: "review: the output is not a review (no findings array)" };
  const blocking = findings.filter(isBlocking);
  return { ok: blocking.length === 0, log: blocking.map(formatFinding).join("\n") };
}) satisfies EvalFn;
