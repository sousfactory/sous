/**
 * Prompt pins. A step's inputs are exactly its prompt's placeholders, so the
 * flow decides only what varies per step; rules, spec path, skills folder and
 * test command reach the agent by convention, never as inputs.
 * `prompts/plan.md` is read only by a human-driven session, so nothing at run
 * time would notice it drifting from what the run phase expects; these
 * tests pin those parts.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFlow, loadStep, type Step } from "sous-factory";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = dirname(root);

/** Every step folder the flows use, once each. */
const stepDirs = (flows: readonly string[]): string[] => [...new Set(flows.flatMap((name) => loadFlow(join(root, "flows", `${name}.yaml`), { stepsDir: join(root, "steps") }).steps.map((e) => e.step.dir)))].sort();

const LIFECYCLE_STEPS = ["close-work", "init", "merge", "next-work", "sync-resolve"];
// verify is not a flow step: its eval judges implement, fix and sync-resolve.
const WORK_STEPS = ["fix", "implement", "review"];

describe("step prompts", () => {
  it("the delivery flows use the five lifecycle steps and the three work steps; bench uses the two sample steps", () => {
    expect(stepDirs(["feature", "task"]).map((d) => d.replace(`${root}/`, ""))).toEqual([...LIFECYCLE_STEPS, ...WORK_STEPS].sort().map((n) => `steps/${n}`));
    expect(stepDirs(["bench"]).map((d) => d.replace(`${root}/`, ""))).toEqual(["steps/hello-world", "steps/tell-a-joke"]);
  });

  it.each(stepDirs(["bench", "feature", "task"]).map((dir) => [dir.replace(`${root}/`, ""), dir]))("%s: prompt placeholders equal the declared inputs", (_name, dir) => {
    const step: Step = loadStep(dir);
    // An input with prompt: false is read by prepare or eval, never by the prompt.
    const declared = Object.entries(step.inputs)
      .filter(([, input]) => input.prompt !== false)
      .map(([name]) => name)
      .sort();
    // {{prepared.*}} comes from the step's prepare, not from an input; validate checks it against prepare.output.
    const placeholders = [...step.placeholders].filter((p) => !p.startsWith("ctx.") && !p.startsWith("prepared.")).sort();
    if (step.run?.kind === "prompt") {
      expect(placeholders).toEqual(declared);
      expect(step.run.prompt).not.toMatch(/!`/);
    } else {
      expect(placeholders).toEqual([]);
    }
  });

  it("verify is eval-only with no inputs: the checks are its own file's", () => {
    const verify = loadStep(join(root, "steps", "verify"));
    expect(verify.run).toBeUndefined();
    expect(verify.eval).toEqual({ kind: "module", module: join(root, "steps", "verify", "eval.ts") });
    expect(verify.inputs).toEqual({});
  });

  it("implement and fix are judged by the verify eval, not by the agent's word; review by its own eval", () => {
    const verifyEval = { kind: "module", module: join(root, "steps", "verify", "eval.ts") };
    for (const name of ["implement", "fix"]) {
      const step = loadStep(join(root, "steps", name));
      expect(step.eval, `${name} eval`).toEqual(verifyEval);
      expect(step.maxIterations).toBe(3);
      expect(step.loop).toBe(true);
    }
    const review = loadStep(join(root, "steps", "review"));
    expect(review.eval).toEqual({ kind: "module", module: join(root, "steps", "review", "eval.ts") });
    expect(review.maxIterations).toBe(2);
    expect(review.loop).toBe(false);
  });

  it("inputs are per-step decisions only: no rules, spec path, skills folder or check commands (convention over configuration)", () => {
    expect(Object.keys(loadStep(join(root, "steps", "implement")).inputs)).toEqual(["task"]);
    expect(Object.keys(loadStep(join(root, "steps", "fix")).inputs)).toEqual(["input", "inputKind", "diffRange"]);
    expect(Object.keys(loadStep(join(root, "steps", "review")).inputs)).toEqual(["diffRange", "criteria"]);
    for (const dir of stepDirs(["feature", "task"])) {
      for (const banned of ["rules", "specPath", "skillsDir"]) expect(loadStep(dir).inputs, `${dir} has no ${banned} input`).not.toHaveProperty(banned);
    }
  });

  it("the project prompts are a thin layer over the skills: point at the skill via ctx.skillsDir, keep the autonomous-agent rules, repeat no repository document", () => {
    const SKILL: Record<string, string> = { implement: "implement/SKILL.md", review: "code-review/SKILL.md", fix: "tdd/SKILL.md" };
    for (const name of ["implement", "review", "fix"]) {
      const step = loadStep(join(root, "steps", name));
      if (step.run?.kind !== "prompt") throw new Error(`${name} is not a prompt step`);
      const text = step.run.prompt;
      expect(text, `${name}: points at the vendored skill`).toContain(`{{ctx.skillsDir}}/${SKILL[name]}`);
      expect(text, `${name}: keeps the no-tracker rule`).toMatch(/issue tracker/);
      expect(text, `${name}: the output contract is core's`).not.toMatch(/<result>|Output contract/);
      expect(text, `${name}: no label names`).not.toMatch(/sous:|fcli:/);
      expect(text, `${name}: no test command; the eval runs it`).not.toMatch(/gradle/i);
      expect(text, `${name}: no commit-message rules; CONTRIBUTING has them`).not.toMatch(/Conventional subject|Co-Authored-By|Refs #/);
      expect(text, `${name}: no quoted rule files; CLAUDE.md links them`).not.toMatch(/CODING_STANDARDS|Repository rules/);
      if (name === "review") expect(text, "review is read-only").toMatch(/Read-only/);
      else {
        expect(text, `${name}: the branch rule the executor relies on`).toMatch(/never push/);
        expect(text, `${name}: no full test suite run; the eval runs it`).toMatch(/[Dd]o not run the full test suite/);
        expect(text, `${name}: a criterion naming the build or the suite defers to the eval`).toMatch(/criterion names a full build or the test suite, this\s+step's evaluation is the authority/);
        expect(text, `${name}: such a criterion is reported as covered, not unconfirmed`).toMatch(/covered by the evaluation, not as unconfirmed/);
      }
    }
  });
});

const plan = readFileSync(join(root, "prompts", "plan.md"), "utf8");
const planBeads = readFileSync(join(root, "prompts", "plan.beads.md"), "utf8");

/** Both plan prompts; `ref` is how each writes the issue in text. */
const PLANS: [string, string, string][] = [
  ["plan.md", plan, "#<ISSUE>"],
  ["plan.beads.md", planBeads, "<ISSUE>"],
];

/** Vendored skill files the prompt must send the session to. */
const REQUIRED_SKILLS = [
  ".sous/skills/grill-with-docs/SKILL.md",
  ".sous/skills/grilling/SKILL.md",
  ".sous/skills/domain-modeling/SKILL.md",
  ".sous/skills/domain-modeling/ADR-FORMAT.md",
  ".sous/skills/domain-modeling/CONTEXT-FORMAT.md",
  ".sous/skills/to-spec/SKILL.md",
  ".sous/skills/to-tickets/SKILL.md",
];

/** The standard spec headings the plan prompt asks for, in this order. */
const SPEC_HEADINGS = ["Problem Statement", "Solution", "User Stories", "Implementation Decisions", "Testing Decisions", "Out of Scope", "Further Notes"];

describe("step READMEs", () => {
  const stepNames = readdirSync(join(root, "steps"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

  it.each(stepNames)("steps/%s has a short README.md in the shared format", (name) => {
    const file = join(root, "steps", name, "README.md");
    expect(existsSync(file), `${file} exists`).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text.startsWith(`# ${name}\n`)).toBe(true);
    for (const row of ["Kind", "Inputs", "Output", "Eval", "Used by"]) expect(text, `${name}: ${row} row`).toContain(`| ${row} |`);
    expect(text.split("\n").length).toBeLessThanOrEqual(20);
  });
});

describe("the /sous-plan skill and the plan prompts", () => {
  // Absent until `sous init` installed them; the starter's own checkout has none.
  it.skipIf(!existsSync(join(repoRoot, ".claude", "skills", "sous-plan", "SKILL.md")))("the installed skill is the starter's, unchanged", () => {
    expect(readFileSync(join(repoRoot, ".claude", "skills", "sous-plan", "SKILL.md"), "utf8")).toBe(readFileSync(join(root, "skills", "sous-plan", "SKILL.md"), "utf8"));
  });

  it.each(PLANS)("%s keeps its ADAPT notes, so a new project sees what to change", (_name, text) => {
    expect(text.match(/<!-- ADAPT: /g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });
});

describe.each(PLANS)("prompts/%s", (_name, text, ref) => {
  it("exists, is not empty and no longer names fcli", () => {
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).not.toMatch(/fcli|\.factory-cli/);
    expect(text).toContain("github.com/sousfactory/sous/blob/main/docs/manual.md");
  });

  it("points at every vendored skill it relies on", () => {
    for (const path of REQUIRED_SKILLS) expect(text, `missing reference to ${path}`).toContain(path);
  });

  it("references only skill paths that exist under .sous/skills/", () => {
    const referenced = [...new Set([...text.matchAll(/\.sous\/skills\/[\w./-]+/g)].map((m) => m[0]))];
    expect(referenced.length).toBeGreaterThanOrEqual(REQUIRED_SKILLS.length);
    // `.sous/` is this folder, whatever it is called in a checkout of the starter itself.
    for (const path of referenced) expect(existsSync(join(root, path.replace(/^\.sous\//, ""))), `${path} does not exist`).toBe(true);
  });

  it("lists the standard spec headings in order", () => {
    const positions = SPEC_HEADINGS.map((h) => text.indexOf(`## ${h}`));
    for (const [i, pos] of positions.entries()) expect(pos, `## ${SPEC_HEADINGS[i]} not found`).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("spells out the spec header block and the slug rule", () => {
    expect(text).toContain("# Spec: <issue title>");
    expect(text).toContain(`- **Issue:** ${ref}`);
    expect(text).toContain("- **Status:** draft");
    expect(text).toContain("specs/<ISSUE>-<slug>/spec.md");
    expect(text).toContain("first four words");
    expect(text).toMatch(/specs\/(42|bd-a3f8)-add-csv-export-for\/spec\.md/);
  });

  it("keeps the repository's gate commands out of acceptance criteria, for slices and for a task/bug checklist", () => {
    expect(text).toContain("Criteria never name the repository's gate commands.");
    expect(text).toContain("observable behaviour or a named test");
    for (const command of ["./gradlew clean build", "./gradlew test", "npm test", "npm run typecheck"]) expect(text, `names ${command} as forbidden`).toContain(`\`${command}\``);
    expect(text).toContain("the run phase's evals own the gate");
    const rule = text.indexOf("Criteria never name the repository's gate commands.");
    const tasks = text.indexOf("### Tasks and bugs");
    expect(rule).toBeGreaterThan(text.indexOf("## Step 3: Slices"));
    expect(tasks).toBeGreaterThan(rule);
    expect(text.slice(tasks)).toContain("never a gate command");
  });

  it("covers the amend mode and the `sous:*` labels the run phase owns", () => {
    expect(text).toContain("## Amendment — <short title>");
    expect(text).toContain("`sous:*` labels");
  });

  it("has the GO gate before commit and push, without trailers or branches", () => {
    const gate = text.indexOf("ask for an explicit GO");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("git push origin main")).toBeGreaterThan(gate);
    expect(text).toContain(`git commit -m "spec(${ref}): spec"`);
    expect(text).toContain(`spec(${ref}): amend — <short title>`);
    expect(text).toContain("git pull --rebase origin main");
    expect(text).toContain("no `Co-Authored-By`");
    expect(text).toContain("never run `./sous`");
    expect(text).toContain("./sous run <flow> <ISSUE>");
    expect(text).toContain("`allowedLabels` include the");
    expect(text).not.toMatch(/sous run (task|feature)\b/);
  });

  it("contains no shell-expansion sequences", () => {
    expect(text).not.toMatch(/!`/);
  });
});

describe("prompts/plan.md speaks gh", () => {
  it("has the sub-issue body template the GitHub tracker parses", () => {
    expect(plan).toContain("## Parent");
    expect(plan).toContain("## What to build");
    expect(plan).toContain("## Acceptance criteria");
    expect(plan).toContain("## Blocked by");
    expect(plan).toContain("None — can start immediately");
    expect(plan).toContain("--label type:task");
    expect(plan).toContain("/sub_issues");
    expect(plan).toContain('-F sub_issue_id="$cid"');
  });

  it("covers the issue-less entry", () => {
    expect(plan).toContain("gh issue create");
    expect(plan).not.toMatch(/\bbd (create|show|update|dep)\b/);
  });
});

describe("prompts/plan.beads.md speaks bd", () => {
  it("creates the parent as an epic, the slices as children with blocks edges, and sets no label", () => {
    expect(planBeads).toContain("bd create --title \"<title>\" --type epic");
    expect(planBeads).toContain("--type task --parent <ISSUE>");
    expect(planBeads).toContain("--acceptance");
    expect(planBeads).toContain("bd dep add <child> --blocked-by <m>");
    expect(planBeads).toContain("bd show <ISSUE> --json");
    expect(planBeads).toContain("Never set a label");
    expect(planBeads).not.toMatch(/\bgh\b|## Blocked by|sub_issue/);
  });

  it("names the type-to-label mapping the beads tracker applies", () => {
    for (const label of ["type:feature", "type:task", "type:bug"]) expect(planBeads).toContain(label);
    expect(planBeads).toContain("epic or feature");
  });
});

describe("skills/sous-plan/SKILL.md", () => {
  const path = join(root, "skills", "sous-plan", "SKILL.md");

  it("exists, has frontmatter and points at .sous/prompts/plan.md", () => {
    expect(existsSync(path)).toBe(true);
    const skill = readFileSync(path, "utf8");
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toMatch(/^name: sous-plan$/m);
    expect(skill).toMatch(/^description: .+/m);
    expect(skill).toContain(".sous/prompts/plan.md");
    expect(skill).not.toMatch(/!`/);
  });
});

describe("skills/", () => {
  const skills = ["code-review", "domain-modeling", "grill-with-docs", "grilling", "implement", "resolving-merge-conflicts", "tdd", "to-spec", "to-tickets"];

  it("holds the vendored skills the prompts point at, with the vendoring note", () => {
    expect(existsSync(join(root, "skills", "VENDORED.md"))).toBe(true);
    expect(existsSync(join(root, "skills", "LICENSE-mattpocock-skills"))).toBe(true);
    for (const skill of skills) expect(existsSync(join(root, "skills", skill, "SKILL.md")), `${skill}/SKILL.md`).toBe(true);
  });
});
