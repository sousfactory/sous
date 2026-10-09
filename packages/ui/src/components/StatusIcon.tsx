/**
 * The GitHub Actions status icons: Octicons for the settled states and
 * GitHub's own rotating ring for a job in progress.
 */
import { CheckCircleFillIcon, CircleIcon, SkipIcon, StopIcon, XCircleFillIcon } from "@primer/octicons-react";
import type { Status } from "../../server/model";

export const STATUS_LABEL: Record<Status, string> = {
  success: "Success",
  failure: "Failure",
  in_progress: "In progress",
  queued: "Queued",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

export const STATUS_COLOR: Record<Status, string> = {
  success: "var(--fgColor-success)",
  failure: "var(--fgColor-danger)",
  in_progress: "var(--fgColor-attention)",
  queued: "var(--fgColor-muted)",
  skipped: "var(--fgColor-muted)",
  cancelled: "var(--fgColor-muted)",
};

const InProgress = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="sous-rotate" aria-hidden="true">
    <path opacity=".5" d="M8 15A7 7 0 108 1a7 7 0 000 14v0z" stroke="currentColor" strokeWidth="2" />
    <path d="M15 8a7 7 0 01-7 7" stroke="currentColor" strokeWidth="2" />
    <path d="M8 12a4 4 0 100-8 4 4 0 000 8z" fill="currentColor" />
  </svg>
);

export const StatusIcon = ({ status, size = 16 }: { status: Status; size?: number }) => {
  const props = { size, "aria-hidden": true } as const;
  const icon = {
    success: <CheckCircleFillIcon {...props} />,
    failure: <XCircleFillIcon {...props} />,
    in_progress: <InProgress size={size} />,
    queued: <CircleIcon {...props} />,
    skipped: <SkipIcon {...props} />,
    cancelled: <StopIcon {...props} />,
  }[status];
  return (
    <span role="img" aria-label={STATUS_LABEL[status]} data-status={status} style={{ color: STATUS_COLOR[status], display: "inline-flex", flexShrink: 0 }}>
      {icon}
    </span>
  );
};
