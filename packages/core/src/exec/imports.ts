/**
 * The running engine is the project's `sous-factory`. A run loads steps,
 * evals, prepares and the tracker from a repository that may have no
 * `node_modules`, or one on another version; this hook maps the package's
 * bare specifiers to the engine's own modules, so one process never mixes
 * two engines. Registered by `run`, `watch` and `validate` only: a
 * project's own vitest and tsc keep resolving its install.
 */
import { register } from "node:module";

/** `.ts` when the engine runs from source (a checkout, its tests), `.js` from `dist/`; the layout below is the same. */
const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

/** Where the engine's module namespaces wait for the modules that re-export them; shared across instances of this file. */
const ENGINE_KEY = "sous-factory.running-engine";

/**
 * The package's public entries as this engine loaded them. `testing` is
 * imported by URL: it lives outside `src/`, and nothing else in the engine
 * imports it.
 */
const engineModules = async (): Promise<Record<string, Record<string, unknown>>> => ({
  "sous-factory": (await import("../index.js")) as Record<string, unknown>,
  "sous-factory/read": (await import("../read.js")) as Record<string, unknown>,
  "sous-factory/testing": (await import(new URL(`../../test/fakes/index${ext}`, import.meta.url).href)) as Record<string, unknown>,
});

/**
 * A module re-exporting the namespace the engine holds for `specifier`.
 * Whatever URL a loader makes of it (tsx's namespaced import appends a
 * query, and each query is its own module instance), every instance hands
 * out the engine's objects, so `instanceof SousError` and module state hold
 * across the boundary.
 */
const reexport = (specifier: string, names: readonly string[]): string => {
  const named = names.filter((n) => n !== "default");
  const source = [
    `const m = globalThis[Symbol.for(${JSON.stringify(ENGINE_KEY)})][${JSON.stringify(specifier)}];`,
    named.length > 0 ? `export const { ${named.join(", ")} } = m;` : "",
    names.includes("default") ? "export default m.default;" : "",
  ].join("\n");
  return `data:text/javascript,${encodeURIComponent(source)}`;
};

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

let registered: Promise<void> | undefined;

/** Idempotent; the hook is process-wide once registered. */
export const useRunningEngine = (): Promise<void> =>
  (registered ??= (async () => {
    const modules = await engineModules();
    (globalThis as Record<symbol, unknown>)[Symbol.for(ENGINE_KEY)] = modules;
    const entries = Object.fromEntries(Object.entries(modules).map(([specifier, ns]) => [specifier, reexport(specifier, Object.keys(ns))]));
    register(`data:text/javascript,${encodeURIComponent(HOOK)}`, { data: { entries } });
  })());
