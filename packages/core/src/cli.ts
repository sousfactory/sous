/** The `sous` command: parses arguments and dispatches to a command. */
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { graphCommand } from "./commands/graph.js";
import { initCommand } from "./commands/init.js";
import { startRun, startWatch } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { validateCommand } from "./commands/validate.js";
import { PROJECT_DIR, projectRoot } from "./root.js";

export { PROJECT_DIR, projectRoot, repoRootOf } from "./root.js";

const USAGE = `usage:
  sous init [--starter <dir>] [--force] [--no-install] [<path>]
                                        copy a starter into .sous/ of this repository or <path>, install it, add the /sous-plan skill;
                                        --no-install: definitions only, no wrapper, no npm install, for a home repository's engine
  sous run <issue> [--flow <name>] [--restart] [--repo <name>]
                                        validate, then start or resume a run; the flow from the issue's labels unless named;
                                        in a home repository, in the repos: entry its repo: label or --repo names
  sous watch [--once] [--interval <s>]  start ready issues unattended, one run per repository at a time
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

const CLI_FILE = fileURLToPath(import.meta.url);

export const UI_MAIN = uiMainPath(CLI_FILE);

/** The UI package depends on core, so it is loaded by path at call time to keep core from depending on it back. */
const uiCommand = async (args: string[], root: string): Promise<number> => {
  const { uiMain } = (await import(pathToFileURL(UI_MAIN).href)) as {
    uiMain: (args: string[], root: string) => Promise<number>;
  };
  return uiMain(args, root);
};

const commands = (root: string): Record<string, Command> => {
  const io = { out: console.log, err: console.error };
  return {
    validate: (args) => validateCommand(args, { root, ...io }),
    graph: (args) => graphCommand(args, { root, ...io }),
    // The engine range first, then the settings and the tracker: see `start.ts`.
    run: (args) => startRun(args, { root, cliFile: CLI_FILE, ...io }),
    watch: (args) => startWatch(args, { root, cliFile: CLI_FILE, ...io }),
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
    return initCommand(args, { repoRoot: basename(cwd) === PROJECT_DIR ? dirname(cwd) : cwd, cwd, out: console.log, err: console.error });
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
