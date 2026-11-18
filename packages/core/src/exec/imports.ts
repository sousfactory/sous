/**
 * The running engine is the project's `sous-factory`. A run loads steps,
 * evals, prepares and the tracker from a repository that may have no
 * `node_modules`, or one on another version; this hook maps the package's
 * bare specifiers to the engine's own entry files, so one process never
 * mixes two engines. Registered by `run` and `watch` only: a project's own
 * vitest and tsc keep resolving its install.
 */
import { register } from "node:module";

/** `.ts` when the engine runs from source (a checkout, its tests), `.js` from `dist/`; the layout below is the same. */
const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

/** The package's public entries, as the engine's own files. */
export const engineEntries = (): Record<string, string> => ({
  "sous-factory": new URL(`../index${ext}`, import.meta.url).href,
  "sous-factory/read": new URL(`../read${ext}`, import.meta.url).href,
  "sous-factory/testing": new URL(`../../test/fakes/index${ext}`, import.meta.url).href,
});

/**
 * Inline so it needs no file next to the engine's in either layout. Every
 * other specifier passes through; tsx's hooks, registered per import after
 * this one, wrap it and keep transpiling what it resolves.
 */
const HOOK = `
let entries = {};
export const initialize = (data) => { entries = data.entries; };
export const resolve = (specifier, context, next) =>
  Object.hasOwn(entries, specifier) ? { url: entries[specifier], shortCircuit: true } : next(specifier, context);
`;

let registered = false;

/** Idempotent; the hook is process-wide once registered. */
export const useRunningEngine = (): void => {
  if (registered) return;
  register(`data:text/javascript,${encodeURIComponent(HOOK)}`, { data: { entries: engineEntries() } });
  registered = true;
};
