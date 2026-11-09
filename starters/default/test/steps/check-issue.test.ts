import { describe, expect, it } from "vitest";
import { ctxOf, envelope, fakeTracker, issue } from "sous-factory/testing";
import evaluate from "../../steps/check-issue/eval.js";
import prepare from "../../steps/check-issue/prepare.js";

const GREP = { command: "grep -rn parseDate src/", result: "src/date.ts:3: export const parseDate = (s: string) => new Date(s);" };
const TEST = { command: "npx vitest run test/date.test.ts", result: "1 passed" };

const checked = (output: unknown) => envelope({ commits: [], output });

describe("check-issue eval", () => {
  it("passes an issue that holds, logging the evidence", async () => {
    const f = ctxOf();
    expect(await evaluate(f.ctx, {}, checked({ verdict: "holds", evidence: [GREP] }))).toEqual({
      ok: true,
      log: ["check-issue: #1 holds against the code", "$ grep -rn parseDate src/", "src/date.ts:3: export const parseDate = (s: string) => new Date(s);"].join("\n"),
    });
  });

  it("passes an unclear issue, since ambiguity resolves toward going on", async () => {
    const f = ctxOf();
    expect(await evaluate(f.ctx, {}, checked({ verdict: "unclear", evidence: [] }))).toEqual({ ok: true, log: "check-issue: #1 is unclear against the code; the run goes on" });
  });

  it("fails a fixed issue with the verdict and every command with its result, which becomes the blocked comment", async () => {
    const f = ctxOf();
    expect(await evaluate(f.ctx, {}, checked({ verdict: "fixed", evidence: [GREP, TEST] }))).toEqual({
      ok: false,
      log: [
        "check-issue: #1 no longer holds (fixed): the defect it describes is gone from the code. Close the issue on this evidence, or correct it and run it again.",
        "$ grep -rn parseDate src/",
        "src/date.ts:3: export const parseDate = (s: string) => new Date(s);",
        "$ npx vitest run test/date.test.ts",
        "1 passed",
      ].join("\n"),
    });
  });

  it("fails an issue resting on a false premise with the verdict and the evidence", async () => {
    const f = ctxOf();
    expect(await evaluate(f.ctx, {}, checked({ verdict: "false-premise", evidence: [GREP] }))).toEqual({
      ok: false,
      log: [
        "check-issue: #1 no longer holds (false-premise): what it claims is not what the code shows. Close or rewrite the issue on this evidence, and run it again.",
        "$ grep -rn parseDate src/",
        "src/date.ts:3: export const parseDate = (s: string) => new Date(s);",
      ].join("\n"),
    });
  });

  it("fails a blocking verdict without evidence: a verdict is a command and its result, never an assertion", async () => {
    const f = ctxOf();
    for (const verdict of ["fixed", "false-premise"]) {
      expect(await evaluate(f.ctx, {}, checked({ verdict, evidence: [] }))).toEqual({
        ok: false,
        log: `check-issue: the verdict ${verdict} comes without evidence; it needs each command run and its result`,
      });
    }
  });

  it("fails a missing or malformed output, so a check that did not happen never counts as holds", async () => {
    const f = ctxOf();
    expect(await evaluate(f.ctx, {})).toEqual({ ok: false, log: "check-issue: no check output" });
    expect(await evaluate(f.ctx, {}, checked({ evidence: [GREP] }))).toEqual({ ok: false, log: "check-issue: the output has no verdict of holds, fixed, false-premise or unclear" });
    expect(await evaluate(f.ctx, {}, checked({ verdict: "maybe", evidence: [GREP] }))).toEqual({ ok: false, log: "check-issue: the output has no verdict of holds, fixed, false-premise or unclear" });
    expect(await evaluate(f.ctx, {}, checked({ verdict: "holds", evidence: [{ command: "ls" }] }))).toEqual({ ok: false, log: "check-issue: the evidence is not a list of { command, result }" });
    expect(await evaluate(f.ctx, {}, checked({ verdict: "holds" }))).toEqual({ ok: false, log: "check-issue: the evidence is not a list of { command, result }" });
  });

  it("fails a closed issue the prepare found, with nothing for the agent to check", async () => {
    const f = ctxOf();
    expect(await evaluate(f.ctx, {}, undefined, { agent: "never", reason: "#1 is closed", output: { verdict: "closed" } })).toEqual({ ok: false, log: "check-issue: #1 is closed; nothing to check or build" });
  });
});

describe("check-issue prepare", () => {
  it("runs the agent on an open issue", async () => {
    const f = ctxOf();
    expect(await prepare(f.ctx, {})).toEqual({ agent: "always", output: { verdict: "open" } });
  });

  it("skips the agent on an issue a human closed since the run blocked on it", async () => {
    const tracker = fakeTracker({ issues: [issue({ id: "1", title: "Test issue", state: "closed" })] });
    const f = ctxOf({ tracker });
    expect(await prepare(f.ctx, {})).toEqual({ agent: "never", reason: "#1 is closed", output: { verdict: "closed" } });
  });

  it("asks the tracker about ctx.work, the child in a feature, not the parent", async () => {
    const tracker = fakeTracker({ issues: [issue({ id: "14", state: "closed" })] });
    const f = ctxOf({ tracker, work: { id: "14", ref: "#14", title: "Issue #14", body: "" } });
    expect(await prepare(f.ctx, {})).toEqual({ agent: "never", reason: "#14 is closed", output: { verdict: "closed" } });
  });
});
