/** A tracker module from before `list` joined the port, for the validate error. */
export default () => ({
  getIssue: async () => undefined,
  children: async () => [],
  parent: async () => undefined,
  blockers: async () => [],
  claim: async () => undefined,
  block: async () => undefined,
  close: async () => undefined,
  setStateLabel: async () => undefined,
  comment: async () => undefined,
  isClosed: async () => false,
});
