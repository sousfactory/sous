/**
 * A flow file drawn without a run, above the flow's runs: the graph as a
 * run shows it, every step queued and every route solid grey. A click on a
 * card opens the step below the graph: what it uses and does, and its routes.
 */
import { XIcon } from "@primer/octicons-react";
import { Flash } from "@primer/react";
import type { FlowView } from "../../server/model";
import { useJson, useVersion } from "../live";
import { shortModel } from "./StepCard";
import { FlowGraph } from "./FlowGraph";
import { KIND_WORD, Routes, withParts } from "./StepView";

export type FlowPreviewProps = { flow: string; step: string | undefined; onStep: (step: string | undefined) => void; now: number };

export const FlowPreview = ({ flow, step, onStep, now }: FlowPreviewProps) => {
  const fetched = useJson<FlowView>(`/api/flows/${encodeURIComponent(flow)}`, useVersion());
  const view = fetched.data?.name === flow ? fetched.data : undefined;
  if (fetched.error !== undefined) return <Flash variant="danger" className="mb-6">flows/{flow}.yaml: {fetched.error}</Flash>;
  if (view === undefined) return null;
  if (view.error !== undefined) return <Flash variant="warning" className="mb-6">flows/{flow}.yaml could not be read: {view.error}</Flash>;

  const node = view.nodes.find((n) => n.id === step);
  const detail = node !== undefined ? view.details[node.id] : undefined;
  return (
    <div className="mb-6 overflow-hidden rounded-md border border-line" data-testid="flow-preview">
      <div className="flex items-baseline gap-2 border-b border-line bg-canvas px-4 py-3">
        <span className="font-semibold">{flow}.yaml</span>
        <span className="text-[12px] text-fg-muted">
          {view.nodes.length} step{view.nodes.length === 1 ? "" : "s"}
          {view.entry !== undefined ? ` · starts at ${view.entry}` : ""}
        </span>
        <span className="ml-auto text-[12px] text-fg-muted">Preview</span>
      </div>
      <div className="bg-canvas-muted">
        <FlowGraph nodes={view.nodes} edges={view.edges} now={now} flow={flow} onOpen={(id) => onStep(id === step ? undefined : id)} preview />
      </div>
      {node !== undefined && detail !== undefined ? (
        <div className="border-t border-line bg-canvas px-4 pt-3" data-testid="flow-step">
          <div className="mb-2 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h3 className="m-0 text-[16px] font-semibold">{node.id}</h3>
              <div className="text-[12px] text-fg-muted">
                {"uses "}
                <code className="font-mono">{detail.uses}</code>
                {node.kind !== undefined ? ` · ${KIND_WORD[node.kind]}${withParts(node)}` : ""}
                {node.agent !== undefined ? ` · ${node.agent.kind} ${shortModel(node.agent.model)}` : ""}
              </div>
            </div>
            <button type="button" aria-label="Close step" onClick={() => onStep(undefined)} className="cursor-pointer border-0 bg-transparent p-1 text-fg-muted hover:text-fg">
              <XIcon size={16} />
            </button>
          </div>
          {detail.description !== undefined ? <p className="mb-3 text-[14px]">{detail.description}</p> : null}
          {detail.routes.length > 0 ? <Routes routes={detail.routes} /> : null}
        </div>
      ) : null}
    </div>
  );
};
