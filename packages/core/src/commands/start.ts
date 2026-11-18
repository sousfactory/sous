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
  return loadTracker(settings, { root, repoRoot, runsDir: resolve(root, settings.runsDir), labelPrefix: settings.labelPrefix });
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
  useRunningEngine();
  const tracker = await trackerOf(root, repoRoot);
  const git = createGit();
  const runHere = (runArgs: readonly string[]) => runCommand(runArgs, { root, repoRoot, git, tracker, openSandbox: createOpenSandbox(git), confirm: confirmOnStdin, engineVersion, out, err });
  // A home repository runs nothing itself: the issue runs in its entry, as `sous watch` would start it.
  if (isHomeRepository(root)) return homeRunCommand(args, { root, tracker, engine: engineCommandOf(deps.cliFile), runChild: runChildInTerminal, runHere, out, err });
  return runHere(args);
};

export const startWatch = async (args: readonly string[], deps: StartDeps): Promise<number> => {
  const { root, out, err } = deps;
  const engineVersion = deps.engineVersion ?? ENGINE_VERSION;
  const refusal = watchEngineRefusal(root, engineVersion, true);
  if (refusal !== undefined) {
    err(refusal);
    return 2;
  }
  useRunningEngine();
  return watchCommand(args, { root, ...(await watchReposOf(root, undefined, engineVersion)), engine: engineCommandOf(deps.cliFile), spawn: spawnChild, engineVersion, out, err });
};
