import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acceptsLabels, loadFlow, parseFlow, flowName, resolveUses, STEP_NAME } from "../../src/config/flow.js";
import { fixture, invalidOptions, options, projectSteps } from "../helpers.js";

const good = fixture("project", "flows", "good.yaml");

describe("parseFlow", () => {
  it("parses entry and every entry field; with defaults to {}", () => {
    const p = parseFlow(good);
    expect(p.name).toBe("good");
    expect(p.file).toBe(good);
    expect(p.entry).toBe("sync");
    expect(p.steps.map((s) => s.id)).toEqual(["sync", "build", "review", "fix", "merge"]);
    const [sync, build, , fix] = p.steps;
    expect(sync?.with).toEqual({});
    expect(sync?.agent).toBeUndefined();
    expect(sync?.routes).toEqual([{ to: "blocked", when: "result.output.conflict" }, { to: "build", else: true }]);
    expect(build?.agent).toEqual({ kind: "claude", model: "claude-opus-5-5" });
    expect(build?.with).toEqual({ task: '${{ ctx.issue.title + "\\n\\n" + ctx.issue.body }}', verify: "./gradlew test" });
    expect(fix?.resume).toBe("${{ steps.fix?.session ?? steps.build.session }}");
    expect(fix?.maxIterations).toBe(2);
    expect(fix?.loop).toBe(true);
    expect(fix?.uses).toBe("build");
  });

  it("reads allowedLabels, absent when the flow names none; rejects an empty or non-string list", () => {
    expect(parseFlow(good)).not.toHaveProperty("allowedLabels");
    const dir = mkdtempSync(join(tmpdir(), "sous-labels-"));
    const flow = (labels: string): string => {
      const file = join(dir, "f.yaml");
      writeFileSync(file, `allowedLabels: ${labels}\nentry: a\nsteps:\n  - { id: a, uses: x, routes: [{ to: done }] }\n`);
      return file;
    };
    expect(parseFlow(flow("[type:task, type:bug]")).allowedLabels).toEqual(["type:task", "type:bug"]);
    expect(() => parseFlow(flow("[]"))).toThrow(/\/allowedLabels must NOT have fewer than 1 items/);
    expect(() => parseFlow(flow("[1]"))).toThrow(/\/allowedLabels\/0 must be string/);
  });

  it("acceptsLabels: any issue without allowedLabels, else one with at least one of them", () => {
    expect(acceptsLabels({}, [])).toBe(true);
    expect(acceptsLabels({ allowedLabels: ["type:task", "type:bug"] }, ["sous:running", "type:bug"])).toBe(true);
    expect(acceptsLabels({ allowedLabels: ["type:task"] }, ["type:feature"])).toBe(false);
    expect(acceptsLabels({ allowedLabels: ["type:task"] }, [])).toBe(false);
  });

  it("keeps gate so validate can reject it", () => {
    expect(parseFlow(fixture("invalid", "flows", "gate.yaml")).steps[0]?.gate).toBe("human");
  });

  it("names the file for schema violations", () => {
    expect(() => parseFlow(fixture("invalid", "flows", "bad-shape.yaml"))).toThrow(
      /bad-shape\.yaml: .*must have required property 'uses'.*agent\/kind must be equal to one of the allowed values.*routes must NOT have fewer than 1 items/,
    );
    expect(() => parseFlow(fixture("invalid", "flows", "not-yaml.yaml"))).toThrow(/not-yaml\.yaml: invalid YAML/);
  });

  it("rejects non-string with values and an else other than true", () => {
    const dir = mkdtempSync(join(tmpdir(), "sous-pipe-"));
    const file = join(dir, "p.yaml");
    writeFileSync(file, "entry: a\nsteps:\n  - id: a\n    uses: x\n    with: { n: 3 }\n    routes:\n      - to: done\n        else: false\n");
    expect(() => parseFlow(file)).toThrow(/with\/n must be string.*else must be equal to constant/);
  });
});

describe("resolveUses", () => {
  it("maps a step name to its folder under stepsDir", () => {
    expect(resolveUses("merge", "/repo/.sous/steps")).toBe("/repo/.sous/steps/merge");
  });

  it("accepts names, not paths", () => {
    for (const name of ["merge", "next-work", "close_work", "v2"]) expect(STEP_NAME.test(name), name).toBe(true);
    for (const uses of ["../steps/merge", "./merge", "core/merge", "/abs/merge", "-x", ""]) expect(STEP_NAME.test(uses), uses).toBe(false);
  });
});

describe("loadFlow", () => {
  it("attaches the loaded step to every entry", () => {
    const p = loadFlow(good, options);
    expect(p.steps.map((s) => s.step.name)).toEqual(["sync", "build", "review", "build", "merge"]);
    expect(p.steps[1]?.step.dir).toBe(join(projectSteps, "build"));
  });

  it("throws on the first step that does not load", () => {
    expect(() => loadFlow(fixture("invalid", "flows", "uses-unresolved.yaml"), invalidOptions)).toThrow(/does-not-exist\/step\.yaml: ENOENT/);
    expect(() => loadFlow(fixture("invalid", "flows", "step-invalid.yaml"), invalidOptions)).toThrow(/bad-yaml\/step\.yaml/);
  });
});

describe("flowName", () => {
  it("is the file name without extension", () => {
    expect(flowName("/x/flows/feature.yaml")).toBe("feature");
    expect(flowName("task.yml")).toBe("task");
  });
});
