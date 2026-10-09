import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolCall } from "../src/ports/sandbox.js";
import { skillAudit, type SkillReport } from "../src/skills.js";

const read = (path: string, extra: Record<string, unknown> = {}): ToolCall => ({ name: "Read", input: { file_path: path, ...extra } });
const bash = (command: string): ToolCall => ({ name: "Bash", input: { command } });
const followed = (name: string): SkillReport => ({ name, status: "followed" });

describe("skillAudit", () => {
  let dir: string;
  const skill = async (name: string, text: string) => {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "SKILL.md"), text);
  };
  const path = (name: string) => join(dir, name, "SKILL.md");

  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), "sous-skills-")), "skills");
    await skill("implement", "Implement it.\n\nUse /tdd where possible.\n\nOnce done, use `/code-review`.\n");
    await skill("tdd", Array.from({ length: 30 }, (_, i) => `rule ${i + 1}`).join("\n"));
    await skill("code-review", "Review. Run `/setup-matt-pocock-skills` if missing.\n");
    await skill("grilling", "Grill.\n");
  });
  afterEach(() => rm(join(dir, ".."), { recursive: true, force: true }));

  it("expects the skills the prompt points to and, transitively, the skills those point to; unknown /names are not skills", async () => {
    const audit = await skillAudit(`Follow \`${path("implement")}\`, then report.`, dir).check({
      reported: [followed("implement"), followed("tdd"), { name: "code-review", status: "skipped", reason: "the prompt says a reviewer runs later" }],
      toolCalls: [bash(`cat ${path("implement")}; cat ${path("tdd")}`)],
      resumed: false,
    });

    expect(audit).toEqual({
      expected: ["implement", "tdd", "code-review"],
      reported: [followed("implement"), followed("tdd"), { name: "code-review", status: "skipped", reason: "the prompt says a reviewer runs later" }],
      read: [
        { name: "implement", full: true },
        { name: "tdd", full: true },
      ],
      problems: [],
    });
  });

  it("recognizes skill paths under a skillsDir with another folder name", async () => {
    const vendored = join(dir, "..", "vendor.skills");
    await mkdir(join(vendored, "tdd"), { recursive: true });
    await writeFile(join(vendored, "tdd", "SKILL.md"), "red, green, refactor\n");
    const tdd = join(vendored, "tdd", "SKILL.md");
    const audit = await skillAudit(`Follow \`${tdd}\`.`, vendored).check({ reported: [followed("tdd")], toolCalls: [read(tdd)], resumed: false });

    expect(audit).toEqual({ expected: ["tdd"], reported: [followed("tdd")], read: [{ name: "tdd", full: true }], problems: [] });
    expect(await skillAudit(`Follow \`${path("tdd")}\`.`, vendored).check({ reported: [], toolCalls: [], resumed: false })).toBeUndefined();
  });

  it("reports an expected skill left out of the list, and a skip without a reason", async () => {
    const audit = await skillAudit("Use `/implement`.", dir).check({
      reported: [followed("implement"), { name: "tdd", status: "skipped" }],
      toolCalls: [read(path("implement"))],
      resumed: false,
    });

    expect(audit?.problems).toEqual(["code-review: the instructions point to it, but the skills list leaves it out", "tdd: reported skipped without a reason"]);
  });

  it("reports a skill claimed but never read, or only partly read", async () => {
    const audit = await skillAudit("Use /tdd and /grilling and /code-review.", dir).check({
      reported: [followed("tdd"), { name: "grilling", status: "not-applicable", reason: "nothing to grill" }, followed("code-review")],
      toolCalls: [bash(`cat ${path("tdd")} | head -20`), read(path("code-review"), { offset: 5 })],
      resumed: false,
    });

    expect(audit?.problems).toEqual([
      "tdd: reported followed, but it was only partly read",
      "grilling: reported not-applicable, but it was never read",
      "code-review: reported followed, but it was only partly read",
    ]);
  });

  it("counts a long enough head, a long enough Read limit and a Skill invocation as full reads; sed and grep are partial", async () => {
    const check = (toolCalls: ToolCall[]) => skillAudit("", dir).check({ reported: [], toolCalls, resumed: false });

    expect((await check([bash(`head -n 200 ${path("tdd")}`)]))?.read).toEqual([{ name: "tdd", full: true }]);
    expect((await check([bash(`cat -n ${path("tdd")} | head -30`)]))?.read).toEqual([{ name: "tdd", full: true }]);
    expect((await check([read(path("tdd"), { limit: 30 })]))?.read).toEqual([{ name: "tdd", full: true }]);
    expect((await check([read(path("tdd"), { limit: 29 })]))?.read).toEqual([{ name: "tdd", full: false }]);
    expect((await check([{ name: "Skill", input: { skill: "plugin:tdd" } }]))?.read).toEqual([{ name: "tdd", full: true }]);
    expect((await check([bash(`sed -n '1,10p' ${path("tdd")}`), bash(`grep rule ${path("grilling")}`)]))?.read).toEqual([
      { name: "tdd", full: false },
      { name: "grilling", full: false },
    ]);
  });

  it("reports a skill read but left out of the list", async () => {
    const audit = await skillAudit("No skills here.", dir).check({ reported: [], toolCalls: [read(path("grilling"))], resumed: false });

    expect(audit?.problems).toEqual(["grilling: read, but the skills list leaves it out"]);
  });

  it("keeps the reads of the session for a resumed call and forgets them for a fresh one", async () => {
    const auditor = skillAudit("Use /grilling.", dir);
    await auditor.check({ reported: [followed("grilling")], toolCalls: [read(path("grilling"))], resumed: false });

    expect((await auditor.check({ reported: [followed("grilling")], toolCalls: [], resumed: true }))?.problems).toEqual([]);
    expect((await auditor.check({ reported: [followed("grilling")], toolCalls: [], resumed: false }))?.problems).toEqual([
      "grilling: reported followed, but it was never read",
    ]);
  });

  it("has nothing to report when no skill is expected, reported or read, also without a skills directory", async () => {
    expect(await skillAudit("Just code.", dir).check({ reported: undefined, toolCalls: undefined, resumed: false })).toBeUndefined();
    expect(await skillAudit("Use /tdd.", join(dir, "missing")).check({ reported: [], toolCalls: [bash("ls")], resumed: false })).toBeUndefined();
  });
});
