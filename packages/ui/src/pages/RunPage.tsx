/** One issue's run, as GitHub's workflow run page; `?step=` shows that job in place of the summary. */
import { ArrowLeftIcon, CheckIcon, GitBranchIcon, TriangleDownIcon } from "@primer/octicons-react";
import { ActionList, ActionMenu, Button, BranchName, Flash, NavList } from "@primer/react";
import type { Outcome, RunView } from "../../server/model";
import { FlowGraph } from "../components/FlowGraph";
import { GitHubActions, useGitHubView } from "../components/GitHubActionsCell";
import { RunTrace } from "../components/RunTrace";
import { STATUS_COLOR, STATUS_LABEL, StatusIcon } from "../components/StatusIcon";
import { StepView } from "../components/StepView";
import { elapsed, shortSha, timeAgo } from "../format";
import { useNow } from "../live";
import { hrefOf, navigate, onLinkClick, type Route } from "../router";

type RunRoute = Extract<Route, { page: "run" }>;
/** A change to the route; `undefined` removes the parameter. */
type RoutePatch = { [K in "attempt" | "scope" | "step"]?: RunRoute[K] | undefined };

const OUTCOME_LABEL: Record<Outcome, string> = {
  running: "In progress",
  done: "Success",
  blocked: "Blocked",
  crashed: "Crashed",
  stale: "Crashed (no end recorded)",
  interrupted: "Cancelled",
  unknown: "Not started",
};

/** The summary cell for the squash commit on GitHub; only rendered once `merge` recorded one. */
const GitHubCell = ({ issue }: { issue: string }) => (
  <Cell label="GitHub Actions">
    <GitHubActions view={useGitHubView(issue)} />
  </Cell>
);

const Cell = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="min-w-0 px-4 py-3">
    <div className="mb-1 text-[12px] text-fg-muted">{label}</div>
    <div className="truncate text-[14px]">{children}</div>
  </div>
);

export const RunPage = ({ route, view, error }: { route: RunRoute; view: RunView | undefined; error: string | undefined }) => {
  const running = view?.summary.live === true;
  const now = useNow(running);
  const to = (patch: RoutePatch): string => {
    const next: RunRoute = { ...route };
    for (const key of Object.keys(patch) as (keyof RoutePatch)[]) {
      const value = patch[key];
      if (value === undefined) delete next[key];
      else Object.assign(next, { [key]: value });
    }
    return hrefOf(next);
  };

  if (view === undefined) {
    return (
      <div className="mx-auto max-w-[1280px] px-4 py-6 md:px-6">
        <a href="/runs" onClick={onLinkClick("/runs")} className="mb-4 inline-flex items-center gap-1">
          <ArrowLeftIcon size={16} /> All flows
        </a>
        {error !== undefined ? <Flash variant="danger">{route.issue}: {error}</Flash> : <div className="text-fg-muted">Loading…</div>}
      </div>
    );
  }

  const s = view.summary;
  const step = route.step !== undefined ? view.nodes.find((n) => n.id === route.step) : undefined;
  const detail = step !== undefined ? view.details[step.id] : undefined;
  const latestAttempt = view.attemptList.length;
  const sub = view.work.filter((w) => !w.isIssue);
  const done = sub.filter((w) => w.state === "done").length;
  const flowHref = hrefOf({ page: "runs", flow: s.flow });

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-4 md:px-6">
      <a href={flowHref} onClick={onLinkClick(flowHref)} className="mb-2 inline-flex items-center gap-1 text-[14px]">
        <ArrowLeftIcon size={16} /> {s.flow}
      </a>
      <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-line pb-4">
        <StatusIcon status={s.status} size={24} />
        <h1 className="m-0 min-w-0 flex-1 text-[24px] font-normal" data-testid="run-title">
          {s.title} <span className="text-fg-muted">{s.issue}</span>
        </h1>
        {view.attemptList.length > 0 ? (
          <ActionMenu>
            <ActionMenu.Anchor>
              <Button trailingVisual={TriangleDownIcon} size="small">
                {view.attempt === latestAttempt ? "Latest" : "Attempt"} #{view.attempt}
              </Button>
            </ActionMenu.Anchor>
            <ActionMenu.Overlay width="medium">
              <ActionList selectionVariant="single">
                {[...view.attemptList].reverse().map((a) => (
                  <ActionList.Item
                    key={a.n}
                    selected={a.n === view.attempt}
                    onSelect={() => navigate(to({ attempt: a.n === latestAttempt ? undefined : a.n, step: undefined }))}
                  >
                    Attempt #{a.n}
                    <ActionList.Description variant="block">
                      {OUTCOME_LABEL[a.outcome]} · run {a.runId} · {timeAgo(a.startedAt, now)}
                      {a.resumedFrom !== undefined ? ` · resumed at ${a.resumedFrom.step}` : ""}
                    </ActionList.Description>
                  </ActionList.Item>
                ))}
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
        ) : null}
      </div>

      {view.flowError !== undefined ? (
        <Flash variant="warning" className="mb-4">
          flows/{s.flow}.yaml could not be read, so only the visited steps are shown: {view.flowError}
        </Flash>
      ) : null}

      <div className="flex flex-col gap-6 md:flex-row">
        <aside className="w-full shrink-0 md:w-[256px]">
          <NavList aria-label="Run">
            <NavList.Item href={to({ step: undefined })} aria-current={step === undefined ? "page" : false} onClick={onLinkClick(to({ step: undefined }))}>
              Summary
            </NavList.Item>
            <NavList.Group title="Jobs">
              {view.nodes.map((n) => {
                const href = to({ step: n.id });
                return (
                  <NavList.Item key={n.id} href={href} aria-current={step?.id === n.id ? "page" : false} onClick={onLinkClick(href)}>
                    <NavList.LeadingVisual>
                      <StatusIcon status={n.status} />
                    </NavList.LeadingVisual>
                    {n.id}
                    {n.visits > 1 ? <NavList.TrailingVisual>×{n.visits}</NavList.TrailingVisual> : null}
                  </NavList.Item>
                );
              })}
            </NavList.Group>
          </NavList>
        </aside>

        <main className="min-w-0 flex-1">
          {step !== undefined && detail !== undefined ? (
            <StepView issue={s.issue} node={step} detail={detail} now={now} live={running} />
          ) : (
            <>
              {route.step !== undefined ? (
                <Flash variant="warning" className="mb-4">
                  This run has no step “{route.step}”.
                </Flash>
              ) : null}
              <div
                className={`mb-6 grid grid-cols-2 overflow-hidden rounded-md border border-line bg-canvas ${s.squash !== undefined ? "md:grid-cols-5" : "md:grid-cols-4"}`}
                data-testid="run-summary"
              >
                <Cell label="Triggered via sous run">
                  {s.startedAt !== undefined ? timeAgo(s.startedAt, now) : "–"}
                  {s.sha !== undefined ? <span className="font-mono text-[12px] text-fg-muted"> · {shortSha(s.sha)}</span> : null}
                </Cell>
                <Cell label="Status">
                  <span data-testid="run-status" style={{ color: s.status === "success" || s.status === "failure" ? STATUS_COLOR[s.status] : undefined, fontWeight: 600 }}>
                    {OUTCOME_LABEL[s.outcome]}
                  </span>
                </Cell>
                <Cell label="Total duration">
                  <span className="tabular-nums">{elapsed(s.startedAt, s.endedAt, now) ?? "–"}</span>
                </Cell>
                <Cell label="Branch">
                  <span className="inline-flex items-center gap-1">
                    <GitBranchIcon size={14} className="text-fg-muted" />
                    <BranchName as="span" title={s.branch} className="truncate whitespace-nowrap">
                      {s.branch}
                    </BranchName>
                  </span>
                </Cell>
                {s.squash !== undefined ? <GitHubCell issue={s.issue} /> : null}
              </div>

              {s.crash !== undefined ? (
                <Flash variant="danger" className="mb-4" data-testid="run-crash">
                  <div className="mb-1 font-semibold">
                    The run crashed
                    {s.crash.step !== undefined ? (
                      <>
                        {" in "}
                        <a href={to({ step: s.crash.step })} onClick={onLinkClick(to({ step: s.crash.step }))}>
                          {s.crash.step}
                        </a>
                      </>
                    ) : null}
                  </div>
                  <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px]">{s.crash.error}</pre>
                </Flash>
              ) : null}

              {sub.length > 0 ? (
                <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="work-items">
                  <span className="text-[12px] text-fg-muted">Work item</span>
                  {view.work.map((w) => {
                    const href = to({ scope: w.current ? undefined : w.key, step: undefined });
                    const selected = w.key === view.scope;
                    return (
                      <a
                        key={w.key}
                        href={href}
                        onClick={onLinkClick(href)}
                        aria-current={selected ? "true" : undefined}
                        className="inline-flex items-center gap-1 rounded-full px-3 text-[12px] leading-[24px] hover:no-underline"
                        style={{
                          border: `1px solid ${selected ? "var(--fgColor-accent)" : "var(--borderColor-default)"}`,
                          color: selected ? "var(--fgColor-accent)" : "var(--fgColor-default)",
                          background: selected ? "var(--bgColor-accent-muted)" : "var(--bgColor-default)",
                        }}
                      >
                        {w.state === "done" ? <CheckIcon size={12} /> : null}{w.id}
                        {w.isIssue ? " (issue)" : ""}
                        {w.current ? " · current" : ""}
                      </a>
                    );
                  })}
                  <span className="text-[12px] text-fg-muted">
                    {done} of {sub.length} sub-issue{sub.length === 1 ? "" : "s"} done
                  </span>
                </div>
              ) : null}

              <div className="overflow-hidden rounded-md border border-line">
                <div className="flex items-baseline gap-2 border-b border-line bg-canvas px-4 py-3">
                  <span className="font-semibold">{s.flow}.yaml</span>
                  <span className="text-[12px] text-fg-muted">on: sous run {s.issue}</span>
                  <span className="ml-auto text-[12px] text-fg-muted" data-testid="run-status-label">
                    {STATUS_LABEL[s.status]}
                  </span>
                </div>
                <div className="bg-canvas-muted">
                  <FlowGraph nodes={view.nodes} edges={view.edges} now={now} flow={s.flow} onOpen={(id) => navigate(to({ step: id }))} />
                </div>
              </div>

              <RunTrace rows={view.trace} now={now} stepHref={(id) => to({ step: id })} onOpen={(id, e) => onLinkClick(to({ step: id }))(e)} />
            </>
          )}
        </main>
      </div>
    </div>
  );
};
