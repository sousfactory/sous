/**
 * The flow graph: React Flow as a static canvas at zoom 1 (no pan, zoom
 * or drag), sized to the laid-out graph so a wide flow scrolls
 * sideways the way GitHub's does. Routes taken in this run are drawn solid
 * in the colour of the step they lead to; routes not taken are light grey.
 * Hovering a card works as on GitHub: its routes in and out turn blue and
 * every card that is not a direct neighbour fades. A `preview` draws a flow
 * without a run: every route solid grey, since none was taken or passed by.
 */
import { Handle, Position, ReactFlow, type Edge, type EdgeProps, type Node, type NodeHandle, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Status, StepEdge, StepNode } from "../../server/model";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH, type LaidEdge } from "../layout";
import { STATUS_COLOR } from "./StatusIcon";
import { StepCard } from "./StepCard";

/** How a card or route looks while a card is hovered: `on` touches it, `off` does not; no hover leaves everything plain. */
export type Focus = "on" | "off" | undefined;

/** The hovered card's focus: itself and its direct neighbours are on, and so are the routes that touch it. */
export const focusOf = (hovered: string | undefined, edges: readonly { from: string; to: string }[]) => {
  const touches = (e: { from: string; to: string }) => e.from === hovered || e.to === hovered;
  const near = new Set(hovered === undefined ? [] : [hovered, ...edges.filter(touches).flatMap((e) => [e.from, e.to])]);
  return {
    node: (id: string): Focus => (hovered === undefined ? undefined : near.has(id) ? "on" : "off"),
    edge: (e: { from: string; to: string }): Focus => (hovered === undefined ? undefined : touches(e) ? "on" : "off"),
  };
};

const ACCENT = "var(--fgColor-accent)";

/** The two handles of every card, as `StepNodeView` renders them: routes in on the left, out on the right. */
const HANDLES: NodeHandle[] = [
  { type: "target", position: Position.Left, x: 0, y: NODE_HEIGHT / 2 },
  { type: "source", position: Position.Right, x: NODE_WIDTH, y: NODE_HEIGHT / 2 },
];

type StepData = { node: StepNode; now: number; flow: string; focus: Focus };
type RouteData = { laid: LaidEdge; taken: boolean; status: Status; focus: Focus; preview: boolean };

const StepNodeView = ({ data }: NodeProps<Node<StepData>>) => (
  <div data-focus={data.focus} style={{ opacity: data.focus === "off" ? 0.45 : 1, transition: "opacity 120ms" }}>
    <Handle type="target" position={Position.Left} isConnectable={false} style={{ opacity: 0, pointerEvents: "none" }} />
    <StepCard node={data.node} now={data.now} flow={data.flow} />
    <Handle type="source" position={Position.Right} isConnectable={false} style={{ opacity: 0, pointerEvents: "none" }} />
  </div>
);

const Dot = ({ x, y, color, filled }: { x: number; y: number; color: string; filled: boolean }) => (
  <circle cx={x} cy={y} r={3.5} fill={filled ? color : "var(--bgColor-default)"} stroke={color} strokeWidth={1.5} />
);

const RouteEdgeView = ({ data, id }: EdgeProps<Edge<RouteData>>) => {
  if (data === undefined) return null;
  const { laid, taken, status, focus, preview } = data;
  const on = focus === "on";
  const solid = on || taken || preview;
  const color = on ? ACCENT : taken ? STATUS_COLOR[status === "queued" || status === "skipped" ? "skipped" : status] : "var(--borderColor-default)";
  return (
    <g data-testid={`edge-${laid.from}-${laid.to}`} data-taken={taken} data-focus={focus} opacity={focus === "off" ? 0.45 : 1} style={{ pointerEvents: "none" }}>
      <path id={id} d={laid.path} fill="none" stroke={color} strokeWidth={on || taken ? 2 : 1.5} strokeDasharray={solid ? undefined : "4 4"} opacity={taken && !on ? 0.85 : 1} />
      <Dot x={laid.start.x} y={laid.start.y} color={color} filled={on} />
      <Dot x={laid.end.x} y={laid.end.y} color={color} filled={on} />
    </g>
  );
};

const nodeTypes = { step: StepNodeView };
const edgeTypes = { route: RouteEdgeView };

export type FlowGraphProps = {
  nodes: StepNode[];
  edges: StepEdge[];
  now: number;
  flow: string;
  onOpen: (step: string) => void;
  preview?: boolean;
};

export const FlowGraph = ({ nodes, edges, now, flow, onOpen, preview = false }: FlowGraphProps) => {
  const shape = `${nodes.map((n) => n.id).join(",")}|${edges.map((e) => `${e.from}>${e.to}`).join(",")}`;
  // The layout depends on the shape only, so status updates never move a card.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => layoutGraph(nodes, edges), [shape]);
  const statusOf = new Map(nodes.map((n) => [n.id, n.status]));
  const scroller = useRef<HTMLDivElement>(null);
  const running = nodes.find((n) => n.status === "in_progress")?.id;
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const focus = focusOf(hovered, layout.edges);

  // Keep the running step in sight when the graph is wider than the page.
  useEffect(() => {
    const box = scroller.current;
    const laid = layout.nodes.find((n) => n.id === running);
    if (box === null || laid === undefined) return;
    if (laid.x < box.scrollLeft || laid.x + NODE_WIDTH > box.scrollLeft + box.clientWidth) box.scrollLeft = Math.max(0, laid.x - box.clientWidth / 3);
  }, [running, layout]);

  // Every render hands React Flow new node objects. One without a size and
  // handles counts as unmeasured: React Flow hides the card (the hover drops,
  // it flickers) and the routes at it until a re-measure that may never come.
  // The cards have a fixed size and handles, so both are given up front.
  const flowNodes: Node<StepData>[] = layout.nodes.flatMap((laid) => {
    const node = nodes.find((n) => n.id === laid.id);
    return node === undefined
      ? []
      : [{ id: laid.id, type: "step", position: { x: laid.x, y: laid.y }, width: NODE_WIDTH, height: NODE_HEIGHT, handles: HANDLES, data: { node, now, flow, focus: focus.node(laid.id) }, draggable: false, connectable: false, selectable: false, ariaLabel: `${laid.id}: ${node.status}` }];
  });
  // Lit routes come last so they paint over the rest of their layer. The layer
  // itself never changes on hover: a route lifted above the cards would take
  // the pointer from the hovered card and make the hover flicker.
  const ordered = [...layout.edges].sort((a, b) => Number(focus.edge(a) === "on") - Number(focus.edge(b) === "on"));
  const flowEdges: Edge<RouteData>[] = ordered.map((laid) => ({
    id: `${laid.from}->${laid.to}`,
    source: laid.from,
    target: laid.to,
    type: "route",
    selectable: false,
    focusable: false,
    zIndex: edges.find((e) => e.from === laid.from && e.to === laid.to)?.taken === true ? 1 : 0,
    data: { laid, taken: edges.find((e) => e.from === laid.from && e.to === laid.to)?.taken === true, status: statusOf.get(laid.to) ?? "skipped", focus: focus.edge(laid), preview },
  }));

  return (
    <div ref={scroller} className="overflow-x-auto" data-testid="flow-graph">
      <div style={{ width: layout.width, height: layout.height }}>
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          minZoom={1}
          maxZoom={1}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          onNodeClick={(_event, node) => onOpen(node.id)}
          onNodeMouseEnter={(_event, node) => setHovered(node.id)}
          onNodeMouseLeave={() => setHovered(undefined)}
          proOptions={{ hideAttribution: true }}
          style={{ background: "transparent" }}
        />
      </div>
    </div>
  );
};
