/**
 * A run supplies `sous-factory` to the project's modules: a project without
 * `node_modules`, or with its own install on another version, sees the
 * running engine. The "not registered" side lives in its own file, since
 * the hook is process-wide once registered.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "../../src/config/engine.js";
import { SousError } from "../../src/index.js";
import { DONE, type Flow, type LoadedEntry } from "../../src/config/flow.js";
import { isAgentic, loadStep } from "../../src/config/step.js";
import { useRunningEngine } from "../../src/exec/imports.js";
import { loadTracker } from "../../src/tracker.js";
import { CLAUDE, portsOf } from "../fakes/executor.js";
import { walk } from "../fakes/index.js";
import { fakeSandbox } from "../fakes/sandbox.js";

/** What every project module reports: whose `sous-factory` it got. */
const SEEN = `
import * as engine from "sous-factory";
import { ENGINE_VERSION } from "sous-factory/read";
import { ctxOf } from "sous-factory/testing";

export const seen = () => ({
  marker: (engine as Record<string, unknown>)["MARKER"] ?? null,
  error: typeof engine.SousError,
  engine: ENGINE_VERSION,
  testing: typeof ctxOf,
});
`;

const RUNNING = { marker: null, error: "function", engine: ENGINE_VERSION, testing: "function" };

const STEPS: Record<string, string> = {
  "seen.ts": SEEN,
  "steps/imports/step.yaml": "name: imports\ndescription: Reports what it imported.\nrun:\n  module: ./run.ts\neval: ./eval.ts\n",
  "steps/imports/run.ts": `import { seen } from "../../seen.ts";\nexport default async () => ({ summary: "imports", commits: [], output: seen() });\n`,
  "steps/imports/eval.ts": `import { seen } from "../../seen.ts";\nexport default async () => ({ ok: true, log: JSON.stringify(seen()) });\n`,
  "steps/prepared/step.yaml":
    "name: prepared\ndescription: A prepare that reports what it imported.\nprepare:\n  module: ./prepare.ts\n  output: { type: object }\nrun:\n  prompt: prompt.md\n  output: { type: object }\n",
  "steps/prepared/prompt.md": "never sent\n",
  "steps/prepared/prepare.ts": `import { seen } from "../../seen.ts";\nexport default async () => ({ agent: "never", reason: "seen", output: seen() });\n`,
  "trackers/custom.ts": `import { fakeTracker } from "sous-factory/testing";\nimport { seen } from "../seen.ts";\nexport default () => ({ ...fakeTracker(), seen: seen() });\n`,
};

let repoRoot: string;
let root: string;

const write = async (files: Record<string, string>): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

const entry = (id: string, uses: string, to: string): LoadedEntry => {
  const step = loadStep(join(root, "steps", uses));
  return { id, uses, with: {}, routes: [{ to }], ...(isAgentic(step) ? { agent: CLAUDE } : {}), step };
};

const runImports = async () => {
  const flow: Flow = { name: "imports", file: join(root, "flows", "imports.yaml"), entry: "imports", steps: [entry("imports", "imports", "prepared"), entry("prepared", "prepared", DONE)] };
  const final = await walk(flow, portsOf(fakeSandbox({ worktreePath: repoRoot })));
  const steps = final.scopes[final.work] ?? {};
  return { final, run: steps["imports"]?.output, eval: JSON.parse(steps["imports"]?.log ?? "null") as unknown, prepare: steps["prepared"]?.prepared?.output };
};

/** A stub install of a package under the project's `node_modules`. */
const stubPackage = (name: string, source: string): Record<string, string> => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({ name, type: "module", exports: { ".": "./index.js", "./read": "./index.js", "./testing": "./index.js" } }),
  [`node_modules/${name}/index.js`]: source,
});

beforeAll(async () => {
  await useRunningEngine();
});

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "sous-imports-"));
  root = join(repoRoot, ".sous");
  await write({ "package.json": '{ "type": "module" }\n', ...STEPS });
});
afterEach(() => rm(repoRoot, { recursive: true, force: true }));

describe("the running engine as sous-factory", () => {
  it("runs a project without node_modules to done: run, eval and prepare see the running engine", async () => {
    const { final, run, eval: evaluated, prepare } = await runImports();

    expect(final.current).toBe(DONE);
    expect(run).toEqual(RUNNING);
    expect(evaluated).toEqual(RUNNING);
    expect(prepare).toEqual(RUNNING);
  });

  it("wins over the project's own install, while other packages still resolve through it", async () => {
    await write({
      ...stubPackage("sous-factory", 'export const MARKER = "stub"; export const SousError = Error; export const ENGINE_VERSION = "0.0.0-stub"; export const ctxOf = 1;\n'),
      ...stubPackage("helper", 'export const helper = "from the project";\n'),
      "steps/imports/run.ts": `import { seen } from "../../seen.ts";\nimport { helper } from "helper";\nexport default async () => ({ summary: "imports", commits: [], output: { ...seen(), helper } });\n`,
    });

    const { final, run } = await runImports();

    expect(final.current).toBe(DONE);
    expect(run).toEqual({ ...RUNNING, helper: "from the project" });
  });

  it("loads a tracker module under .sous/trackers/ the same way", async () => {
    const tracker = (await loadTracker({ tracker: { type: "trackers/custom.ts", shared: false, labels: "sous" } }, { root, repoRoot, runsDir: join(root, "runs") })) as unknown as { seen: unknown };

    expect(tracker.seen).toEqual(RUNNING);
  });

  it("hands a tracker module the engine's own exported classes, the same objects the engine uses", async () => {
    await write({ "trackers/classes.ts": `import { SousError } from "sous-factory";\nimport { fakeTracker } from "sous-factory/testing";\nexport default () => ({ ...fakeTracker(), SousError });\n` });

    const tracker = (await loadTracker({ tracker: { type: "trackers/classes.ts", shared: false, labels: "sous" } }, { root, repoRoot, runsDir: join(root, "runs") })) as unknown as { SousError: unknown };

    expect(tracker.SousError).toBe(SousError);
  });

  it("lets a step see an error the engine throws as instanceof SousError, in run and eval alike", async () => {
    const caught = (kind: string) =>
      `import { SousError } from "sous-factory";\nconst caught = (ctx) => { try { ctx.readFile("no-such-file"); return "nothing thrown"; } catch (error) { return error instanceof SousError; } };\n${kind}`;
    await write({
      "steps/imports/run.ts": caught(`export default async (ctx) => ({ summary: "caught", commits: [], output: caught(ctx) });\n`),
      "steps/imports/eval.ts": caught(`export default async (ctx) => ({ ok: true, log: JSON.stringify(caught(ctx)) });\n`),
    });

    const { run, eval: evaluated } = await runImports();

    expect(run).toBe(true);
    expect(evaluated).toBe(true);
  });

  it("fails a step importing a package the project lacks with Node's message naming the module and the step file", async () => {
    await write({ "steps/imports/run.ts": `import { nothing } from "not-installed-here";\nexport default async () => ({ summary: String(nothing), commits: [], output: {} });\n` });

    await expect(runImports()).rejects.toThrow(/Cannot find package 'not-installed-here' imported from .*steps\/imports\/run\.ts/);
  });
});
