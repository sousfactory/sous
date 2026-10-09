/**
 * The `Tracker` port over bd, for `sous run <flow> <bead-id>`. Issues are
 * read live with `bd show`. The lifecycle writes to bd only when asked:
 * `claim` is `bd update --claim` under an actor naming the run's branch, so
 * two runs never take the same bead; `close` is `bd close`; `block` adds the
 * blocked label. Comments go to `<dir>/<id>/comments.md` (dir: the runs
 * folder), since bd has no comments. An epic's beads are its children, by
 * priority then age; `blocks` edges are the blockers.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SousError } from "../exec/errors.js";
import { stateLabels, swapStateLabel, type Tracker, type Issue } from "../ports/tracker.js";
import { safeId } from "../session/paths.js";
import { exec as defaultExec, type Exec } from "./exec.js";

type Dependency = { id?: string; depends_on_id?: string; type?: string; dependency_type?: string; status?: string };

type Bead = {
  id: string;
  title: string;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  issue_type?: string;
  status?: string;
  labels?: string[];
  parent?: string | null;
  priority?: number;
  created_at?: string;
  /** `bd show` expands each dependency to the bead with `dependency_type`; `bd list` keeps `{ depends_on_id, type }`. */
  dependencies?: Dependency[] | null;
};

/** bd's own labels, plus `type:*` for the bd type so flows' `allowedLabels` match without labelling by hand, and `bead:<id>` so a step can reach the bead in bd. */
export const labelsOf = (bead: Bead): string[] => {
  const type = bead.issue_type === "bug" ? "bug" : bead.issue_type === "feature" || bead.issue_type === "epic" ? "feature" : "task";
  return [...(bead.labels ?? []), `type:${type}`, `bead:${bead.id}`];
};

/** Work order inside an epic: highest priority (lowest number) first, then the oldest. */
export const compareBeads = (a: Bead, b: Bead): number =>
  (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) || (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id);

/** The bead's text as one issue body: description, then design, acceptance criteria and notes under headings. */
const bodyOf = (bead: Bead): string =>
  [
    bead.description ?? "",
    ...(bead.design ? [`## Design\n\n${bead.design}`] : []),
    ...(bead.acceptance_criteria ? [`## Acceptance Criteria\n\n${bead.acceptance_criteria}`] : []),
    ...(bead.notes ? [`## Notes\n\n${bead.notes}`] : []),
  ]
    .filter((part) => part !== "")
    .join("\n\n");

/** Who holds a claimed bead: the git user plus the run's branch, so a human and a run on the same machine stay apart. */
export const actorOf = (user: string, branch: string): string => `${user.trim() === "" ? "sous" : user.trim()} (sous:${branch})`;

export type BeadsOptions = { dir: string; cwd: string; labelPrefix?: string; exec?: Exec; clock?: () => Date };

export const createBeadsTracker = ({ dir, cwd, labelPrefix = "sous", exec = defaultExec, clock = () => new Date() }: BeadsOptions): Tracker => {
  const bd = async (args: readonly string[]): Promise<string> => {
    const result = await exec("bd", args, { cwd });
    if (result.code !== 0) throw new SousError(`beads: bd ${args.slice(0, 2).join(" ")} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout;
  };

  const json = async (args: readonly string[]): Promise<unknown> => {
    const stdout = await bd(args);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new SousError(`beads: bd ${args.join(" ")} printed no JSON`);
    }
  };

  const show = async (id: string): Promise<Bead> => {
    const payload = await json(["show", id, "--json"]);
    // bd prints an array of one object on a hit and an object with `error` on a miss.
    const first = Array.isArray(payload) ? (payload[0] as unknown) : undefined;
    if (typeof first !== "object" || first === null) throw new SousError(`beads: no bead ${id}`);
    return first as Bead;
  };

  const getIssue = async (id: string): Promise<Issue> => {
    const bead = await show(id);
    return { id: bead.id, ref: bead.id, title: bead.title, body: bodyOf(bead), labels: labelsOf(bead), state: bead.status === "closed" ? "closed" : "open" };
  };

  const setStateLabel = async (id: string, label: string): Promise<void> => {
    const { add, remove } = swapStateLabel((await getIssue(id)).labels, label);
    if (add.length === 0 && remove.length === 0) return;
    await bd(["update", id, ...add.flatMap((l) => ["--add-label", l]), ...remove.flatMap((l) => ["--remove-label", l])]);
  };

  const comment = async (id: string, body: string): Promise<void> => {
    await mkdir(join(dir, safeId(id)), { recursive: true });
    await appendFile(join(dir, safeId(id), "comments.md"), `## ${clock().toISOString()}\n\n${body}\n\n`, "utf8");
  };

  return {
    getIssue,
    async children(parent) {
      const payload = await json(["list", "--parent", parent, "--all", "-n", "0", "--json"]);
      const beads = Array.isArray(payload) ? (payload as Bead[]) : [];
      return beads.sort(compareBeads).map((b) => b.id);
    },
    async parent(id) {
      const parent = (await show(id)).parent;
      return typeof parent === "string" && parent !== "" ? parent : undefined;
    },
    async blockers(id) {
      const deps = (await show(id)).dependencies ?? [];
      return deps.filter((d) => (d.dependency_type ?? d.type) === "blocks" && d.status !== "closed").map((d) => d.id ?? d.depends_on_id ?? "").filter((b) => b !== "");
    },
    async claim(id, { branch }) {
      const user = await exec("git", ["config", "user.name"], { cwd });
      await bd(["--actor", actorOf(user.code === 0 ? user.stdout : "", branch), "update", id, "--claim"]);
    },
    async block(id, text) {
      await setStateLabel(id, stateLabels(labelPrefix).blocked);
      await comment(id, text);
    },
    async close(id, text) {
      if (text !== undefined) await comment(id, text);
      await bd(["close", id, "--reason", text ?? "closed by sous"]);
    },
    setStateLabel,
    comment,
    isClosed: async (id) => (await getIssue(id)).state === "closed",
  };
};
