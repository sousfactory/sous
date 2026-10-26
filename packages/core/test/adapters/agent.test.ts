import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envelopeSchema, lastTagContent, parseEnvelope, unwrapFences } from "../../src/adapters/agent.js";
import { ensureLogDir, logDir, logName, logPath, withAttempt } from "../../src/adapters/logs.js";
import { skillsSchema } from "../../src/skills.js";

const workSchema = {
  type: "object",
  required: ["filesTouched", "testsRun"],
  properties: { filesTouched: { type: "array", items: { type: "string" } }, testsRun: { type: "array", items: { type: "string" } } },
};
const reviewSchema = {
  type: "object",
  required: ["verdict", "findings"],
  properties: { verdict: { enum: ["clean", "findings"] }, findings: { type: "array" } },
};

const work = { summary: "done", commits: ["abc"], output: { filesTouched: ["a.kt"], testsRun: ["./gradlew test"] }, skills: [{ name: "tdd", status: "followed" }] };
const tagged = (body: string): string => `thinking…\n<result>${body}</result>\n`;

describe("logs", () => {
  const call = { spanId: "a1b2c3d4-3", scope: "12", step: "build", iteration: 2 };
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sous-logs-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("names one log per agent call under logsDir, after span, scope, step and iteration, with a suffix for the in-session output retry", () => {
    expect(logDir("/p/logs", "12")).toBe("/p/logs/12");
    expect(logName(call)).toBe("a1b2c3d4-3-12-build-2.log");
    expect(logPath("/p/logs", "12", call)).toBe("/p/logs/12/a1b2c3d4-3-12-build-2.log");
    expect(logPath("/p/logs", "12", call, 2)).toBe("/p/logs/12/a1b2c3d4-3-12-build-2.2.log");
    expect(logPath("/p/logs", "12", { ...call, step: "review-full", iteration: 1 })).toBe("/p/logs/12/a1b2c3d4-3-12-review-full-1.log");
  });

  it("never names two agent calls alike: other work item, re-visit of the step, other run segment", () => {
    const names = [
      call,
      { ...call, scope: "13" },
      { ...call, spanId: "a1b2c3d4-5" },
      { ...call, spanId: "e5f6a7b8-3" },
    ].map((c) => logName(c));
    expect(new Set(names).size).toBe(names.length);
  });

  it("withAttempt derives the retry file from the call's file and back", () => {
    const first = logPath("/p/logs", "12", { ...call, iteration: 1 });
    expect(withAttempt(first, 2)).toBe("/p/logs/12/a1b2c3d4-3-12-build-1.2.log");
    expect(withAttempt(withAttempt(first, 2), 3)).toBe("/p/logs/12/a1b2c3d4-3-12-build-1.3.log");
    expect(withAttempt(withAttempt(first, 2), 1)).toBe(first);
    expect(withAttempt("/p/logs/12/build-1.log", 2)).toBe("/p/logs/12/build-1.2.log");
  });

  it("ensureLogDir is idempotent", async () => {
    expect(await ensureLogDir(root, "3")).toBe(logDir(root, "3"));
    expect(await ensureLogDir(root, "3")).toBe(logDir(root, "3"));
  });
});

describe("envelope extraction", () => {
  it("takes the last complete <result> block", () => {
    expect(lastTagContent("<result>one</result> text <result>two</result> <result>open")).toBe("two");
    expect(lastTagContent("no tag here")).toBeUndefined();
    expect(lastTagContent("<result>unterminated")).toBeUndefined();
  });

  it("unwraps a json fence", () => {
    expect(unwrapFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(unwrapFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(unwrapFences('{"a":1}')).toBe('{"a":1}');
  });

  it("wraps the step's output schema in the envelope schema", () => {
    expect(envelopeSchema(workSchema)).toEqual({
      type: "object",
      required: ["summary", "commits", "output", "skills"],
      properties: { summary: { type: "string" }, commits: { type: "array", items: { type: "string" } }, output: workSchema, skills: skillsSchema },
    });
  });

  it("parses a valid envelope, fenced or not", () => {
    expect(parseEnvelope(tagged(JSON.stringify(work)), workSchema)).toEqual({ ok: true, envelope: work });
    expect(parseEnvelope(tagged(`\`\`\`json\n${JSON.stringify(work)}\n\`\`\``), workSchema)).toEqual({ ok: true, envelope: work });
  });

  it("reports a missing tag, invalid JSON, envelope and output schema failures with the raw match", () => {
    expect(parseEnvelope("nothing", workSchema)).toEqual({ ok: false, reason: "no <result> tag in the agent output", rawMatched: undefined });
    const bad = parseEnvelope(tagged("{not json"), workSchema);
    expect(bad).toMatchObject({ ok: false, rawMatched: "{not json" });
    expect(bad.ok === false && bad.reason).toContain("not valid JSON");

    const noSkills = parseEnvelope(tagged('{"summary":"s","commits":[],"output":{"filesTouched":[],"testsRun":[]}}'), workSchema);
    expect(noSkills.ok === false && noSkills.reason).toContain("must have required property 'skills'");

    const badStatus = parseEnvelope(tagged('{"summary":"s","commits":[],"output":{"filesTouched":[],"testsRun":[]},"skills":[{"name":"tdd","status":"read"}]}'), workSchema);
    expect(badStatus.ok === false && badStatus.reason).toContain("/skills/0/status must be equal to one of the allowed values");

    const noCommits = parseEnvelope(tagged('{"summary":"s","output":{"filesTouched":[],"testsRun":[]}}'), workSchema);
    expect(noCommits.ok === false && noCommits.reason).toContain("must have required property 'commits'");

    const blockers = parseEnvelope(tagged('{"summary":"s","commits":[],"blockers":[],"payload":{}}'), workSchema);
    expect(blockers.ok === false && blockers.reason).toContain("must have required property 'output'");

    const review = parseEnvelope(tagged('{"summary":"s","commits":[],"output":{"verdict":"meh","findings":[]}}'), reviewSchema);
    expect(review.ok).toBe(false);
    expect(review.ok === false && review.reason).toContain("/output/verdict must be equal to one of the allowed values");
  });
});
