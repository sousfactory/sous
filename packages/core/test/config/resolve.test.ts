import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { flowLabelsOf, resolveFlow } from "../../src/config/resolve.js";

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
      message: "flows feature, task all accept it: the issue carries labels of several flows (type:task, type:feature); keep one",
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

  it("blames the flows when a shared label stays ambiguous, even beside a second kind only one flow declares", () => {
    const flows = [...FLOWS, { name: "hotfix", allowedLabels: ["type:bug"] }];
    expect(resolveFlow(["type:bug", "type:feature"], flows)).toMatchObject({ cause: "flows", message: expect.stringContaining("several flows declare type:bug") });
  });

  it("blames the issue when its labels, of any prefix, each point at a different flow", () => {
    const flows = [...FLOWS, { name: "api", allowedLabels: ["area:api"] }];
    expect(resolveFlow(["type:task", "area:api"], flows)).toEqual({
      kind: "several",
      flows: ["api", "task"],
      cause: "kinds",
      message: "flows api, task all accept it: the issue carries labels of several flows (type:task, area:api); keep one",
    });
  });
});

describe("flowLabelsOf", () => {
  let dir: string;
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("reads name, file and allowedLabels of every .yaml and .yml flow, without the flow schema", async () => {
    dir = await mkdtemp(join(tmpdir(), "sous-flows-"));
    await writeFile(join(dir, "task.yaml"), "entry: a\nallowedLabels: [type:task]\nsteps: []\n");
    await writeFile(join(dir, "hop.yml"), "entry: a\nallowedLabels: [type:hop]\nunknownField: 1\n");
    await writeFile(join(dir, "bench.yaml"), "entry: a\n");
    expect(flowLabelsOf(dir)).toEqual([
      { name: "bench", file: join(dir, "bench.yaml") },
      { name: "hop", file: join(dir, "hop.yml"), allowedLabels: ["type:hop"] },
      { name: "task", file: join(dir, "task.yaml"), allowedLabels: ["type:task"] },
    ]);
    expect(resolveFlow(["type:hop"], flowLabelsOf(dir))).toEqual({ kind: "flow", flow: "hop" });
  });

  it("is empty for a missing directory", () => {
    dir = join(tmpdir(), "sous-flows-none");
    expect(flowLabelsOf(dir)).toEqual([]);
  });
});
