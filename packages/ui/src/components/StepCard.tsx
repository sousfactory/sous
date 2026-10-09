import { AlertIcon, CodeIcon, ShieldCheckIcon, SparkleFillIcon, ToolsIcon } from "@primer/octicons-react";
import type { Phase, StepNode } from "../../server/model";
import { elapsed } from "../format";
import { NODE_HEIGHT, NODE_WIDTH } from "../layout";
import { StatusIcon } from "./StatusIcon";

/** `claude-opus-5-5` → `opus-5-5`; the vendor is in the tooltip. */
export const shortModel = (model: string): string => model.replace(/^claude-/, "");

type StepKind = NonNullable<StepNode["kind"]>;

/** Tooltips of the kind icons. */
const KIND_LABEL: Record<StepKind, string> = {
  prompt: "prompt: an agent does the work",
  module: "run: a module does the work",
  eval: "eval only: the eval is the work",
};

const GATE_LABEL = "eval gate: an eval judges the run; a failure retries or routes";

const PREPARE_LABEL = "prepare: a module runs before the agent and decides whether it runs";

/** An icon lights up while the part it stands for runs, so the card shows the current phase. */
const iconClass = (active: boolean): string => `flex shrink-0 ${active ? "text-fg-attention" : "text-fg-muted"}`;

/** An eval-only step's work is its eval. A faded sparkle means the latest visit's prepare skipped the agent. */
const KindIcon = ({ kind, phase, skipped }: { kind: StepKind; phase: Phase | undefined; skipped: StepNode["agentSkipped"] }) => {
  const Icon = kind === "prompt" ? SparkleFillIcon : kind === "module" ? CodeIcon : ShieldCheckIcon;
  const active = phase === (kind === "eval" ? "eval" : "work");
  const title = skipped !== undefined ? `${KIND_LABEL[kind]}; prepare skipped the agent${skipped.reason !== undefined ? `: ${skipped.reason}` : ""}` : KIND_LABEL[kind];
  return (
    <span data-testid={`kind-${kind}`} data-active={active} data-skipped={skipped !== undefined} title={title} className={`${iconClass(active)}${skipped !== undefined ? " opacity-40" : ""}`}>
      <Icon size={14} />
    </span>
  );
};

const PrepareIcon = ({ phase }: { phase: Phase | undefined }) => (
  <span data-testid="prepare" data-active={phase === "prepare"} title={PREPARE_LABEL} className={iconClass(phase === "prepare")}>
    <ToolsIcon size={14} />
  </span>
);

const GateIcon = ({ phase }: { phase: Phase | undefined }) => (
  <span data-testid="eval-gate" data-active={phase === "eval"} title={GATE_LABEL} className={iconClass(phase === "eval")}>
    <ShieldCheckIcon size={14} />
  </span>
);

export const StepCard = ({ node, now, flow }: { node: StepNode; now: number; flow: string }) => {
  const duration = node.status === "queued" || node.status === "skipped" ? undefined : elapsed(node.startedAt, node.endedAt, now);
  return (
    <div
      data-testid={`step-${node.id}`}
      data-status={node.status}
      className="sous-tip-host relative flex cursor-pointer items-center gap-2 rounded-md bg-canvas px-3 text-[14px] hover:bg-canvas-muted"
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        border: `1px ${node.unknown === true ? "dashed" : "solid"} var(--borderColor-default)`,
        boxShadow: "var(--shadow-resting-small, 0 1px 0 rgba(31,35,40,0.04))",
      }}
    >
      {/* The full name, which the card may truncate, in GitHub's tooltip; CSS shows it on hover. */}
      <span role="tooltip" className="sous-tip">
        {node.id}
      </span>
      <StatusIcon status={node.status} />
      {node.prepare === true ? <PrepareIcon phase={node.phase} /> : null}
      {node.kind !== undefined ? <KindIcon kind={node.kind} phase={node.phase} skipped={node.agentSkipped} /> : null}
      {node.evalGate === true ? <GateIcon phase={node.phase} /> : null}
      <span className="min-w-0 flex-1 truncate" style={{ color: node.status === "skipped" ? "var(--fgColor-muted)" : undefined }}>
        {node.id}
      </span>
      {node.unknown === true ? (
        <span title={`not a step of flows/${flow}.yaml any more`} className="text-fg-attention">
          <AlertIcon size={14} />
        </span>
      ) : null}
      {node.visits > 1 ? (
        <span title={`${node.visits} visits; the latest decides the status`} className="rounded-full bg-canvas-muted px-[6px] text-[12px] font-medium leading-[18px] text-fg-muted" style={{ border: "1px solid var(--borderColor-muted)" }}>
          ×{node.visits}
        </span>
      ) : null}
      {node.agent !== undefined ? (
        <span title={`${node.agent.kind} · ${node.agent.model}`} className="max-w-[76px] truncate rounded-full px-[6px] text-[11px] leading-[18px] text-fg-muted" style={{ border: "1px solid var(--borderColor-default)" }}>
          {shortModel(node.agent.model)}
        </span>
      ) : null}
      {duration !== undefined ? <span className="shrink-0 text-[12px] text-fg-muted tabular-nums">{duration}</span> : null}
    </div>
  );
};
