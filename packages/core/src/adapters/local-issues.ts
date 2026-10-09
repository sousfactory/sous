/**
 * The `Tracker` port over plain files, for a project whose tracker sous must
 * not touch: `<dir>/<id>.json` holds `{ id, title, body, labels, state }`
 * (more keys are kept as they are; `children` and `blockedBy` list ids),
 * `<dir>/<id>.comments.md` collects the comments. Nothing leaves the machine.
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SousError } from "../exec/errors.js";
import { stateLabels, swapStateLabel, type Tracker, type Issue } from "../ports/tracker.js";
import { safeId } from "../session/paths.js";

export const issueFile = (dir: string, id: string): string => join(dir, `${safeId(id)}.json`);
export const commentsFile = (dir: string, id: string): string => join(dir, `${safeId(id)}.comments.md`);

type Stored = Record<string, unknown> & { id: string; title: string; body?: string; labels?: string[]; state?: string; children?: string[]; blockedBy?: string[] };

export type LocalOptions = { dir: string; labelPrefix?: string; clock?: () => Date };

export const createLocalTracker = ({ dir, labelPrefix = "sous", clock = () => new Date() }: LocalOptions): Tracker => {
  const read = async (id: string): Promise<Stored> => {
    let text: string;
    try {
      text = await readFile(issueFile(dir, id), "utf8");
    } catch {
      throw new SousError(`local issues: ${issueFile(dir, id)} does not exist; import the issue first`);
    }
    const stored = JSON.parse(text) as Stored;
    if (stored.id !== id) throw new SousError(`local issues: ${issueFile(dir, id)} holds id ${String(stored.id)}, not ${id}`);
    return stored;
  };
  const write = async (stored: Stored): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(issueFile(dir, stored.id), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  };
  const getIssue = async (id: string): Promise<Issue> => {
    const s = await read(id);
    return { id: s.id, ref: s.id, title: s.title, body: s.body ?? "", labels: s.labels ?? [], state: s.state === "closed" ? "closed" : "open" };
  };
  const setStateLabel = async (id: string, label: string): Promise<void> => {
    const stored = await read(id);
    const { add, remove, labels } = swapStateLabel(stored.labels ?? [], label);
    if (add.length === 0 && remove.length === 0) return;
    await write({ ...stored, labels });
  };
  const comment = async (id: string, body: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await appendFile(commentsFile(dir, id), `## ${clock().toISOString()}\n\n${body}\n\n`, "utf8");
  };
  const { running, blocked } = stateLabels(labelPrefix);
  return {
    getIssue,
    children: async (parent) => [...((await read(parent)).children ?? [])],
    async parent(id) {
      await read(id);
      for (const file of (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"))) {
        const stored = JSON.parse(await readFile(join(dir, file), "utf8")) as Stored;
        if (stored.children?.includes(id)) return stored.id;
      }
      return undefined;
    },
    async blockers(id) {
      const open: string[] = [];
      for (const blocker of (await read(id)).blockedBy ?? []) if ((await getIssue(blocker)).state !== "closed") open.push(blocker);
      return open;
    },
    claim: (id) => setStateLabel(id, running),
    async block(id, text) {
      await setStateLabel(id, blocked);
      await comment(id, text);
    },
    async close(id, text) {
      if (text !== undefined) await comment(id, text);
      await write({ ...(await read(id)), state: "closed" });
    },
    setStateLabel,
    comment,
    isClosed: async (id) => (await getIssue(id)).state === "closed",
  };
};
