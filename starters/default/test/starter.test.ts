/**
 * The starter kit: the generic part of this project, what `sous init` copies
 * into a new repository. Pinned here so repository-specific knowledge stays
 * in `steps/verify/eval.ts` (the commands) and `sous.yaml` (the branch),
 * never in another step.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Paths under `.sous/` that make up the starter; folders are copied whole. */
export const STARTER = [
  "README.md",
  "sous",
  "sous.yaml",
  "package.json",
  "tsconfig.json",
  "vitest.config.ts",
  "flows/task.yaml",
  "flows/feature.yaml",
  "flows/bench.yaml",
  "steps/_shared.ts",
  "steps/init",
  "steps/plan",
  "steps/next-work",
  "steps/close-work",
  "steps/merge",
  "steps/sync-resolve",
  "steps/implement",
  "steps/review",
  "steps/fix",
  "steps/verify",
  "steps/hello-world",
  "steps/tell-a-joke",
  "skills",
  "skills/sous-plan",
  "prompts/plan.md",
  "trackers/github.md",
  "trackers/beads.md",
  "trackers/local.md",
  "test/bench.test.ts",
  "test/checked-steps.ts",
  "test/flows.test.ts",
  "test/prompts.test.ts",
  "test/review.test.ts",
  "test/starter.test.ts",
  "test/verify.test.ts",
  "test/steps",
  "test/review-findings.test.ts",
];

const filesUnder = (path: string): string[] => (statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => filesUnder(join(path, name))) : [path]);

const starterFiles = STARTER.flatMap((p) => filesUnder(join(root, p)));
/** The one step file meant to hold the project's commands and base branch. */
const CHECKS_FILE = join(root, "steps", "verify", "eval.ts");
const stepFiles = starterFiles.filter((f) => f.startsWith(`${join(root, "steps")}/`) && f !== CHECKS_FILE);

/** Built from parts so this file does not match itself. */
const REPO_NAMES = new RegExp(["crypto", "analytics"].join("") + "|" + ["squa", "rito"].join(""), "i");

describe("starter", () => {
  it("names only paths that exist", () => {
    for (const p of STARTER) expect(existsSync(join(root, p)), p).toBe(true);
  });

  it("keeps every step folder in the list, so none is forgotten", () => {
    const steps = readdirSync(join(root, "steps"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `steps/${d.name}`);
    expect(steps.sort()).toEqual(STARTER.filter((p) => p.startsWith("steps/") && !p.endsWith(".ts")).sort());
  });

  it("keeps the build tool out of the steps: verify/eval.ts alone carries the commands", () => {
    for (const file of stepFiles) expect(readFileSync(file, "utf8"), file).not.toMatch(/gradle/i);
  });

  it("names this repository nowhere", () => {
    for (const file of starterFiles) expect(readFileSync(file, "utf8"), file).not.toMatch(REPO_NAMES);
  });

  it("has the base branch in sous.yaml, the flows and verify/eval.ts only, never in another step module", () => {
    for (const file of stepFiles.filter((f) => /\.(ts|yaml)$/.test(f))) expect(readFileSync(file, "utf8"), file).not.toMatch(/["'`]main["'`]/);
  });
});
