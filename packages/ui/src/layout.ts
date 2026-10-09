/**
 * Lays the state machine out left to right with dagre. Connectors are drawn
 * as GitHub draws them: straight runs with small rounded corners, from the
 * right edge of one card to the left edge of the next, turning in the gap
 * between columns; a route that skips columns runs along dagre's free lane. A route
 * back to an earlier column (review ⇄ fix) also leaves on the right and
 * enters on the left: it swings round the cards it spans, in a lane above
 * or below them.
 */
import dagre from "@dagrejs/dagre";

export const NODE_WIDTH = 236;
export const NODE_HEIGHT = 40;
const MARGIN = 24;
const RANK_GAP = 48;
/** Corner radius of every connector. */
const CORNER = 8;
/** How far a loop runs out past a card's edge before turning. */
const LOOP_RADIUS = 16;
/** Gap between a loop's lane and the cards it passes. */
const LOOP_GAP = 18;
const LANE_STEP = 10;

type Point = { x: number; y: number };

export type LaidNode = { id: string; x: number; y: number };
export type LaidEdge = { from: string; to: string; back: boolean; path: string; start: Point; end: Point };
export type Layout = { nodes: LaidNode[]; edges: LaidEdge[]; width: number; height: number };

/** Drops points that repeat or lie on a straight run between their neighbours. */
const simplify = (points: Point[]): Point[] => {
  const out: Point[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.x === p.x && prev.y === p.y) continue;
    const before = out[out.length - 2];
    if (prev !== undefined && before !== undefined && ((before.x === prev.x && prev.x === p.x) || (before.y === prev.y && prev.y === p.y))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
};

/** Straight segments through `points` with every corner rounded to `CORNER`, as GitHub draws its connectors. */
export const rounded = (input: Point[]): string => {
  const points = simplify(input);
  const [first] = points;
  if (first === undefined) return "";
  let d = `M ${first.x} ${first.y}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const prev = points[i - 1]!;
    const next = points[i + 1];
    if (next === undefined) {
      d += ` L ${p.x} ${p.y}`;
      break;
    }
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y);
    const outLen = Math.hypot(next.x - p.x, next.y - p.y);
    const r = Math.min(CORNER, inLen / 2, outLen / 2);
    const from = { x: p.x - ((p.x - prev.x) / inLen) * r, y: p.y - ((p.y - prev.y) / inLen) * r };
    const to = { x: p.x + ((next.x - p.x) / outLen) * r, y: p.y + ((next.y - p.y) / outLen) * r };
    d += ` L ${from.x} ${from.y} Q ${p.x} ${p.y} ${to.x} ${to.y}`;
  }
  return d;
};

export const layoutGraph = (nodes: readonly { id: string }[], edges: readonly { from: string; to: string }[]): Layout => {
  const g = new dagre.graphlib.Graph({ multigraph: false });
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: RANK_GAP, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) if (g.hasNode(e.from) && g.hasNode(e.to) && e.from !== e.to) g.setEdge(e.from, e.to);
  dagre.layout(g);

  const centre = new Map(nodes.map((n) => [n.id, g.node(n.id) as { x: number; y: number }]));
  const laidNodes = nodes.map((n) => {
    const c = centre.get(n.id) ?? { x: 0, y: 0 };
    return { id: n.id, x: c.x - NODE_WIDTH / 2, y: c.y - NODE_HEIGHT / 2 };
  });

  type Geometry = { from: string; to: string; back: boolean; start: Point; end: Point; build: (dy: number) => string };
  const geometry: Geometry[] = [];
  const lanes: { side: "above" | "below"; y: number; left: number; right: number }[] = [];
  for (const e of edges) {
    const a = centre.get(e.from);
    const b = centre.get(e.to);
    if (a === undefined || b === undefined || e.from === e.to) continue;
    const start = { x: a.x + NODE_WIDTH / 2, y: a.y };
    const end = { x: b.x - NODE_WIDTH / 2, y: b.y };
    if (b.x >= a.x) {
      // Turn in the middle of the gap after the source and before the target;
      // a route that skips columns runs along the lane dagre kept free for it.
      const bends = ((g.edge(e.from, e.to) as { points?: Point[] } | undefined)?.points ?? []).slice(1, -1).filter((p) => p.x > start.x && p.x < end.x);
      const out = start.x + RANK_GAP / 2;
      const into = end.x - RANK_GAP / 2;
      const lane = bends.length > 0 ? bends.reduce((sum, p) => sum + p.y, 0) / bends.length : end.y;
      const route = [start, { x: out, y: start.y }, { x: out, y: lane }, { x: into, y: lane }, { x: into, y: end.y }, end];
      geometry.push({ from: e.from, to: e.to, back: false, start, end, build: (dy) => rounded(route.map((p) => ({ x: p.x, y: p.y + dy }))) });
      continue;
    }
    // A route back: out of the source's right edge, round the cards in its
    // span (above when the source sits higher, else below), in at the
    // target's left edge. Overlapping loops on one side get their own lane.
    const side = a.y <= b.y ? "above" : "below";
    const left = end.x;
    const right = start.x;
    const spanned = laidNodes.filter((n) => n.x + NODE_WIDTH >= left && n.x <= right);
    const edgeY = side === "above" ? Math.min(...spanned.map((n) => n.y)) : Math.max(...spanned.map((n) => n.y + NODE_HEIGHT));
    const stacked = lanes.filter((l) => l.side === side && l.left < right && l.right > left).length;
    const lane = side === "above" ? edgeY - LOOP_GAP - stacked * LANE_STEP : edgeY + LOOP_GAP + stacked * LANE_STEP;
    lanes.push({ side, y: lane, left, right });
    geometry.push({
      from: e.from,
      to: e.to,
      back: true,
      start,
      end,
      build: (dy) =>
        rounded([
          { x: start.x, y: start.y + dy },
          { x: start.x + LOOP_RADIUS, y: start.y + dy },
          { x: start.x + LOOP_RADIUS, y: lane + dy },
          { x: end.x - LOOP_RADIUS, y: lane + dy },
          { x: end.x - LOOP_RADIUS, y: end.y + dy },
          { x: end.x, y: end.y + dy },
        ]),
    });
  }

  // Loops above the top row push everything down so they stay on the canvas.
  const top = Math.min(MARGIN, ...lanes.filter((l) => l.side === "above").map((l) => l.y));
  const dy = MARGIN - top;
  const bottom = Math.max(0, ...laidNodes.map((n) => n.y + NODE_HEIGHT), ...lanes.filter((l) => l.side === "below").map((l) => l.y)) + dy;
  const shift = (p: Point): Point => ({ x: p.x, y: p.y + dy });
  const laidEdges: LaidEdge[] = geometry.map((e) => ({ from: e.from, to: e.to, back: e.back, start: shift(e.start), end: shift(e.end), path: e.build(dy) }));

  const graph = g.graph() as { width?: number; height?: number };
  return {
    nodes: laidNodes.map((n) => ({ ...n, y: n.y + dy })),
    edges: laidEdges,
    width: Math.ceil((graph.width ?? 0) + LOOP_RADIUS),
    height: Math.ceil(Math.max((graph.height ?? 0) + dy, bottom + MARGIN)),
  };
};
