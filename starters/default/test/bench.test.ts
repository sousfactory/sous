/** The bench flow's sample steps, over a `Ctx` from `sous-factory/testing`. */
import { describe, expect, it } from "vitest";
import { ctxOf } from "sous-factory/testing";
import helloWorld, { greet } from "../steps/hello-world/run.js";
import jokeEval, { MAX_LINE, problems } from "../steps/tell-a-joke/eval.js";

const joke = (setup: string, punchline: string) => ({ summary: "told", commits: [], output: { setup, punchline } });

describe("hello-world", () => {
  it("greets the given name and reports the work item and worktree", async () => {
    const { ctx } = ctxOf({ worktree: "/tmp/wt" });
    const out = await helloWorld(ctx, { name: "  Some feature " });
    expect(out).toEqual({ summary: "hello-world: Hello, Some feature! (work #1 in /tmp/wt)", commits: [], output: { greeting: "Hello, Some feature!", name: "Some feature", work: "1" } });
  });

  it("greets the world without a usable name", async () => {
    const { ctx } = ctxOf();
    expect((await helloWorld(ctx, {}))?.output).toMatchObject({ greeting: "Hello, world!", name: "world" });
    expect((await helloWorld(ctx, { name: "   " }))?.output).toMatchObject({ name: "world" });
    expect(greet("x")).toBe("Hello, x!");
  });
});

describe("tell-a-joke eval", () => {
  const { ctx } = ctxOf();

  it("passes a joke with a punchline of its own", async () => {
    expect(problems({ setup: "Why did the issue cross the road?", punchline: "To get merged." })).toEqual([]);
    expect(await jokeEval(ctx, { topic: "issues" }, joke("Why did the issue cross the road?", "To get merged."))).toEqual({ ok: true, log: "a joke with a setup and a punchline" });
  });

  it("fails a punchline that repeats the setup, or a line over the limit, naming each problem", async () => {
    expect(problems({ setup: "Knock knock.", punchline: " knock KNOCK. " })).toEqual(["the punchline repeats the setup"]);
    const long = "x".repeat(MAX_LINE + 1);
    expect(problems({ setup: long, punchline: long })).toEqual(["the punchline repeats the setup", `the setup is ${MAX_LINE + 1} characters, more than ${MAX_LINE}`, `the punchline is ${MAX_LINE + 1} characters, more than ${MAX_LINE}`]);
    expect(await jokeEval(ctx, { topic: "t" }, joke("Same line.", "Same line."))).toEqual({ ok: false, log: "- the punchline repeats the setup" });
  });

  it("fails without a result", async () => {
    expect(await jokeEval(ctx, { topic: "t" })).toEqual({ ok: false, log: "no joke was told" });
  });
});
