/** The `verify` eval with scripted `ctx.exec` results: the empty starter list, and a filled one. */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ctxOf, fail, fakeSandbox, ok, type FakeSandboxOptions } from "sous-factory/testing";
import type { EvalFn } from "sous-factory";
import verify, { BASE_BRANCH, CHECKS, checksFor, diffCommand, NO_CHECKS_WARNING, type Check } from "../steps/verify/eval.js";
import { checkedSteps, type CheckedSteps } from "./checked-steps.js";

const WORKTREE = "/tmp/wt";
export const DIFF = diffCommand(BASE_BRANCH);

const FULL: Check = { command: "npm test" };
const INFRA: Check = { command: "./gradlew build", dir: "infra", when: "infra" };
const WEB: Check[] = [
  { command: "npx tsc --noEmit", dir: "web", when: "web" },
  { command: "npx vitest run", dir: "web", when: "web" },
];
const FILLED = [FULL, INFRA, ...WEB];

/** A ctx whose shell answers per command; the diff lists `changed`. */
const setup = (changed: string[], exec: FakeSandboxOptions["exec"] = {}) => {
  const sandbox = fakeSandbox({ worktreePath: WORKTREE, exec: { [DIFF]: ok(changed.map((c) => `${c}\n`).join("")), ...exec } });
  return { ...ctxOf({ sandbox, worktree: WORKTREE }), sandbox };
};

describe("the starter's list", () => {
  it("is empty, diffs against main, and passes with a warning in the log until the project fills it in", async () => {
    expect(CHECKS).toEqual([]);
    expect(BASE_BRANCH).toBe("main");
    const f = setup(["src/A.ts"]);
    expect(await verify(f.ctx, {})).toEqual({ ok: true, log: NO_CHECKS_WARNING });
    expect(f.sandbox.execs).toEqual([]);
  });
});

describe("checksFor", () => {
  it("keeps the unconditional checks and the ones whose folder the diff touches", () => {
    expect(checksFor(FILLED, [])).toEqual([FULL]);
    expect(checksFor(FILLED, ["src/A.ts", "package.json"])).toEqual([FULL]);
    expect(checksFor(FILLED, ["infra/src/main/kotlin/App.kt"])).toEqual([FULL, INFRA]);
    expect(checksFor(FILLED, ["web/src/index.ts"])).toEqual([FULL, ...WEB]);
    expect(checksFor(FILLED, ["infra/App.kt", "web/x.ts", "src/A.ts"])).toEqual(FILLED);
  });

  it("matches the folder, not a prefix of a name", () => {
    expect(checksFor(FILLED, ["infrastructure.md", "web.bak/x"])).toEqual([FULL]);
    expect(checksFor(FILLED, ["infra"])).toEqual([FULL, INFRA]);
  });
});

describe("verify eval with a filled list", () => {
  let steps: CheckedSteps;
  let filled: EvalFn;
  beforeAll(async () => {
    steps = await checkedSteps(FILLED);
    filled = ((await import(join(steps.stepsDir, "verify", "eval.ts"))) as { default: EvalFn }).default;
  });
  afterAll(() => steps.remove());

  it("passes when every check passes and logs the transcript", async () => {
    const f = setup(["src/A.ts"], { "npm test": ok("Tests 3 passed\n") });
    expect(await filled(f.ctx, {})).toEqual({ ok: true, log: "$ npm test (exit 0)\nTests 3 passed" });
    expect(f.sandbox.execCalls).toEqual([
      { command: DIFF, cwd: undefined },
      { command: "npm test", cwd: undefined },
    ]);
  });

  it("stops at the first failure: a red first check runs nothing else", async () => {
    const f = setup(["infra/App.kt", "web/x.ts"], { "npm test": fail("1 failed\n", 1) });
    expect(await filled(f.ctx, {})).toEqual({ ok: false, log: "$ npm test (exit 1)\n1 failed" });
    expect(f.sandbox.execs).toEqual([DIFF, "npm test"]);
  });

  it("runs a check in its dir when the diff touches its when folder, stopping at the first red one", async () => {
    const f = setup(["infra/App.kt"], { "./gradlew build": ok("infra ok\n") });
    expect(await filled(f.ctx, {})).toEqual({ ok: true, log: "$ npm test (exit 0)\n$ cd infra && ./gradlew build (exit 0)\ninfra ok" });
    expect(f.sandbox.execCalls.slice(1)).toEqual([
      { command: "npm test", cwd: undefined },
      { command: "./gradlew build", cwd: join(WORKTREE, "infra") },
    ]);

    const red = setup(["web/x.ts"], { "npx tsc --noEmit": fail("x.ts(1,1): error TS2322\n", 2) });
    expect(await filled(red.ctx, {})).toEqual({ ok: false, log: "$ npm test (exit 0)\n$ cd web && npx tsc --noEmit (exit 2)\nx.ts(1,1): error TS2322" });
    expect(red.sandbox.execs).toEqual([DIFF, "npm test", "npx tsc --noEmit"]);
  });

  it("fails without running a check when the diff itself fails", async () => {
    const f = setup([], { [DIFF]: fail("fatal: bad revision 'main...HEAD'\n", 128) });
    expect(await filled(f.ctx, {})).toEqual({ ok: false, log: `$ ${DIFF} (exit 128)\nfatal: bad revision 'main...HEAD'` });
    expect(f.sandbox.execs).toEqual([DIFF]);
  });
});
