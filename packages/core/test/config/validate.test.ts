import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listFlows, validateFlowFile, validateProject, type Rule, type ValidationError } from "../../src/config/validate.js";
import { fixture, invalidOptions, options } from "../helpers.js";

const invalid = (name: string): ValidationError[] => validateFlowFile(fixture("invalid", "flows", `${name}.yaml`), invalidOptions);
const rulesOf = (errors: ValidationError[]): Rule[] => [...new Set(errors.map((e) => e.rule))].sort();

describe("validateFlowFile", () => {
  it("passes the good fixture", () => {
    expect(validateFlowFile(fixture("project", "flows", "good.yaml"), options)).toEqual([]);
  });

  it.each<[string, Rule[], RegExp]>([
    ["entry-unknown", ["entry"], /entry "nope" names no step id/],
    ["route-target", ["done-reachable", "route-target"], /route to "nowhere" names no step id, done or blocked/],
    ["unreachable", ["reachable"], /step is not reachable from entry "merge"/],
    ["done-unreachable", ["done-reachable"], /"done" is not reachable/],
    ["uses-unresolved", ["uses"], /uses "does-not-exist" does not resolve to a step folder/],
    ["uses-path", ["uses"], /uses "\.\.\/steps\/merge" must be a step name under stepsDir, not a path/],
    ["step-invalid", ["step"], /bad-yaml\/step\.yaml: .*required property 'name'/],
    ["bang", ["step"], /prompt contains a shell sequence/],
    ["no-run", ["step"], /no-run\/step\.yaml: neither run nor eval/],
    ["output-schema", ["output-schema"], /run\.output is not a valid JSON Schema: schema is invalid/],
    ["placeholders", ["placeholders"], /placeholder \{\{undeclared\}\} is not a declared input/],
    ["prepared", ["output-schema", "placeholders"], /prepare\.output is not a valid JSON Schema[\s\S]*placeholder \{\{prepared\.nope\}\} is not a declared input or a property of prepare\.output/],
    ["with-missing", ["with"], /required input "task" of build is not in with/],
    ["with-unknown", ["with"], /with names "extra", which is not an input of build/],
    ["agent-missing", ["agent"], /build is agentic; agent is required/],
    ["agent-extra", ["agent"], /merge is deterministic; agent must be absent/],
    ["expr-when", ["expression"], /routes\[0\]\.when: cannot compile expression `res\.ok &&`/],
    ["expr-with", ["expression"], /with\.commits: cannot compile expression ` steps\.build\.commits\[ `/],
    ["expr-resume", ["expression"], /resume: cannot compile expression ` steps\.build\?\. `/],
    ["routes-coverage", ["routes-coverage"], /the last route must be an else, or every when must be the literal true/],
    ["else-not-last", ["routes-coverage"], /unconditional route to "blocked" must be the last route/],
    ["gate", ["gate"], /gate is not supported yet/],
    ["duplicate-id", ["duplicate-id"], /id "merge" is used more than once/],
    ["route-shape", ["route-shape", "routes-coverage"], /route to "done" has both when and else/],
    ["not-yaml", ["flow"], /invalid YAML/],
    ["bad-shape", ["flow"], /must have required property 'uses'/],
  ])("%s fails rule(s) %j", (name, rules, message) => {
    const errors = invalid(name);
    expect(rulesOf(errors)).toEqual(rules);
    expect(errors.map((e) => e.message).join("\n")).toMatch(message);
    for (const e of errors) expect(e.file).toBe(fixture("invalid", "flows", `${name}.yaml`));
  });

  it("names the entry id on entry-level errors and omits it on flow-level ones", () => {
    expect(invalid("gate")[0]?.id).toBe("merge");
    expect(invalid("route-target").map((e) => e.id)).toEqual([undefined, "merge"]);
    expect(invalid("not-yaml")[0]?.id).toBeUndefined();
  });

  it("reports the unused input direction of the placeholder check", () => {
    expect(invalid("placeholders").map((e) => e.message)).toEqual([
      expect.stringMatching(/\{\{undeclared\}\} is not a declared input/),
      expect.stringMatching(/input "declared" has no placeholder in the prompt/),
    ]);
  });

  it("collects every error instead of stopping at the first", () => {
    expect(invalid("route-target").map((e) => e.rule)).toEqual(["done-reachable", "route-target"]);
    expect(invalid("entry-unknown").map((e) => e.rule)).toEqual(["entry"]);
  });
});

describe("validateProject", () => {
  it("passes the fixture project", () => {
    const report = validateProject(fixture("project"));
    expect(report.errors).toEqual([]);
    expect(report.flows).toEqual([fixture("project", "flows", "good.yaml")]);
    expect(report.note).toBeUndefined();
  });

  it("reports a broken sous.yaml under the settings rule", () => {
    const report = validateProject(fixture("bad-settings"));
    expect(report.errors).toEqual([expect.objectContaining({ file: fixture("bad-settings", "sous.yaml"), rule: "settings" })]);
    expect(report.note).toMatch(/no flows under/);
  });

  it("validates fine with a note when flows/ is missing or empty", () => {
    const root = mkdtempSync(join(tmpdir(), "sous-root-"));
    expect(validateProject(root)).toEqual({ errors: [], flows: [], note: `no flows under ${join(root, "flows")}; nothing to validate` });
    mkdirSync(join(root, "flows"));
    writeFileSync(join(root, "flows", "notes.txt"), "ignored");
    expect(validateProject(root).note).toMatch(/nothing to validate/);
  });

  it("checks every flow file of the invalid fixture and attributes errors to its file", () => {
    const report = validateProject(fixture("invalid"));
    expect(report.flows.length).toBe(listFlows(fixture("invalid", "flows")).length);
    for (const file of report.flows) expect(report.errors.some((e) => e.file === file)).toBe(true);
  });
});

describe("listFlows", () => {
  it("lists .yaml and .yml files sorted and nothing else", () => {
    const root = mkdtempSync(join(tmpdir(), "sous-list-"));
    mkdirSync(join(root, "flows"));
    for (const f of ["b.yml", "a.yaml", "README.md"]) writeFileSync(join(root, "flows", f), "");
    expect(listFlows(join(root, "flows"))).toEqual([join(root, "flows", "a.yaml"), join(root, "flows", "b.yml")]);
  });
});
