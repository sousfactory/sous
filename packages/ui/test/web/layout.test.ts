import { describe, expect, it } from "vitest";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH, rounded } from "../../src/layout";

const ids = (...names: string[]) => names.map((id) => ({ id }));

describe("layoutGraph", () => {
  it("lays a chain out left to right in order", () => {
    const layout = layoutGraph(ids("init", "implement", "merge"), [
      { from: "init", to: "implement" },
      { from: "implement", to: "merge" },
    ]);
    const x = Object.fromEntries(layout.nodes.map((n) => [n.id, n.x]));
    expect(x["init"]!).toBeLessThan(x["implement"]!);
    expect(x["implement"]!).toBeLessThan(x["merge"]!);
    expect(layout.width).toBeGreaterThanOrEqual(3 * NODE_WIDTH);
    expect(layout.edges.every((e) => !e.back)).toBe(true);
  });

  it("joins a forward route from the right edge of one card to the left edge of the next", () => {
    const layout = layoutGraph(ids("a", "b"), [{ from: "a", to: "b" }]);
    const [a, b] = layout.nodes;
    const [edge] = layout.edges;
    expect(edge?.start).toEqual({ x: a!.x + NODE_WIDTH, y: a!.y + NODE_HEIGHT / 2 });
    expect(edge?.end).toEqual({ x: b!.x, y: b!.y + NODE_HEIGHT / 2 });
  });

  it("marks exactly one direction of a review ⇄ fix loop as the back edge", () => {
    const layout = layoutGraph(ids("review", "fix", "merge"), [
      { from: "review", to: "fix" },
      { from: "fix", to: "review" },
      { from: "review", to: "merge" },
    ]);
    const loop = layout.edges.filter((e) => (e.from === "review" && e.to === "fix") || (e.from === "fix" && e.to === "review"));
    expect(loop.filter((e) => e.back)).toHaveLength(1);
    expect(layout.edges.every((e) => e.path.startsWith("M "))).toBe(true);
  });

  it("takes every route, a loop back included, out on the right and in on the left", () => {
    const layout = layoutGraph(ids("review", "fix", "merge"), [
      { from: "review", to: "fix" },
      { from: "fix", to: "review" },
      { from: "review", to: "merge" },
    ]);
    const at = Object.fromEntries(layout.nodes.map((n) => [n.id, n]));
    for (const e of layout.edges) {
      expect(e.start).toEqual({ x: at[e.from]!.x + NODE_WIDTH, y: at[e.from]!.y + NODE_HEIGHT / 2 });
      expect(e.end).toEqual({ x: at[e.to]!.x, y: at[e.to]!.y + NODE_HEIGHT / 2 });
    }
  });

  it("keeps a loop's lane clear of the cards and on the canvas", () => {
    const layout = layoutGraph(ids("review", "fix"), [
      { from: "review", to: "fix" },
      { from: "fix", to: "review" },
    ]);
    const back = layout.edges.find((e) => e.back)!;
    const ys = [...back.path.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter((_, i) => i % 2 === 1);
    const lane = Math.min(...ys);
    const lowest = Math.max(...ys);
    const tops = layout.nodes.map((n) => n.y);
    const bottoms = layout.nodes.map((n) => n.y + NODE_HEIGHT);
    expect(lane < Math.min(...tops) || lowest > Math.max(...bottoms)).toBe(true);
    expect(lane).toBeGreaterThanOrEqual(0);
    expect(lowest).toBeLessThanOrEqual(layout.height);
  });

  it("places a node without edges and ignores edges to unknown nodes", () => {
    const layout = layoutGraph(ids("a", "orphan"), [{ from: "a", to: "done" }]);
    expect(layout.nodes.map((n) => n.id)).toEqual(["a", "orphan"]);
    expect(layout.edges).toEqual([]);
  });
});

describe("rounded", () => {
  it("draws straight runs and rounds each corner with a small radius", () => {
    expect(rounded([{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 40 }, { x: 48, y: 40 }])).toBe("M 0 0 L 16 0 Q 24 0 24 8 L 24 32 Q 24 40 32 40 L 48 40");
  });

  it("is a single straight line when nothing turns", () => {
    expect(rounded([{ x: 0, y: 5 }, { x: 24, y: 5 }, { x: 24, y: 5 }, { x: 60, y: 5 }])).toBe("M 0 5 L 60 5");
  });

  it("shrinks the radius on a short run so corners never overlap", () => {
    expect(rounded([{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 6 }, { x: 48, y: 6 }])).toBe("M 0 0 L 21 0 Q 24 0 24 3 L 24 3 Q 24 6 27 6 L 48 6");
  });
});
