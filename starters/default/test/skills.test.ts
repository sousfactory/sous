/**
 * Skill pins. `skills/sous-run/SKILL.md` is read only by a human-driven
 * session, so nothing at run time would notice it losing an intent or a
 * guard rail; these tests pin the parts the CLI and the run phase rely on.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = dirname(root);

const SKILL = join(root, "skills", "sous-run", "SKILL.md");
const text = readFileSync(SKILL, "utf8");
/** The skill with every run of whitespace as one space, so a phrase matches however it is wrapped. */
const flat = text.replace(/\s+/g, " ");
/** The front matter's `key: value` lines; every value the skill uses fits on one line. */
const frontmatter: Record<string, string> = Object.fromEntries(
  (/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "").split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]),
);
const tracker = (type: string): string => readFileSync(join(root, "trackers", `${type}.md`), "utf8");

describe("the /sous-run skill", () => {
  it("is named sous-run, describes when the model invokes it, and is model-invocable", () => {
    expect(frontmatter.name).toBe("sous-run");
    expect(frontmatter.description).toMatch(/what is running/);
    expect(frontmatter.description).toContain("/sous-run");
    expect(frontmatter).not.toHaveProperty("disable-model-invocation");
    expect(text).toContain("$ARGUMENTS");
  });

  it("covers the four intents and the hand-off, one section each", () => {
    for (const heading of ["## Status", "## Start", "## Hand-off", "## Blocked", "## Report"]) expect(text, heading).toContain(`\n${heading}`);
  });

  it("reads the facts from the JSON forms with the project's engine, never from the plain text", () => {
    expect(flat).toContain("sous status --json");
    expect(flat).toContain("sous status <issue> --json");
    expect(flat).toContain("`cd .sous && ./sous`");
    expect(flat).toContain("Never parse the plain-text form");
  });

  it("answers status in the fixed layout: mode line, daemon and UI lines, the table, the notes", () => {
    const order = ["single repository <name>", "daemon: ", "ui: ", "| issue | title | state | step | since |", "done, see sous ui", "<notes> ```"].map((part) => flat.indexOf(part));
    for (const at of order) expect(at).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("sorts the table itself by state, then entry, then issue, and does not claim the JSON comes ordered", () => {
    expect(flat).toContain("Sort the rows by state (running, blocked, crashed, interrupted, ready), then by the entries' order in the JSON, then by issue");
    expect(flat).not.toContain("already comes in");
  });

  it("runs --restart only after the human confirmed, answering the engine's [y/N] in a foreground call, and reads restart cancelled as cancelled", () => {
    expect(flat).toContain("`[y/N]` on stdin");
    expect(flat).toContain("only after the human confirmed");
    expect(flat).toContain("in a foreground call");
    expect(flat).toMatch(/exit 1 with `restart cancelled` as a cancelled restart, not as blocked/);
  });

  it("counts a step's iterations as its spans' iterations entries, the re-entry eval after a block among them", () => {
    expect(flat).toContain("the number of `iterations` entries of its spans");
    expect(flat).toMatch(/re-entry eval after a block \(`n: 0`\) counts as one/);
  });

  it("starts only an issue named in the same turn, with name#issue in a home, --flow and --restart only when asked", () => {
    expect(flat).toContain("sous run <name>#<issue>");
    expect(flat).toContain("Name the issue back");
    expect(flat).toMatch(/`--flow <flow>` only when the human names a flow/);
    expect(flat).toMatch(/`--restart` only when the human says the branch is wrong/);
  });

  it("hands over and reads a blocked run through the tracker sheet's verbs, which every sheet defines", () => {
    expect(flat).toContain("**set ready**");
    expect(flat).toContain("**read the issue**");
    for (const type of ["github", "beads", "local"]) {
      expect(tracker(type), `${type}: set ready`).toContain("**Set ready:**");
      expect(tracker(type), `${type}: read the issue`).toContain("**Read the issue:**");
    }
  });

  it("offers the two documented paths out of blocked", () => {
    expect(flat).toContain("fix it in the worktree and run `sous run <issue>` again");
    expect(flat).toContain("amend with `/sous-plan <issue>` and run `sous run <issue>` again");
  });

  it("reports in a fixed order: runs, steps, agent and eval time, cost, where the time went", () => {
    const order = ["1. **Runs**", "2. **Steps**", "3. **Time**", "4. **Cost**", "5. **Where the time went**"].map((part) => flat.indexOf(part));
    for (const at of order) expect(at).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("states every guard rail", () => {
    for (const rail of [
      "Never run `sous run` unless the human named the issue in the same turn.",
      "Never push.",
      "Never edit a file under a worktree.",
      "Never close an issue.",
      "Never set a label other than `<labels>:ready`.",
      "Never run `sous watch`.",
    ])
      expect(flat, rail).toContain(rail);
  });

  // Absent until `sous init` installed it; the starter's own checkout has none.
  it.skipIf(!existsSync(join(repoRoot, ".claude", "skills", "sous-run", "SKILL.md")))("the installed skill is the starter's, unchanged", () => {
    expect(readFileSync(join(repoRoot, ".claude", "skills", "sous-run", "SKILL.md"), "utf8")).toBe(text);
  });
});
