/**
 * Fails on any blocking finding; the log lists only those, so it is empty
 * for a clean review. The step's `loop: false` sends that log to `fix`
 * rather than back to the reviewer.
 */
import type { Envelope, EvalFn } from "sous-factory";
import { findingsOf, formatFinding, isBlocking, type Finding } from "./findings.js";

type Review = { verdict: "clean" | "findings"; findings: Finding[] };

export default (async (_ctx, _inputs, result) => {
  if (result === undefined) return { ok: false, log: "review: no review output" };
  const findings = findingsOf((result as Envelope<Review>).output) ?? [];
  const blocking = findings.filter(isBlocking);
  return { ok: blocking.length === 0, log: blocking.map(formatFinding).join("\n") };
}) satisfies EvalFn;
