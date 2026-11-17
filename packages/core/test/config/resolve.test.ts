import { describe, expect, it } from "vitest";
import { resolveFlow } from "../../src/config/resolve.js";

const FLOWS = [
  { name: "bench" },
  { name: "feature", allowedLabels: ["type:feature"] },
  { name: "task", allowedLabels: ["type:task", "type:bug"] },
];

describe("resolveFlow", () => {
  it("answers the one flow that declares the issue's kind", () => {
    expect(resolveFlow(["type:bug", "sous:ready"], FLOWS)).toEqual({ kind: "flow", flow: "task" });
  });

  it("answers none for an issue without a kind, naming its labels, even beside a flow without allowedLabels", () => {
    expect(resolveFlow(["sous:ready"], FLOWS)).toEqual({
      kind: "none",
      labels: ["sous:ready"],
      message: "no flow accepts its labels (sous:ready); give it the type:* label of one flow's allowedLabels",
    });
  });

  it("answers none for a kind no flow declares, and for an issue without labels", () => {
    expect(resolveFlow(["type:epic"], FLOWS)).toMatchObject({ kind: "none", message: expect.stringMatching(/^no flow accepts its labels \(type:epic\)/) });
    expect(resolveFlow([], FLOWS)).toMatchObject({ kind: "none", message: expect.stringMatching(/^no flow accepts an issue without labels/) });
  });

  it("never resolves to a flow without allowedLabels, even when it is the only flow", () => {
    expect(resolveFlow(["type:task"], [{ name: "bench" }])).toMatchObject({ kind: "none" });
  });

  it("answers several when the issue carries two kinds two flows declare, and says the issue is the cause", () => {
    expect(resolveFlow(["type:task", "type:feature"], FLOWS)).toEqual({
      kind: "several",
      flows: ["feature", "task"],
      cause: "kinds",
      message: "flows feature, task all accept it: the issue carries several type:* labels (type:task, type:feature); keep one",
    });
  });

  it("answers several when two flows declare the issue's one kind, and says the flows are the cause", () => {
    const flows = [...FLOWS, { name: "hotfix", allowedLabels: ["type:bug"] }];
    expect(resolveFlow(["type:bug"], flows)).toEqual({
      kind: "several",
      flows: ["hotfix", "task"],
      cause: "flows",
      message: "flows hotfix, task all accept it: several flows declare type:bug in allowedLabels; keep it in one",
    });
  });
});
