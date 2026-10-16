/**
 * A copy of `steps/` with `CHECKS` in `verify/eval.ts` filled in, so the
 * flow tests exercise real check runs although the starter ships an empty
 * list. The copy lives beside the tests so the steps' `sous-factory` import
 * still resolves.
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Check } from "../steps/verify/eval.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CHECKS_LINE = /export const CHECKS: readonly Check\[\] = \[\];/;

export type CheckedSteps = { stepsDir: string; remove: () => Promise<void> };

export const checkedSteps = async (checks: readonly Check[]): Promise<CheckedSteps> => {
  const dir = await mkdtemp(join(root, "test", ".steps-"));
  const stepsDir = join(dir, "steps");
  await cp(join(root, "steps"), stepsDir, { recursive: true });
  const file = join(stepsDir, "verify", "eval.ts");
  const source = readFileSync(file, "utf8");
  if (!CHECKS_LINE.test(source)) throw new Error("checkedSteps: steps/verify/eval.ts no longer has an empty CHECKS line");
  writeFileSync(file, source.replace(CHECKS_LINE, `export const CHECKS: readonly Check[] = ${JSON.stringify(checks)};`), "utf8");
  return { stepsDir, remove: () => rm(dir, { recursive: true, force: true }) };
};
