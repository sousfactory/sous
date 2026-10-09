/**
 * The run's squash commit on GitHub: the Actions runs it triggered, each with
 * GitHub's status and a link, or why there are none. Asked again every 30s
 * until every workflow run has completed.
 */
import { LinkExternalIcon } from "@primer/octicons-react";
import { useEffect, useState } from "react";
import type { ActionsRunView, GitHubView } from "../../server/github";
import type { Status } from "../../server/model";
import { shortSha } from "../format";
import { useJson, useVersion } from "../live";
import { STATUS_LABEL, StatusIcon } from "./StatusIcon";

const POLL_MS = 30_000;

export const actionsStatus = (run: Pick<ActionsRunView, "status" | "conclusion">): Status => {
  if (run.status !== "completed") return run.status === "in_progress" ? "in_progress" : "queued";
  if (run.conclusion === "success") return "success";
  if (run.conclusion === "cancelled") return "cancelled";
  if (run.conclusion === "skipped" || run.conclusion === "neutral") return "skipped";
  return "failure";
};

const External = ({ href, children, title }: { href: string; children: React.ReactNode; title?: string }) => (
  <a href={href} target="_blank" rel="noreferrer" title={title} className="inline-flex min-w-0 items-center gap-1">
    <span className="truncate">{children}</span>
    <LinkExternalIcon size={12} className="shrink-0" />
  </a>
);

export const GitHubActions = ({ view }: { view: GitHubView | undefined }) => {
  if (view === undefined) return <span className="text-fg-muted">…</span>;
  switch (view.state) {
    case "none":
      return <span className="text-fg-muted">–</span>;
    case "unpushed":
      return (
        <span className="text-fg-muted" title={`${view.sha} is not on GitHub yet; push the base branch`}>
          not pushed yet · <span className="font-mono text-[12px]">{shortSha(view.sha)}</span>
        </span>
      );
    case "no-workflow":
      return (
        <span className="inline-flex min-w-0 items-center gap-1 text-fg-muted">
          no workflow ran ·
          <External href={view.commitUrl} title="the commit on GitHub">
            <span className="font-mono text-[12px]">{shortSha(view.sha)}</span>
          </External>
        </span>
      );
    case "unavailable":
      return (
        <span className="text-fg-muted" title={view.error}>
          GitHub unavailable
        </span>
      );
    case "runs":
      return (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-testid="actions-runs">
          {view.runs.map((run) => {
            const status = actionsStatus(run);
            return (
              <span key={run.workflow} className="inline-flex min-w-0 items-center gap-1">
                <StatusIcon status={status} />
                <External href={run.url} title={`${run.workflow}: ${STATUS_LABEL[status]}`}>
                  {run.workflow}
                </External>
              </span>
            );
          })}
        </span>
      );
  }
};

/** Polls while a workflow run is unfinished or the commit is not pushed yet. */
export const useGitHubView = (issue: string): GitHubView | undefined => {
  const [tick, setTick] = useState(0);
  const fetched = useJson<GitHubView>(`/api/runs/${encodeURIComponent(issue)}/github`, `${useVersion(issue)}:${tick}`);
  const view = fetched.data;
  const settled = view !== undefined && (view.state === "none" || (view.state === "runs" && view.final));
  useEffect(() => {
    if (settled) return;
    const timer = setInterval(() => setTick((t) => t + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [settled]);
  return view;
};
