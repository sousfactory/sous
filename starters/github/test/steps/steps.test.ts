/**
 * The generic lifecycle steps as the loader sees them. Placeholders against
 * inputs are pinned in `prompts.test.ts`.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStep, type Step } from "sous-factory";

const steps = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "steps");

type Expected = { kind: "module" | "prompt"; inputs: string[]; eval?: boolean; maxIterations?: number; loop?: boolean };

/** Each step's expected kind, inputs, eval and caps. */
const LIBRARY: Record<string, Expected> = {
  init: { kind: "module", inputs: [] },
  "next-work": { kind: "module", inputs: [] },
  "close-work": { kind: "module", inputs: ["commits"] },
  merge: { kind: "module", inputs: ["baseBranch", "mergedLabel", "resync"] },
};

const NAMES = Object.keys(LIBRARY);

const load = (name: string): Step => loadStep(join(steps, name));

describe("lifecycle steps", () => {
  it.each(NAMES)("%s loads with a name, a description, described inputs, an output schema and its files", (name) => {
    const step = load(name);
    expect(step.name).toBe(name);
    expect(step.description?.length ?? 0).toBeGreaterThan(20);
    for (const [input, spec] of Object.entries(step.inputs)) {
      expect(spec.description?.length ?? 0, `${name}.${input} has a description`).toBeGreaterThan(10);
    }
    if (step.run === undefined) throw new Error(`${name} has no run`);
    expect(step.run.output, `${name} declares run.output`).toBeDefined();
    for (const file of [step.run.kind === "prompt" ? step.run.promptFile : step.run.module, ...(step.eval?.kind === "module" ? [step.eval.module] : [])]) {
      expect(existsSync(file), `${file} exists`).toBe(true);
    }
  });

  it.each(NAMES)("%s has the kind, inputs, eval and caps of its README.md", (name) => {
    const step = load(name);
    const expected = LIBRARY[name];
    if (expected === undefined) throw new Error("unreachable");
    expect(step.run?.kind).toBe(expected.kind);
    expect(Object.keys(step.inputs).sort()).toEqual([...expected.inputs].sort());
    expect(step.eval !== undefined).toBe(expected.eval ?? false);
    if (expected.maxIterations !== undefined) expect(step.maxIterations).toBe(expected.maxIterations);
    if (expected.loop !== undefined) expect(step.loop).toBe(expected.loop);
  });

  it("_shared is not a step", () => {
    expect(() => load("_shared")).toThrow(/step\.yaml/);
    expect(existsSync(join(steps, "_shared.ts"))).toBe(true);
  });
});
