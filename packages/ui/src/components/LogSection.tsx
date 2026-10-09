/** One collapsible row of GitHub's job log. */
import { ChevronDownIcon, ChevronRightIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Status } from "../../server/model";
import { useVersion } from "../live";
import { StatusIcon } from "./StatusIcon";

export const LogLines = ({ text, empty = "No output." }: { text: string; empty?: string }) => {
  const lines = text.replace(/\n$/, "").split("\n");
  if (text === "") return <div className="px-4 py-2 font-mono text-[12px]" style={{ color: "var(--log-muted)" }}>{empty}</div>;
  return (
    <div className="overflow-x-auto py-1 font-mono text-[12px] leading-[20px]">
      {lines.map((line, i) => (
        <div key={i} className="flex hover:bg-[var(--log-hover)]">
          <span className="w-[56px] shrink-0 select-none pr-3 text-right" style={{ color: "var(--log-muted)" }}>
            {i + 1}
          </span>
          <span className="whitespace-pre pr-4">{line}</span>
        </div>
      ))}
    </div>
  );
};

export type LogSectionProps = { title: ReactNode; status?: Status; duration?: string | undefined; defaultOpen?: boolean; children: ReactNode; testId?: string };

export const LogSection = ({ title, status, duration, defaultOpen = false, children, testId }: LogSectionProps) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section data-testid={testId}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-4 py-[6px] text-left text-[14px] hover:bg-[var(--log-hover)]"
        style={{ color: "var(--log-fg)" }}
      >
        <span style={{ color: "var(--log-muted)" }}>{open ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}</span>
        {status !== undefined ? <StatusIcon status={status} /> : <span className="inline-block w-4" />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {duration !== undefined ? <span className="shrink-0 text-[12px] tabular-nums" style={{ color: "var(--log-muted)" }}>{duration}</span> : null}
      </button>
      {open ? <div className="pb-2">{children}</div> : null}
    </section>
  );
};

/** Tails the log while `live`. Mounted only while its section is open, so closed rows fetch nothing. */
export const AgentLog = ({ issue, name, live }: { issue: string; name: string; live: boolean }) => {
  const version = useVersion(issue);
  const [text, setText] = useState<string | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const size = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/runs/${encodeURIComponent(issue)}/logs/${encodeURIComponent(name)}?from=${size.current}`);
      if (cancelled) return;
      if (!res.ok) {
        setMissing(true);
        return;
      }
      const chunk = await res.text();
      const start = Number(res.headers.get("x-log-start") ?? "0");
      size.current = Number(res.headers.get("x-log-size") ?? "0");
      setMissing(false);
      setText((prev) => (start === 0 ? chunk : (prev ?? "") + chunk));
    })();
    return () => {
      cancelled = true;
    };
  }, [issue, name, live ? version : "settled"]);

  useEffect(() => {
    if (live) bottom.current?.scrollIntoView({ block: "nearest" });
  }, [text, live]);

  if (missing) return <LogLines text="" empty={`No agent log ${name} under logs/${issue}/${live ? " yet" : ""}.`} />;
  if (text === undefined) return <LogLines text="" empty="Loading…" />;
  return (
    <>
      <LogLines text={text} />
      <div ref={bottom} />
    </>
  );
};
