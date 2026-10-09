/** The `sous` command: parses arguments and dispatches to a command. */
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGit } from "./adapters/git.js";
import { openSandbox } from "./adapters/sandcastle.js";
import { graphCommand } from "./commands/graph.js";
import { initCommand } from "./commands/init.js";
import { confirmOnStdin, runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { validateCommand } from "./commands/validate.js";
import { loadSettings, SETTINGS_FILE } from "./config/settings.js";
import type { Tracker } from "./ports/tracker.js";
import { PROJECT_DIR, projectRoot, repoRootOf } from "./root.js";
import { loadTracker } from "./tracker.js";

export { PROJECT_DIR, projectRoot, repoRootOf } from "./root.js";

const USAGE = `usage:
  sous init [--starter <dir>] [--force] copy a starter into .sous/, install it, add the /sous-plan skill
  sous run <flow> <issue> [--restart]   validate, then start or resume a run
  sous status <issue>                   session facts and the timeline
  sous graph <flow>                     the flow as Mermaid
  sous validate                         every flow, every step, sous.yaml
  sous ui [--port <n>]                  the runs as a live flow graph on 127.0.0.1`;

type Command = (args: string[]) => Promise<number>;

/**
 * Resolved from this package, not from `SOUS_ROOT`, since a project need not
 * contain the UI: the published package carries the compiled server under
 * `dist/ui/`, a checkout runs the TypeScript one in the sibling `ui` package.
 */
export const uiMainPath = (cliFile: string): string => {
  const here = dirname(cliFile);
  const compiled = here.endsWith(join("dist", "src"));
  return compiled ? join(here, "..", "ui", "dist-server", "main.js") : join(here, "..", "..", "ui", "server", "main.ts");
};

export const UI_MAIN = uiMainPath(fileURLToPath(import.meta.url));

/** The UI package depends on core, so it is loaded by path at call time to keep core from depending on it back. */
const uiCommand = async (args: string[], root: string): Promise<number> => {
  const { uiMain } = (await import(pathToFileURL(UI_MAIN).href)) as {
    uiMain: (args: string[], root: string) => Promise<number>;
  };
  return uiMain(args, root);
};

/** Read at call time so a broken sous.yaml still reaches `validate`. */
const trackerOf = (root: string, repoRoot: string): Promise<Tracker> => {
  const settings = loadSettings(join(root, SETTINGS_FILE));
  return loadTracker(settings, { root, repoRoot, runsDir: resolve(root, settings.runsDir), labelPrefix: settings.labelPrefix });
};

const commands = (root: string): Record<string, Command> => {
  const repoRoot = repoRootOf(root);
  const io = { out: console.log, err: console.error };
  return {
    validate: (args) => validateCommand(args, { root, ...io }),
    graph: (args) => graphCommand(args, { root, ...io }),
    run: async (args) =>
      runCommand(args, { root, repoRoot, git: createGit(), tracker: await trackerOf(root, repoRoot), openSandbox, confirm: confirmOnStdin, ...io }),
    status: (args) => statusCommand(args, { root, ...io }),
    ui: (args) => uiCommand(args, root),
  };
};

const main = async (argv: string[]): Promise<number> => {
  const [name, ...args] = argv;
  if (name === undefined || name === "--help" || name === "-h") {
    console.log(USAGE);
    return 0;
  }
  // The only command that runs before a project exists: the repository is the cwd, or the parent of a `.sous` cwd.
  if (name === "init") {
    const cwd = process.cwd();
    return initCommand(args, { repoRoot: basename(cwd) === PROJECT_DIR ? dirname(cwd) : cwd, out: console.log, err: console.error });
  }
  const command = commands(projectRoot(process.cwd()))[name];
  if (command === undefined) {
    console.error(`sous: unknown command "${name}"\n${USAGE}`);
    return 2;
  }
  return command(args);
};

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
