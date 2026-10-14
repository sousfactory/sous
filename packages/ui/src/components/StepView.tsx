/** A step opened from the graph, laid out as GitHub's job page: one log row per agent call and eval of every visit. */
import { ArrowRightIcon } from "@primer/octicons-react";
import type { IterationView, RouteView, StepDetail, StepNode, VisitView } from "../../server/model";
import { elapsed, formatCount, shortSha, timeAgo } from "../format";
import { AgentLog, LogLines, LogSection } from "./LogSection";
import { StatusIcon } from "./StatusIcon";

export const KIND_WORD = { prompt: "prompt step", module: "run step", eval: "eval-only step" } as const;

/** ` with prepare and eval gate`, either part alone, or nothing. */
export const withParts = (node: StepNode): string => {
  const parts = [...(node.prepare === true ? ["prepare"] : []), ...(node.evalGate === true ? ["eval gate"] : [])];
  return parts.length > 0 ? ` with ${parts.join(" and ")}` : "";
};

const statusLine = (node: StepNode, now: number): string => {
  const took = elapsed(node.startedAt, node.endedAt, now);
  switch (node.status) {
    case "success":
      return `succeeded ${node.endedAt !== undefined ? timeAgo(node.endedAt, now) : ""} in ${took ?? "0s"}`;
    case "failure":
      if (node.endedAt === undefined) return "failed: its run crashed before the visit closed";
      return `failed ${node.endedAt !== undefined ? timeAgo(node.endedAt, now) : ""} in ${took ?? "0s"}`;
    case "in_progress":
      return `started ${node.startedAt !== undefined ? timeAgo(node.startedAt, now) : ""}, running for ${took ?? "0s"}`;
    case "cancelled":
      return "was cancelled: its run ended before the visit closed";
    case "queued":
      return "is queued: this run has not reached it yet";
    case "skipped":
      return "was skipped: no route led here";
  }
};

const agentStatus = (it: IterationView, visit: VisitView) => {
  const a = it.agent;
  if (a === undefined) return undefined;
  if (a.endedAt === undefined) return visit.status;
  return a.outcome === "ok" ? "success" : "failure";
};

const evalStatus = (it: IterationView, visit: VisitView) => {
  const e = it.eval;
  if (e === undefined) return undefined;
  if (e.endedAt === undefined) return visit.status;
  return e.ok === true ? "success" : "failure";
};

const prepareStatus = (visit: VisitView) => {
  const p = visit.prepare;
  if (p === undefined) return undefined;
  if (p.endedAt === undefined) return visit.status;
  return "success";
};

/**
 * What prepare decided, once it has returned: `agent runs`, `agent skipped:
 * <reason>`, or for `on-fail` whether the eval that ran first let the agent
 * start (an iteration with an agent) or settled the visit.
 */
const prepareText = (visit: VisitView): string => {
  const p = visit.prepare;
  if (p?.agent === undefined) return "";
  const why = p.reason !== undefined ? `: ${p.reason}` : "";
  if (p.agent === "always") return " · agent runs";
  if (p.agent === "never") return ` · agent skipped${why}`;
  if (visit.iterations.some((it) => it.agent !== undefined)) return ` · eval failed, agent runs${why}`;
  return visit.endedAt !== undefined ? ` · eval passed, agent skipped${why}` : ` · eval first${why}`;
};

const usageText = (it: IterationView): string => {
  const u = it.agent?.usage;
  return u === undefined ? "" : ` · ${formatCount(u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens)} in / ${formatCount(u.outputTokens)} out tokens`;
};

/** The step's routes in file order; `taken` marks the one the latest visit took. */
export const Routes = ({ routes, taken }: { routes: RouteView[]; taken?: string | undefined }) => (
  <div className="mb-4 overflow-hidden rounded-md border border-line" data-testid="routes">
    <div className="border-b border-line bg-canvas-muted px-4 py-2 text-[12px] font-semibold text-fg-muted">Routes, first match wins</div>
    <ul className="m-0 list-none p-0">
      {routes.map((r, i) => (
        <li key={i} className="flex items-center gap-2 border-t border-line px-4 py-2 first:border-t-0">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px]" title={r.when}>
            {r.exhausted === true ? "iterations exhausted" : (r.when ?? "else")}
          </code>
          <ArrowRightIcon size={14} className="text-fg-muted" />
          <span className="font-semibold">{r.to}</span>
          {taken === r.to && r.exhausted !== true ? <span className="text-[12px] text-fg-success">taken</span> : null}
        </li>
      ))}
    </ul>
  </div>
);

export type StepViewProps = { issue: string; node: StepNode; detail: StepDetail; now: number; live: boolean };

export const StepView = ({ issue, node, detail, now, live }: StepViewProps) => {
  const latest = detail.visits[detail.visits.length - 1];
  const record = detail.record;
  return (
    <div data-testid="step-view">
      <div className="mb-4 flex items-start gap-3">
        <span className="pt-1">
          <StatusIcon status={node.status} size={20} />
        </span>
        <div className="min-w-0">
          <h2 className="m-0 text-[20px] font-semibold">{node.id}</h2>
          <div className="text-fg-muted">
            {node.id} {statusLine(node, now)}
            {node.visits > 1 ? ` · visit ${node.visits}` : ""}
            {node.uses !== undefined ? (
              <>
                {" · uses "}
                <code className="font-mono text-[12px]">{node.uses}</code>
              </>
            ) : null}
            {node.kind !== undefined ? ` · ${KIND_WORD[node.kind]}${withParts(node)}` : ""}
            {node.agent !== undefined ? ` · ${node.agent.kind} ${node.agent.model}` : ""}
          </div>
        </div>
      </div>

      {detail.routes.length > 0 ? <Routes routes={detail.routes} taken={latest?.next} /> : null}

      <div className="sous-log overflow-hidden rounded-md" data-testid="job-log">
        {detail.visits.length === 0 ? <LogLines text="" empty={`No visit to ${node.id} in this run.`} /> : null}
        {detail.visits.map((visit, vi) => {
          const isLatest = vi === detail.visits.length - 1;
          return (
            <div key={visit.spanId} className="border-t first:border-t-0" style={{ borderColor: "var(--log-line)" }}>
              <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-[12px]" style={{ color: "var(--log-muted)" }}>
                <span className="font-semibold">Visit {vi + 1}</span>
                <span>· work #{visit.scope}</span>
                <span>· run {visit.runId}</span>
                <span className="ml-auto tabular-nums">{elapsed(visit.startedAt, visit.endedAt, now)}</span>
              </div>
              {visit.prepare !== undefined ? (
                <LogSection
                  testId={`prepare-${vi + 1}`}
                  status={prepareStatus(visit) ?? "skipped"}
                  title={
                    <>
                      Run prepare
                      <span style={{ color: "var(--log-muted)" }}>{prepareText(visit)}</span>
                    </>
                  }
                  duration={elapsed(visit.prepare.startedAt, visit.prepare.endedAt, now)}
                >
                  {isLatest && record?.prepared !== undefined ? (
                    <LogLines text={JSON.stringify(record.prepared.output, null, 2)} empty="Prepare returned no output." />
                  ) : (
                    <LogLines text="" empty="The session keeps the prepare output of the latest visit only." />
                  )}
                </LogSection>
              ) : null}
              {visit.iterations.map((it) => (
                <div key={it.n}>
                  {it.agent !== undefined ? (
                    <LogSection
                      testId={`agent-${vi + 1}-${it.n}`}
                      status={agentStatus(it, visit) ?? "skipped"}
                      title={
                        <>
                          Run agent · iteration {it.n}
                          <span style={{ color: "var(--log-muted)" }}>
                            {" "}
                            · {it.agent.model}
                            {it.agent.outcome !== undefined && it.agent.outcome !== "ok" ? ` · ${it.agent.outcome}` : ""}
                            {usageText(it)}
                          </span>
                        </>
                      }
                      duration={elapsed(it.agent.startedAt, it.agent.endedAt, now)}
                    >
                      <AgentLog issue={issue} name={it.agent.log} live={live && it.agent.endedAt === undefined} />
                      {it.agent.commits.length > 0 ? (
                        <div className="px-4 pt-1 font-mono text-[12px]" style={{ color: "var(--log-muted)" }}>
                          commits: {it.agent.commits.map(shortSha).join(", ")}
                        </div>
                      ) : null}
                    </LogSection>
                  ) : null}
                  {it.eval !== undefined ? (
                    <LogSection
                      testId={`eval-${vi + 1}-${it.n}`}
                      status={evalStatus(it, visit) ?? "skipped"}
                      title={`Run eval · iteration ${it.n}`}
                      duration={elapsed(it.eval.startedAt, it.eval.endedAt, now)}
                    >
                      {isLatest && it === visit.iterations[visit.iterations.length - 1] && record !== undefined ? (
                        <LogLines text={record.log} empty="The eval wrote no log." />
                      ) : (
                        <LogLines text="" empty="The session keeps the eval log of the latest visit only." />
                      )}
                    </LogSection>
                  ) : null}
                </div>
              ))}
              {visit.iterations.length === 0 && isLatest && record !== undefined && record.log !== "" ? (
                <LogSection title="Log" status={visit.status}>
                  <LogLines text={record.log} />
                </LogSection>
              ) : null}
              {visit.error !== undefined ? (
                <LogSection testId={`crash-${vi + 1}`} title="Run crashed" status="failure" defaultOpen>
                  <LogLines text={visit.error} />
                </LogSection>
              ) : null}
              <div className="flex items-center gap-2 px-4 py-[6px] text-[12px]" style={{ color: "var(--log-muted)" }}>
                {visit.next !== undefined ? (
                  <>
                    <ArrowRightIcon size={12} /> next: <span style={{ color: "var(--log-fg)" }}>{visit.next}</span>
                  </>
                ) : visit.status === "in_progress" ? (
                  "running…"
                ) : visit.status === "failure" ? (
                  "the run crashed during this visit"
                ) : (
                  "ended without a transition"
                )}
              </div>
            </div>
          );
        })}
        {record !== undefined ? (
          <div className="border-t" style={{ borderColor: "var(--log-line)" }}>
            <LogSection testId="output" title="Output" status={record.ok ? "success" : "failure"}>
              <LogLines text={record.output === undefined ? "" : JSON.stringify(record.output, null, 2)} empty="The step returned no output." />
            </LogSection>
            <LogSection testId="commits" title={`Commits (${record.commits.length})`}>
              <LogLines text={record.commits.map((c) => `${shortSha(c)}  ${c}`).join("\n")} empty="No commits." />
            </LogSection>
          </div>
        ) : null}
      </div>
    </div>
  );
};
