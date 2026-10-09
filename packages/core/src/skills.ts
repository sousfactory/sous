/**
 * Skill accounting: agents tend to claim they followed a skill they never
 * opened. After each agent call the audit compares the skills the prompt
 * points to (transitively), the skills the envelope reports, and what the
 * tool calls show was actually read or invoked. Mismatches are warnings
 * only: they are logged and recorded as a `skills` event, nothing fails.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ToolCall } from "./ports/sandbox.js";

export const SKILL_STATUSES = ["followed", "not-applicable", "skipped"] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

/** One entry of the envelope's `skills` list: what the agent says it did with a skill. */
export type SkillReport = { name: string; status: SkillStatus; reason?: string };

/** `full` when some call read the whole `SKILL.md` or invoked the skill. */
export type SkillRead = { name: string; full: boolean };

export type SkillAudit = {
  expected: string[];
  reported: SkillReport[];
  read: SkillRead[];
  problems: string[];
};

export const skillsSchema: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    required: ["name", "status"],
    properties: {
      name: { type: "string" },
      status: { enum: [...SKILL_STATUSES] },
      reason: { type: "string" },
    },
  },
};

export const SKILLS_CONTRACT_LINE = '  "skills": [{ "name": "tdd", "status": "followed | not-applicable | skipped", "reason": "why, unless followed" }],';

export const SKILLS_CONTRACT = [
  "`skills` accounts for every skill these instructions point you to, directly",
  "or through another skill (a `SKILL.md` path or a `/name` reference), and",
  "every skill you read or invoked: `followed` means you read its `SKILL.md`",
  "in full and followed it; `not-applicable` means you read it in full and",
  "nothing in it applied; `skipped` means you did not follow it, and `reason`",
  "says why (an override in these instructions, for example). Read a skill",
  "in full before you mark it `followed`. The list is empty when no skill is",
  "involved.",
].join("\n");

/** Keyed on the last segment of `skillsDir`, since the agent may use a relative or an absolute path. */
type SkillPaths = {
  /** `<folder>/<name>/SKILL.md` anywhere in a text. */
  inText: RegExp;
  exact: RegExp;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const skillPaths = (skillsDir: string): SkillPaths => {
  const folder = escapeRegExp(basename(skillsDir));
  return {
    inText: new RegExp(`(?:^|[^A-Za-z0-9_-])${folder}/([a-z0-9][a-z0-9-]*)/SKILL\\.md`, "g"),
    exact: new RegExp(`(?:^|/)${folder}/([a-z0-9][a-z0-9-]*)/SKILL\\.md$`),
  };
};

/** `/tdd` or `` `/code-review` ``, but not a path segment such as `src/tdd`. */
const SLASH_REF = /(?<![\w./}-])\/([a-z][a-z0-9-]*)(?![\w/.-])/g;

const matches = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map((m) => m[1] ?? "");

/** `/<name>` counts only for a known skill, so ordinary slash words are not mistaken for one. */
const referencesIn = (text: string, known: ReadonlySet<string>, paths: SkillPaths): string[] => [
  ...matches(text, paths.inText),
  ...matches(text, SLASH_REF).filter((name) => known.has(name)),
];


const numberOf = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

/** Undefined when the stage is not `head`; a bare `head` reads 10 lines. */
const headLines = (stage: string): number | undefined => {
  const m = /^\s*head(?:\s+-n\s*(\d+)|\s+-(\d+))?(?:\s|$)/.exec(stage);
  if (m === null) return undefined;
  return Number(m[1] ?? m[2] ?? 10);
};

/**
 * Only a `cat` or a long enough `head` (and pipes into a long enough `head`)
 * counts as a full read; any other use of the path (`sed -n`, `grep`,
 * `tail`) is partial, since it may show the agent only a fragment.
 */
const shellReads = (command: string, lines: (name: string) => number, paths: SkillPaths): SkillRead[] =>
  command.split(/\n|;|&&|\|\|/).flatMap((segment) => {
    const names = matches(segment, paths.inText);
    if (names.length === 0) return [];
    const [first = "", ...rest] = segment.split("|");
    return names.map((name) => {
      const n = lines(name);
      const firstFull = /^\s*cat\s/.test(first) || (headLines(first) ?? 0) >= n;
      const restFull = rest.every((stage) => (headLines(stage) ?? 0) >= n);
      return { name, full: firstFull && restFull };
    });
  });

/** `lines` is the `SKILL.md` line count, Infinity when unknown so a bounded read is never full. */
const readsOf = (call: ToolCall, lines: (name: string) => number, paths: SkillPaths): SkillRead[] => {
  const { name, input } = call;
  if (name === "Skill" && typeof input["skill"] === "string") {
    const skill = input["skill"].split(":").at(-1) ?? "";
    return skill === "" ? [] : [{ name: skill, full: true }];
  }
  if (name === "Read" && typeof input["file_path"] === "string") {
    const skill = paths.exact.exec(input["file_path"].trim())?.[1];
    if (skill === undefined) return [];
    const offset = numberOf(input["offset"]) ?? 0;
    const limit = numberOf(input["limit"]) ?? Infinity;
    return [{ name: skill, full: offset <= 1 && limit >= lines(skill) }];
  }
  if (typeof input["command"] === "string") return shellReads(input["command"], lines, paths);
  return [];
};

/** Empty when the directory is missing, so a project without skills is not audited. */
const loadSkills = async (skillsDir: string): Promise<Map<string, string>> => {
  const texts = new Map<string, string>();
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return texts;
  }
  for (const entry of entries) {
    try {
      texts.set(entry, await readFile(join(skillsDir, entry, "SKILL.md"), "utf8"));
    } catch {
      // not a skill folder
    }
  }
  return texts;
};

const expectedOf = (prompt: string, skills: ReadonlyMap<string, string>, paths: SkillPaths): string[] => {
  const known = new Set(skills.keys());
  const found: string[] = [];
  const queue = referencesIn(prompt, known, paths);
  while (queue.length > 0) {
    const name = queue.shift() ?? "";
    if (found.includes(name)) continue;
    found.push(name);
    queue.push(...referencesIn(skills.get(name) ?? "", known, paths));
  }
  return found;
};

const lineCount = (text: string): number => text.replace(/\n$/, "").split("\n").length;

const merge = (reads: readonly SkillRead[]): SkillRead[] => {
  const byName = new Map<string, boolean>();
  for (const { name, full } of reads) byName.set(name, (byName.get(name) ?? false) || full);
  return [...byName].map(([name, full]) => ({ name, full }));
};

const problemsOf = (expected: readonly string[], reported: readonly SkillReport[], read: readonly SkillRead[]): string[] => {
  const reportedNames = new Set(reported.map((r) => r.name));
  const readOf = new Map(read.map((r) => [r.name, r.full]));
  const problems: string[] = [];
  for (const name of expected) {
    if (!reportedNames.has(name)) problems.push(`${name}: the instructions point to it, but the skills list leaves it out`);
  }
  for (const { name, status, reason } of reported) {
    const full = readOf.get(name);
    if (status !== "skipped" && full === undefined) problems.push(`${name}: reported ${status}, but it was never read`);
    else if (status !== "skipped" && full === false) problems.push(`${name}: reported ${status}, but it was only partly read`);
    if (status !== "followed" && (reason === undefined || reason.trim() === "")) problems.push(`${name}: reported ${status} without a reason`);
  }
  for (const { name, full } of read) {
    if (!reportedNames.has(name)) problems.push(`${name}: ${full ? "read" : "partly read"}, but the skills list leaves it out`);
  }
  return problems;
};

export type SkillCheck = {
  reported: readonly SkillReport[] | undefined;
  toolCalls: readonly ToolCall[] | undefined;
  /** The call continued an earlier session of this visit, whose reads still count. */
  resumed: boolean;
};

export type SkillAuditor = {
  /** Undefined when no skill is expected, reported or read. Never throws, since an audit must not fail a step. */
  check(call: SkillCheck): Promise<SkillAudit | undefined>;
};

/**
 * One auditor per step visit. It keeps the reads of the current agent
 * session, so a resumed call that does not read a skill again still counts
 * the earlier read.
 */
export const skillAudit = (prompt: string, skillsDir: string): SkillAuditor => {
  const paths = skillPaths(skillsDir);
  let skills: Promise<Map<string, string>> | undefined;
  let sessionReads: SkillRead[] = [];
  return {
    async check({ reported = [], toolCalls = [], resumed }) {
      skills ??= loadSkills(skillsDir);
      const texts = await skills;
      const lines = (name: string): number => {
        const text = texts.get(name);
        return text === undefined ? Infinity : lineCount(text);
      };
      sessionReads = merge([...(resumed ? sessionReads : []), ...toolCalls.flatMap((call) => readsOf(call, lines, paths))]);
      const expected = expectedOf(prompt, texts, paths);
      if (expected.length === 0 && reported.length === 0 && sessionReads.length === 0) return undefined;
      return { expected, reported: [...reported], read: sessionReads, problems: problemsOf(expected, reported, sessionReads) };
    },
  };
};
