// What the published package carries beside its own code: the starter kit
// `sous init` copies, and the UI's built client and server, so `npx sous`
// works from one install. Run after `tsc` and after the UI's own build.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const core = join(dirname(fileURLToPath(import.meta.url)), "..");
const starter = join(core, "..", "..", "starters", "github");
const ui = join(core, "..", "ui");

const skipped = new Set(["node_modules", "logs", "runs", "locks", ".lock"]);
rmSync(join(core, "starter"), { recursive: true, force: true });
cpSync(starter, join(core, "starter"), { recursive: true, filter: (src) => !skipped.has(src.split("/").at(-1) ?? "") });

for (const part of ["dist", "dist-server"]) {
  const from = join(ui, part);
  if (!existsSync(from)) {
    console.error(`bundle: ${from} is missing; build the UI first (npm run build -w packages/ui)`);
    process.exit(1);
  }
  rmSync(join(core, "dist", "ui", part), { recursive: true, force: true });
  cpSync(from, join(core, "dist", "ui", part), { recursive: true });
}
