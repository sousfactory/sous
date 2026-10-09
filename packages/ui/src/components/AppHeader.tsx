/**
 * GitHub's repository header: owner/repo crumbs over an underline tab bar
 * with Actions selected. The sous mark in place of the Octocat and the
 * "factory" label are what tell this page from GitHub's.
 */
import { PlayIcon, WorkflowIcon } from "@primer/octicons-react";
import { onLinkClick } from "../router";

export const AppHeader = ({ repo, live }: { repo: string; live: boolean }) => (
  <header className="bg-canvas-muted border-b border-line">
    <div className="flex items-center gap-3 px-4 pt-4 pb-2 md:px-6">
      <a href="/runs" onClick={onLinkClick("/runs")} aria-label="sous home" className="flex items-center gap-2 text-fg hover:no-underline">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line bg-canvas">
          <WorkflowIcon size={16} />
        </span>
      </a>
      <nav aria-label="Project" className="flex min-w-0 items-center gap-1 text-[14px]">
        <span className="truncate text-fg">{repo}</span>
        <span className="text-fg-muted">/</span>
        <a href="/runs" onClick={onLinkClick("/runs")} className="font-semibold text-fg">
          factory
        </a>
      </nav>
      <span className="rounded-full border border-line px-2 text-[12px] font-medium leading-[20px] text-fg-muted">sous · local</span>
      {live ? (
        <span className="ml-auto flex items-center gap-1 text-[12px] text-fg-muted">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--fgColor-attention)" }} />a flow is running
        </span>
      ) : null}
    </div>
    <nav aria-label="Sections" className="flex gap-2 px-4 md:px-6">
      <a
        href="/runs"
        onClick={onLinkClick("/runs")}
        aria-current="page"
        className="relative flex items-center gap-2 px-2 pb-2 pt-1 text-fg hover:no-underline"
        style={{ fontWeight: 600 }}
      >
        <PlayIcon size={16} />
        Actions
        <span className="absolute inset-x-0 bottom-0 h-[2px] rounded" style={{ background: "var(--underlineNav-borderColor-active, #fd8c73)" }} />
      </a>
    </nav>
  </header>
);
