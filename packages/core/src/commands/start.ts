/**
 * `sous run` and `sous watch` as the CLI starts them: the engine range is
 * checked first, read tolerantly, and only then are the settings, the
 * tracker and the `repos:` list loaded strictly, so a repository written for
 * a newer engine is refused by its range instead of by a settings key this
 * engine does not know.
 */
import { join, resolve } from "node:path";
import { createGit } from "../adapters/git.js";
import { createOpenSandbox } from "../adapters/sandbox.js";
import { ENGINE_VERSION } from "../config/engine.js";
import { loadSettings, SETTINGS_FILE } from "../config/settings.js";
import { useRunningEngine } from "../exec/imports.js";
import type { Tracker } from "../ports/tracker.js";
import { repoRootOf } from "../root.js";
import { lookupOf } from "../lookup.js";
import { loadTracker } from "../tracker.js";
import { homeRunCommand, isHomeRepository, runChildInTerminal } from "./homerun.js";
import { confirmOnStdin, runCommand, runEngineRefusal } from "./run.js";
import { engineCommandOf, spawnChild, watchCommand, watchEngineRefusal, watchReposOf } from "./watch.js";

export type StartDeps = {
  /** The project root (`.sous/`) the command was started on. */
  root: string;
  /** The running engine's CLI file, which runs elsewhere are started with. */
  cliFile: string;
  /** The running engine's version; injectable for tests. */
  engineVersion?: string;
  out: (line: string) => void;
  err: (line: string) => void;
};

/** Read at call time so a broken sous.yaml still reaches `validate`. */
const trackerOf = (root: string, repoRoot: string): Promise<Tracker> => {
  const settings = loadSettings(join(root, SETTINGS_FILE));
  return loadTracker(settings, { root, repoRoot, runsDir: resolve(root, settings.runsDir) });
};

export const startRun = async (args: readonly string[], deps: StartDeps): Promise<number> => {
  const { root, out, err } = deps;
  const repoRoot = repoRootOf(root);
  const engineVersion = deps.engineVersion ?? ENGINE_VERSION;
  const refusal = runEngineRefusal(root, repoRoot, engineVersion);
  if (refusal !== undefined) {
    err(refusal);
    return 2;
  }
  // Before the tracker module or any step loads: the project's `sous-factory` is this engine.
  await useRunningEngine();
  const git = createGit();
  // The tracker is read when the run starts here: a home repository's own takes part only when its repos: names it.
  const runHere = async (runArgs: readonly string[]) =>
    runCommand(runArgs, { root, repoRoot, git, tracker: await trackerOf(root, repoRoot), openSandbox: createOpenSandbox(git), confirm: confirmOnStdin, engineVersion, out, err });
  // A home repository runs nothing itself: the issue is looked up as `sous watch` looks, and runs where it would.
  if (isHomeRepository(root)) {
    const lookup = (only?: string) => lookupOf(root, undefined, engineVersion, only);
    return homeRunCommand(args, { root, lookup, engine: engineCommandOf(deps.cliFile), engineVersion, runChild: runChildInTerminal, runHere, out, err });
  }
  return runHere(args);
};

export const startWatch = async (args: readonly string[], deps: StartDeps): Promise<number> => {
  const { root, out, err } = deps;
  const engineVersion = deps.engineVersion ?? ENGINE_VERSION;
  const refusal = watchEngineRefusal(root, engineVersion);
  if (refusal !== undefined) {
    err(refusal);
    return 2;
  }
  await useRunningEngine();
  return watchCommand(args, { root, ...(await watchReposOf(root, undefined, engineVersion)), engine: engineCommandOf(deps.cliFile), spawn: spawnChild, engineVersion, out, err });
};
