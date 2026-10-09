/**
 * The runs list, as GitHub's "All workflows" page: flows in the side
 * nav, one row per issue with its latest attempt. Rows of run folders core
 * cannot read are greyed with the reason. A selected flow shows its graph
 * above its runs, whether it ever ran or not.
 */
import { AlertIcon, CalendarIcon, StopwatchIcon, WorkflowIcon } from "@primer/octicons-react";
import { BranchName, Flash, NavList } from "@primer/react";
import type { RunsResponse } from "../../server/api";
import type { RunRow } from "../../server/model";
import { FlowPreview } from "../components/FlowPreview";
import { StatusIcon } from "../components/StatusIcon";
import { elapsed, timeAgo } from "../format";
import { useNow } from "../live";
import { hrefOf, navigate, onLinkClick } from "../router";

const RunLine = ({ row, now }: { row: RunRow; now: number }) => {
  if (row.kind === "error") {
    return (
      <li className="flex items-start gap-3 border-t border-line px-4 py-3 opacity-70 first:border-t-0" data-testid="run-row-error">
        <span className="pt-[2px] text-fg-muted">
          <AlertIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-fg-muted">Run folder {row.issue}</div>
          <div className="mt-1 break-words text-[12px] text-fg-muted">core cannot read this session: {row.error}</div>
        </div>
        <div className="hidden w-[160px] shrink-0 text-[12px] text-fg-muted sm:block">
          <div className="flex items-center gap-1">
            <CalendarIcon size={14} />
            {timeAgo(row.updatedAt, now)}
          </div>
        </div>
      </li>
    );
  }
  const s = row.summary;
  const href = hrefOf({ page: "run", issue: s.issue });
  const duration = elapsed(s.startedAt, s.endedAt, now);
  return (
    <li className="flex items-start gap-3 border-t border-line px-4 py-3 first:border-t-0 hover:bg-canvas-muted" data-testid="run-row">
      <span className="pt-[2px]">
        <StatusIcon status={s.status} />
      </span>
      <div className="min-w-0 flex-1">
        <a href={href} onClick={onLinkClick(href)} className="block truncate font-semibold text-fg">
          {s.title}
        </a>
        <div className="mt-1 truncate text-[12px] text-fg-muted">
          <span className="font-semibold">{s.flow}</span> {s.issue}:{" "}
          {s.runId !== undefined ? (
            <>
              Run {s.runId}
              {s.attempts > 1 ? ` (attempt ${s.attempts})` : ""} started by sous run{s.sha !== undefined ? ` at ${s.sha}` : ""}
            </>
          ) : (
            "no run recorded"
          )}
        </div>
      </div>
      <div className="hidden w-[240px] shrink-0 justify-end md:flex">
        <BranchName as="span" title={s.branch} className="max-w-full truncate whitespace-nowrap">
          {s.branch}
        </BranchName>
      </div>
      <div className="w-[120px] shrink-0 text-[12px] text-fg-muted">
        {s.startedAt !== undefined ? (
          <div className="flex items-center gap-1">
            <CalendarIcon size={14} />
            {timeAgo(s.startedAt, now)}
          </div>
        ) : null}
        {duration !== undefined ? (
          <div className="mt-1 flex items-center gap-1">
            <StopwatchIcon size={14} />
            {duration}
          </div>
        ) : null}
      </div>
    </li>
  );
};

export type RunsPageProps = { data: RunsResponse | undefined; error: string | undefined; flow: string | undefined; step?: string | undefined };

export const RunsPage = ({ data, error, flow, step }: RunsPageProps) => {
  const rows = (data?.rows ?? []).filter((r) => flow === undefined || (r.kind === "run" && r.summary.flow === flow));
  const now = useNow(rows.some((r) => r.kind === "run" && r.summary.live));
  const flows = data?.flows ?? [];
  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6 px-4 py-6 md:flex-row md:px-6">
      <aside className="w-full shrink-0 md:w-[256px]">
        <h2 className="mb-2 px-2 text-[20px] font-normal">Actions</h2>
        <NavList aria-label="Flows">
          <NavList.Item href="/runs" aria-current={flow === undefined ? "page" : false} onClick={onLinkClick("/runs")}>
            All flows
          </NavList.Item>
          <NavList.Group title="Flows">
            {flows.map((p) => {
              const href = hrefOf({ page: "runs", flow: p });
              return (
                <NavList.Item key={p} href={href} aria-current={flow === p ? "page" : false} onClick={onLinkClick(href)}>
                  <NavList.LeadingVisual>
                    <WorkflowIcon />
                  </NavList.LeadingVisual>
                  {p}
                </NavList.Item>
              );
            })}
          </NavList.Group>
        </NavList>
      </aside>
      <main className="min-w-0 flex-1">
        <h1 className="mb-1 text-[24px] font-normal">{flow ?? "All flows"}</h1>
        <p className="mb-4 text-fg-muted">
          {flow !== undefined ? <span className="font-mono text-[12px]">flows/{flow}.yaml</span> : "Runs of every flow, newest first."}
        </p>
        {error !== undefined ? <Flash variant="danger">{error}</Flash> : null}
        {flow !== undefined ? <FlowPreview flow={flow} step={step} now={now} onStep={(id) => navigate(hrefOf({ page: "runs", flow, ...(id !== undefined ? { step: id } : {}) }))} /> : null}
        <div className="overflow-hidden rounded-md border border-line">
          <div className="border-b border-line bg-canvas-muted px-4 py-3 font-semibold">
            {rows.length} flow run{rows.length === 1 ? "" : "s"}
          </div>
          {rows.length === 0 ? (
            <div className="px-4 py-10 text-center text-fg-muted">{data === undefined ? "Loading…" : "No runs yet. Start one with ./sous run <flow> <issue>."}</div>
          ) : (
            <ul className="m-0 list-none p-0">
              {rows.map((row) => (
                <RunLine key={row.kind === "run" ? row.summary.issue : row.issue} row={row} now={now} />
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
};
