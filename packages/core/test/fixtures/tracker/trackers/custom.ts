import type { TrackerFactory } from "sous-factory";

/** A tracker that answers from its options, enough to prove the module route works. */
const factory: TrackerFactory = (options, env) => {
  const title = typeof options["title"] === "string" ? options["title"] : "untitled";
  return {
    getIssue: async (id) => ({ id, ref: id, title: `${title} ${env.repoRoot}`, body: "", labels: ["type:task"], state: "open" }),
    children: async () => [],
    parent: async () => undefined,
    blockers: async () => [],
    claim: async () => undefined,
    block: async () => undefined,
    close: async () => undefined,
    setStateLabel: async () => undefined,
    comment: async () => undefined,
    isClosed: async () => false,
  };
};

export default factory;
