/**
 * `sous ui [--port <n>]`: serves the app and the API on 127.0.0.1 until
 * interrupted. A dev checkout builds the app on first use; an installed
 * package ships it prebuilt. Loaded by core's CLI by path.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRootOf } from "sous-factory/read";
import { createGitHubLookup, ghIn } from "./github.js";
import { createUiServer } from "./http.js";
import { liveLock, openProject } from "./runs.js";
import { createFeed } from "./watch.js";

export const DEFAULT_PORT = 4680;
export const HOST = "127.0.0.1";
export const USAGE = "usage: sous ui [--port <n>]";

/** The UI folder, whether this file runs from `server/` or from the package's `dist/ui/dist-server/`. */
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DIST_DIR = join(UI_DIR, "dist");
/** Only a checkout with the vite source can build; a published package has no such thing. */
const canBuild = (): boolean => existsSync(join(UI_DIR, "vite.config.ts"));

/** The port from `--port <n>`; undefined for anything else. */
export const parseArgs = (args: readonly string[]): { port: number } | undefined => {
  if (args.length === 0) return { port: DEFAULT_PORT };
  if (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1] ?? "")) return undefined;
  const port = Number(args[1]);
  return port >= 1 && port <= 65535 ? { port } : undefined;
};

const build = (): boolean => {
  console.log("sous ui: building the app (first start)…");
  const result = spawnSync("npx", ["vite", "build"], { cwd: UI_DIR, stdio: "inherit" });
  return result.status === 0;
};

export const uiMain = async (args: string[], root: string): Promise<number> => {
  const parsed = parseArgs(args);
  if (parsed === undefined) {
    console.error(USAGE);
    return 2;
  }
  if (!existsSync(join(DIST_DIR, "index.html"))) {
    if (!canBuild()) {
      console.error(`sous ui: no app under ${DIST_DIR}; this package was published without it`);
      return 1;
    }
    if (!build()) {
      console.error("sous ui: the build failed");
      return 1;
    }
  }
  const project = openProject(root);
  const feed = createFeed({
    root,
    runsRoot: project.runsRoot,
    logsRoot: project.logsRoot,
    liveness: async () => JSON.stringify((await liveLock(project)) ?? null),
  });
  const server = createUiServer({ project, feed, distDir: DIST_DIR, github: createGitHubLookup(ghIn(repoRootOf(root))) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(parsed.port, HOST, resolve);
  }).catch((error: unknown) => {
    feed.close();
    throw new Error(`sous ui: cannot listen on ${HOST}:${parsed.port}: ${error instanceof Error ? error.message : String(error)}`);
  });
  console.log(`sous ui: http://${HOST}:${parsed.port}  (runs from ${project.runsRoot}; ctrl-c stops)`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  feed.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  return 0;
};
