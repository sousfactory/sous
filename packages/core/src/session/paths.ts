/** Names and places of a run: spec folder and branch derived from the issue, run folder under `runsDir`. */
import { join, resolve } from "node:path";
import type { Settings } from "../config/settings.js";
import { ExpressionError } from "../exec/errors.js";

export const slugify = (title: string, words = 4): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter((w) => w.length > 0)
    .slice(0, words)
    .join("-");

/** An issue id as a path segment or branch part: anything but `[A-Za-z0-9._-]` becomes `-`. */
export const safeId = (id: string): string => id.replace(/[^A-Za-z0-9._-]+/g, "-");

export const specDirName = (issue: string, title: string): string => `${safeId(issue)}-${slugify(title)}`;

/** The `<issue>-*` folder the plan phase created, if any; matched by id alone, so a retitled issue still finds it. */
export const existingSpecDirName = (entries: readonly string[], issue: string): string | undefined =>
  entries.filter((e) => e.startsWith(`${safeId(issue)}-`)).sort()[0];

/** `specsDir` here is relative to the repository root, as `ctx.specDir` is. */
export const specDir = (specsDir: string, issue: string, title: string): string => join(specsDir, specDirName(issue, title));

const TEMPLATE = /\$\{\{([\s\S]*?)\}\}/g;

/** Settings `branch` template: `${{ … }}` is JavaScript over `issue` (`{ id, title }`, the id branch-safe) and `slug`. */
export const branchName = (template: string, issue: { id: string; title: string }): string =>
  template.replace(TEMPLATE, (_match, src: string) => {
    let fn: (issue: unknown, slug: string) => unknown;
    try {
      fn = new Function("issue", "slug", `return (${src}\n)`) as typeof fn;
    } catch (error: unknown) {
      throw new ExpressionError(src, error instanceof Error ? error.message : String(error));
    }
    return String(fn({ id: safeId(issue.id), title: issue.title }, slugify(issue.title)));
  });

/** `settings.runsDir` resolved against the project root (`.sous/`). */
export const runsRoot = (root: string, settings: Pick<Settings, "runsDir">): string => resolve(root, settings.runsDir);

/** Holds the issue's session and event log; gitignored. */
export const runDir = (runsRoot: string, issue: string): string => join(runsRoot, safeId(issue));

export const sessionFile = (runsRoot: string, issue: string): string => join(runDir(runsRoot, issue), "session.json");

export const eventsFile = (runsRoot: string, issue: string): string => join(runDir(runsRoot, issue), "events.jsonl");
