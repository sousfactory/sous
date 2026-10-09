import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAgentic, loadStep } from "../../src/config/step.js";
import { fixture, projectSteps } from "../helpers.js";

const tempStep = (yaml: string, prompt?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "sous-step-"));
  writeFileSync(join(dir, "step.yaml"), yaml);
  if (prompt !== undefined) writeFileSync(join(dir, "prompt.md"), prompt);
  return dir;
};

describe("loadStep", () => {
  it("parses a prompt step: every field, the prompt text and its placeholders, paths against the folder", () => {
    const dir = join(projectSteps, "build");
    const step = loadStep(dir);
    expect(step.name).toBe("build");
    expect(step.description).toBe("Implement the task and run the verify command.");
    expect(step.dir).toBe(dir);
    expect(step.file).toBe(join(dir, "step.yaml"));
    expect(step.inputs).toEqual({
      task: { required: true, description: "what to implement" },
      verify: { required: true, description: "test command" },
      hint: { required: false },
    });
    expect(step.run?.kind).toBe("prompt");
    if (step.run?.kind !== "prompt") throw new Error("unreachable");
    expect(step.run.promptFile).toBe(join(dir, "prompt.md"));
    expect(step.run.prompt).toContain("{{task}}");
    expect(step.run.output).toEqual({ type: "object", required: ["filesTouched"], properties: { filesTouched: { type: "array", items: { type: "string" } } } });
    expect(step.eval).toEqual({ kind: "module", module: join(dir, "eval.ts") });
    expect(step.maxIterations).toBe(3);
    expect(step.loop).toBe(true);
    expect([...step.placeholders].sort()).toEqual(["ctx.issue.ref", "ctx.worktree", "hint", "task", "verify"]);
    expect(isAgentic(step)).toBe(true);
  });

  it("parses a shell eval, maxIterations and loop", () => {
    const step = loadStep(join(projectSteps, "review"));
    expect(step.eval).toEqual({ kind: "shell", shell: "true" });
    expect(step.maxIterations).toBe(2);
    expect(step.loop).toBe(false);
    expect(step.inputs).toEqual({ diffRange: { required: true }, criteria: { required: true, description: "acceptance criteria" } });
  });

  it("parses a module step with an optional output schema and no eval", () => {
    const dir = join(projectSteps, "sync");
    const step = loadStep(dir);
    expect(step.run).toEqual({ kind: "module", module: join(dir, "run.ts"), output: { type: "object", properties: { conflict: { type: "boolean" } } } });
    expect(step.eval).toBeUndefined();
    expect(step.inputs).toEqual({});
    expect(step.placeholders.size).toBe(0);
    expect(isAgentic(step)).toBe(false);
  });

  it("parses a module step without output schema", () => {
    const step = loadStep(join(projectSteps, "merge"));
    expect(step.run).toEqual({ kind: "module", module: join(projectSteps, "merge", "run.ts") });
  });

  it("parses an eval-only step: no run, deterministic, the eval does the work", () => {
    const dir = tempStep("name: verify\neval: { shell: './gradlew build' }\n");
    const step = loadStep(dir);
    expect(step.run).toBeUndefined();
    expect(step.eval).toEqual({ kind: "shell", shell: "./gradlew build" });
    expect(step.placeholders.size).toBe(0);
    expect(isAgentic(step)).toBe(false);
    expect(loadStep(tempStep("name: v\ninputs: { diff: {} }\neval: ./eval.ts\n")).eval).toEqual({ kind: "module", module: expect.stringMatching(/\/eval\.ts$/) });
    expect(loadStep(tempStep("name: v\ninputs: { checks: { prompt: false }, task: { prompt: true } }\neval: ./eval.ts\n")).inputs).toEqual({ checks: { required: true, prompt: false }, task: { required: true } });
  });

  it("parses prepare on a prompt step, its module against the folder", () => {
    const dir = tempStep("name: x\nprepare: { module: ./prepare.ts, output: { type: object } }\nrun: { prompt: prompt.md, output: {} }\n", "Do {{prepared.note}}.\n");
    const step = loadStep(dir);
    expect(step.prepare).toEqual({ module: join(dir, "prepare.ts"), output: { type: "object" } });
    expect([...step.placeholders]).toEqual(["prepared.note"]);
  });

  it("rejects prepare without run.prompt, and a prepare without output", () => {
    expect(() => loadStep(tempStep("name: x\nprepare: { module: p.ts, output: {} }\nrun: { module: m.ts }\n"))).toThrow(/step\.yaml: prepare needs run\.prompt/);
    expect(() => loadStep(tempStep("name: x\nprepare: { module: p.ts, output: {} }\neval: ./eval.ts\n"))).toThrow(/prepare needs run\.prompt/);
    expect(() => loadStep(tempStep("name: x\nprepare: { module: p.ts }\nrun: { prompt: prompt.md, output: {} }\n", "x"))).toThrow(/\/prepare must have required property 'output'/);
  });

  it("rejects a step with neither run nor eval", () => {
    expect(() => loadStep(tempStep("name: x\n"))).toThrow(/step\.yaml: neither run nor eval; a step needs at least one/);
    expect(() => loadStep(fixture("invalid", "steps", "no-run"))).toThrow(/no-run\/step\.yaml: neither run nor eval/);
  });

  it("accepts a relative folder and resolves it", () => {
    const step = loadStep(join(projectSteps, "sync", "..", "merge"));
    expect(step.dir).toBe(join(projectSteps, "merge"));
  });

  it("rejects a prompt with a !`command` sequence", () => {
    expect(() => loadStep(fixture("invalid", "steps", "bang"))).toThrow(/bang\/prompt\.md: prompt contains a shell sequence !`ls -la`/);
  });

  it("does not check placeholders against inputs; that is a validate rule", () => {
    const step = loadStep(fixture("invalid", "steps", "mismatch"));
    expect([...step.placeholders].sort()).toEqual(["ctx.specDir", "undeclared"]);
  });

  it("names the file for a schema violation", () => {
    expect(() => loadStep(fixture("invalid", "steps", "bad-yaml"))).toThrow(/bad-yaml\/step\.yaml: \/ must have required property 'name'/);
  });

  it("rejects a run with both prompt and module, a missing prompt output, and unknown keys", () => {
    expect(() => loadStep(tempStep("name: x\nrun: { prompt: p.md, module: m.ts, output: {} }\n"))).toThrow(/\/run must match exactly one schema/);
    expect(() => loadStep(tempStep("name: x\nrun: { prompt: p.md }\n"))).toThrow(/\/run/);
    expect(() => loadStep(tempStep("name: x\nrun: { module: m.ts }\nphase: slice\n"))).toThrow(/must NOT have additional properties \(phase\)/);
    expect(() => loadStep(tempStep("name: x\nrun: { module: m.ts }\neval: { shell: 1 }\n"))).toThrow(/\/eval/);
    expect(() => loadStep(tempStep("name: x\nrun: { module: m.ts }\nmaxIterations: 0\n"))).toThrow(/\/maxIterations must be >= 1/);
    expect(() => loadStep(tempStep("name: x\ninputs: { bad-name: {} }\nrun: { module: m.ts }\n"))).toThrow(/\/inputs/);
  });

  it("reports a missing prompt file and a missing step.yaml", () => {
    expect(() => loadStep(tempStep("name: x\nrun: { prompt: nope.md, output: {} }\n"))).toThrow(/nope\.md: ENOENT/);
    expect(() => loadStep(mkdtempSync(join(tmpdir(), "sous-empty-")))).toThrow(/step\.yaml: ENOENT/);
  });

  it("reports invalid YAML with the file", () => {
    expect(() => loadStep(tempStep("name: [\n"))).toThrow(/step\.yaml: invalid YAML/);
  });
});
