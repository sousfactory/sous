import { describe, expect, it } from "vitest";
import { failedEvalSection, invalidOutputPrompt, outputContract, renderPrompt, retryPrompt } from "../../src/exec/prompt.js";
import { stepOf } from "../fakes/executor.js";
import { SKILLS_CONTRACT, SKILLS_CONTRACT_LINE } from "../../src/skills.js";

const ctx = { "ctx.issue.id": "12", "ctx.issue.ref": "#12", "ctx.work.id": "14", "ctx.worktree": "/wt", "ctx.specDir": "specs/12-x" };

describe("renderPrompt", () => {
  it("fills inputs and ctx placeholders, then appends the contract with the step's schema", () => {
    const text = renderPrompt(stepOf("agent"), { task: "the thing" }, ctx);
    expect(text).toBe(
      [
        "Do the thing in /wt for #12.",
        "",
        "## Output contract",
        "",
        "Finish your final message with exactly one block of this form, JSON only",
        "inside the tags, no code fences:",
        "",
        "<result>{",
        '  "summary": "two to five sentences on what you did and what you left open",',
        '  "commits": ["full sha of every commit you made, oldest first"],',
        '  "output": <value matching the JSON Schema below>,',
        SKILLS_CONTRACT_LINE,
        "}</result>",
        "",
        SKILLS_CONTRACT,
        "",
        JSON.stringify({ type: "object", properties: { ok: { type: "boolean" }, log: { type: "string" } } }, null, 2),
        "",
      ].join("\n"),
    );
  });

  it("stringifies non-string inputs and renders an unwired optional input empty", () => {
    const step = stepOf("echo-eval");
    const agentic = { ...stepOf("agent-plain"), inputs: { task: { required: true }, extra: { required: false } } };
    expect(renderPrompt(agentic, { task: ["a", "b"] }, ctx)).toContain("Task: [\"a\",\"b\"]");
    expect(renderPrompt({ ...agentic, run: { ...agentic.run, prompt: "{{task}}|{{extra}}|" } as NonNullable<typeof agentic.run> }, { task: "t" }, ctx)).toMatch(/^t\|\|\n/);
    expect(() => renderPrompt(step, {}, ctx)).toThrow("deterministic");
  });

  it("throws on a ctx placeholder that has no value", () => {
    const step = stepOf("agent-plain");
    const workPrompt = { ...step, run: { ...step.run, prompt: "work {{ctx.work.id}} {{task}}" } as NonNullable<typeof step.run> };
    expect(() => renderPrompt(workPrompt, { task: "t" }, { "ctx.issue.id": 1 })).toThrow("{{ctx.work.id}}");
    expect(renderPrompt(workPrompt, { task: "t" }, ctx)).toContain("work 14 t");
  });
});

describe("outputContract", () => {
  it("pretty-prints the schema after the fixed text", () => {
    const text = outputContract({ type: "object", required: ["sha"] });
    expect(text.startsWith("## Output contract\n\n")).toBe(true);
    expect(text.endsWith('{\n  "type": "object",\n  "required": [\n    "sha"\n  ]\n}')).toBe(true);
  });
});

describe("renderPrompt with a failed eval", () => {
  it("puts the eval section between the step's text and the contract", () => {
    const text = renderPrompt(stepOf("agent"), { task: "the thing" }, ctx, undefined, "BUILD FAILED\n");
    const section = failedEvalSection("BUILD FAILED\n");
    expect(text.startsWith(`Do the thing in /wt for #12.\n\n${section}\n\n## Output contract`)).toBe(true);
    expect(renderPrompt(stepOf("agent"), { task: "the thing" }, ctx)).not.toContain("## The evaluation already ran");
  });

  it("quotes the log in a fenced block and points back to the instructions and the contract", () => {
    expect(failedEvalSection("> Task :test FAILED\nBUILD FAILED\n")).toBe(
      [
        "## The evaluation already ran",
        "",
        "This step's evaluation ran before you, on the worktree as it is now, and",
        "did not pass. Its output:",
        "",
        "```",
        "> Task :test FAILED",
        "BUILD FAILED",
        "```",
        "",
        "Fix the cause, then follow the instructions above and answer with the",
        "result block below.",
      ].join("\n"),
    );
  });
});

describe("retryPrompt", () => {
  it("quotes the eval log in a fenced block and asks for the same contract", () => {
    const text = retryPrompt("> Task :test FAILED\nBUILD FAILED\n");
    expect(text).toBe(
      [
        "The previous attempt did not pass evaluation. Output:",
        "",
        "```",
        "> Task :test FAILED",
        "BUILD FAILED",
        "```",
        "",
        "Fix it, re-run the checks, commit, and answer again with the same",
        "`<result>{ … }</result>` block as before (summary, commits, output, skills).",
        "The rules of the original instructions still apply: current branch only,",
        "no push, clean working tree before answering.",
      ].join("\n"),
    );
  });
});

describe("invalidOutputPrompt", () => {
  it("names the reason, quotes the matched block and forbids further work", () => {
    const prompt = invalidOutputPrompt({ reason: "bad", rawMatched: "{x" });
    expect(prompt).toContain("Your output did not validate: bad");
    expect(prompt).toContain("Matched block:\n{x");
    expect(prompt).toContain("Do not change files or run commands");
    expect(invalidOutputPrompt({ reason: "bad", rawMatched: undefined })).toContain("No <result> block was found");
  });
});
