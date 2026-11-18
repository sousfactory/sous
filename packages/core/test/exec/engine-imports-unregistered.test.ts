/**
 * Outside `run` and `watch` nothing maps `sous-factory`: a project's own
 * vitest imports the executor (through `sous-factory/testing`) and keeps
 * resolving the package through its install. Its own file, since the
 * hook is process-wide once a test registers it.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DONE } from "../../src/config/flow.js";
import { loadStep } from "../../src/config/step.js";
import { portsOf } from "../fakes/executor.js";
import { walk } from "../fakes/index.js";
import { fakeSandbox } from "../fakes/sandbox.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "sous-unregistered-"));
  const files: Record<string, string> = {
    "package.json": '{ "type": "module" }\n',
    "node_modules/sous-factory/package.json": JSON.stringify({ name: "sous-factory", type: "module", exports: "./index.js" }),
    "node_modules/sous-factory/index.js": 'export const MARKER = "the project\'s install";\n',
    "steps/imports/step.yaml": "name: imports\ndescription: Reports what it imported.\nrun:\n  module: ./run.ts\n",
    "steps/imports/run.ts": `import * as engine from "sous-factory";\nexport default async () => ({ summary: "imports", commits: [], output: { marker: (engine as Record<string, unknown>)["MARKER"] } });\n`,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repoRoot, ".sous", path)), { recursive: true });
    await writeFile(join(repoRoot, ".sous", path), content);
  }
});
afterEach(() => rm(repoRoot, { recursive: true, force: true }));

it("leaves sous-factory to the project's install when the executor runs outside run and watch", async () => {
  const step = loadStep(join(repoRoot, ".sous", "steps", "imports"));
  const final = await walk(
    { name: "imports", file: join(repoRoot, ".sous", "flows", "imports.yaml"), entry: "imports", steps: [{ id: "imports", uses: "imports", with: {}, routes: [{ to: DONE }], step }] },
    portsOf(fakeSandbox({ worktreePath: repoRoot })),
  );

  expect(final.current).toBe(DONE);
  expect(final.scopes[final.work]?.["imports"]?.output).toEqual({ marker: "the project's install" });
});
