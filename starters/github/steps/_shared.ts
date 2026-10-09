/**
 * Helpers shared by several steps. A plain file, not a step folder, so
 * `uses: _shared` cannot resolve to it. Review finding helpers live with
 * the `review` step (`review/findings.ts`) instead.
 */
import { SousError, type Inputs } from "sous-factory";

/** A required string input, as `validate` guarantees it is wired; a missing or non-string value names the step. */
export const requireString = (inputs: Inputs, name: string, step: string): string => {
  const value = inputs[name];
  if (typeof value !== "string" || value.trim() === "") throw new SousError(`${step}: input "${name}" must be a non-empty string`);
  return value;
};
