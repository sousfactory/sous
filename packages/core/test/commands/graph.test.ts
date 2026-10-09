import { describe, expect, it } from "vitest";
import { graphCommand, graphEdges, nodeId, renderGraph, shapeOf, shorten, topology } from "../../src/commands/graph.js";
import { parseFlow } from "../../src/config/flow.js";
import { loadStep } from "../../src/config/step.js";
import { fixture, io, projectSteps } from "../helpers.js";

const good = parseFlow(fixture("project", "flows", "good.yaml"));

describe("renderGraph", () => {
  it("renders the good fixture as a Mermaid stateDiagram-v2", () => {
    expect(renderGraph(good)).toBe(
      [
        "stateDiagram-v2",
        '    state "sync" as sync',
        "    sync : deterministic",
        '    state "build" as build',
        "    build : agentic (claude)",
        '    state "review" as review',
        "    review : agentic (codex)",
        '    state "fix" as fix',
        "    fix : agentic (claude)",
        '    state "merge" as merge',
        "    merge : deterministic",
        '    state "done" as done',
        "    done : terminal",
        '    state "blocked" as blocked',
        "    blocked : terminal",
        "    [*] --> sync",
        "    sync --> blocked : result.output.conflict",
        "    sync --> build",
        "    build --> review",
        "    build --> blocked : exhausted",
        "    review --> merge : res.ok",
        "    review --> blocked : steps.review.visits >= 3",
        "    review --> fix",
        "    review --> blocked : exhausted",
        "    fix --> review : true",
        "    fix --> blocked : exhausted",
        "    merge --> done : true",
        "    done --> [*]",
        "    blocked --> [*]",
      ].join("\n"),
    );
  });

  it("draws an eval-only entry (no agent) as deterministic, without an exhausted edge", () => {
    const feature = parseFlow(fixture("graph", "feature.yaml"));
    const out = renderGraph(feature).split("\n");
    expect(out).toContain("    verify : deterministic");
    expect(graphEdges(feature).filter((e) => e.from === "verify")).toEqual([
      { from: "verify", to: "review-full", label: "res.ok" },
      { from: "verify", to: "fix-full" },
    ]);
  });

  it("aliases ids with hyphens and omits a terminal nobody reaches", () => {
    const out = renderGraph({
      name: "x",
      file: "/x.yaml",
      entry: "next-work",
      steps: [{ id: "next-work", uses: "next-work", with: {}, routes: [{ to: "done", else: true }] }],
    }).split("\n");
    expect(out).toContain('    state "next-work" as next_work');
    expect(out).toContain("    [*] --> next_work");
    expect(out).toContain("    next_work --> done");
    expect(out.some((l) => l.includes("blocked"))).toBe(false);
  });
});

describe("topology", () => {
  it("lists the steps as nodes and keeps full conditions on the edges", () => {
    const t = topology(good);
    expect(t.entry).toBe("sync");
    expect(t.nodes).toEqual([
      { id: "sync", uses: "sync" },
      { id: "build", uses: "build", agent: { kind: "claude", model: "claude-opus-5-5" } },
      { id: "review", uses: "review", agent: { kind: "codex", model: "gpt-5.5" } },
      { id: "fix", uses: "build", agent: { kind: "claude", model: "claude-opus-5-5" } },
      { id: "merge", uses: "merge" },
    ]);
    expect(t.edges.filter((e) => e.from === "review")).toEqual([
      { from: "review", to: "merge", when: "res.ok" },
      { from: "review", to: "blocked", when: "steps.review.visits >= 3" },
      { from: "review", to: "fix" },
      { from: "review", to: "blocked", exhausted: true },
    ]);
  });

  it("adds each step's kind and eval gate from stepsDir, and leaves them out for a step that does not load", () => {
    const shapes = topology(good, projectSteps).nodes.map(({ id, kind, evalGate }) => ({ id, kind, evalGate }));
    expect(shapes).toEqual([
      { id: "sync", kind: "module", evalGate: undefined },
      { id: "build", kind: "prompt", evalGate: true },
      { id: "review", kind: "prompt", evalGate: true },
      { id: "fix", kind: "prompt", evalGate: true },
      { id: "merge", kind: "module", evalGate: undefined },
    ]);
    const lost = topology({ ...good, steps: [{ id: "a", uses: "nope", with: {}, routes: [{ to: "done" }] }, { id: "b", uses: "../x", with: {}, routes: [{ to: "done" }] }] }, projectSteps);
    expect(lost.nodes).toEqual([{ id: "a", uses: "nope" }, { id: "b", uses: "../x" }]);
  });

  it("adds each step's description from its step.yaml", () => {
    const build = topology(good, projectSteps).nodes.find((n) => n.id === "build");
    expect(build?.description).toMatch(/\S/);
  });

  it("marks a prompt step with a prepare", () => {
    expect(shapeOf(loadStep(fixture("exec", "steps", "prepared")))).toEqual({ kind: "prompt", prepare: true, evalGate: true });
  });

  it("calls an eval-only step kind eval, without a separate gate", () => {
    expect(shapeOf(loadStep(fixture("exec", "steps", "eval-only")))).toEqual({ kind: "eval" });
  });

  it("keeps a condition longer than the Mermaid label whole", () => {
    const when = "x".repeat(60);
    const t = topology({ name: "x", file: "/x.yaml", entry: "a", steps: [{ id: "a", uses: "a", with: {}, routes: [{ to: "done", when }, { to: "blocked" }] }] });
    expect(t.edges[0]).toEqual({ from: "a", to: "done", when });
  });
});

describe("graphEdges", () => {
  it("adds the exhausted edge for agentic entries only", () => {
    const exhausted = graphEdges(good).filter((e) => e.label === "exhausted").map((e) => e.from);
    expect(exhausted).toEqual(["build", "review", "fix"]);
  });
});

describe("shorten", () => {
  it("flattens whitespace, softens semicolons and cuts long conditions", () => {
    expect(shorten("  a &&\n   b ")).toBe("a && b");
    expect(shorten("a; b")).toBe("a, b");
    expect(shorten("x".repeat(60))).toBe(`${"x".repeat(39)}…`);
    expect(shorten("x".repeat(40))).toBe("x".repeat(40));
  });
});

describe("nodeId", () => {
  it("replaces every hyphen", () => {
    expect(nodeId("review-full-again")).toBe("review_full_again");
  });
});

describe("graphCommand", () => {
  it("prints the graph of a known flow", async () => {
    const { deps, out, err } = io();
    expect(await graphCommand(["good"], { root: fixture("project"), ...deps })).toBe(0);
    expect(out.join("\n")).toBe(renderGraph(good));
    expect(err).toEqual([]);
  });

  it("exits 2 with usage and the known flows for a missing or unknown name or extra arguments", async () => {
    for (const args of [[], ["nope"], ["good", "extra"]]) {
      const { deps, out, err } = io();
      expect(await graphCommand(args, { root: fixture("project"), ...deps })).toBe(2);
      expect(out).toEqual([]);
      expect(err).toEqual(["usage: sous graph <flow> (known: good)"]);
    }
  });

  it("exits 2 with the parse error for a flow that does not parse", async () => {
    const { deps, err } = io();
    expect(await graphCommand(["not-yaml"], { root: fixture("invalid"), ...deps })).toBe(2);
    expect(err[0]).toMatch(/not-yaml\.yaml: invalid YAML/);
  });
});
