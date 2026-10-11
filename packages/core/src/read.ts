/**
 * `sous-factory/read`: the read side of a project for viewers such as `sous ui`.
 * Where runs, logs and the lock are, plus the loaders and folds `sous status`
 * and `sous graph` use, so a viewer shows exactly what the CLI would. Nothing
 * here writes.
 */
export { projectRoot, repoRootOf, PROJECT_DIR } from "./root.js";
export { loadSettings, projectDirs, SETTINGS_FILE, type ProjectDirs, type Settings } from "./config/settings.js";
export { parseFlow, BLOCKED, DONE, TERMINALS, type Agent, type AgentKind, type FlowFile } from "./config/flow.js";
export { listFlows } from "./config/validate.js";
export { topology, type StepKind, type Topology, type TopologyEdge, type TopologyNode } from "./commands/graph.js";
export { classifyLock, isProcessAlive, liveLocks, lockPath, locksDir, LOCKS_DIR, type LockInfo, type LockStatus } from "./commands/lock.js";
export { runsRoot, runDir, sessionFile, eventsFile } from "./session/paths.js";
export { loadSession, parseSession } from "./session/store.js";
export { parseEvents } from "./adapters/eventlog.js";
export { logDir } from "./adapters/logs.js";
export { foldTimeline, visitLanes, type IterationSpan, type RunSegment, type Span, type Timeline, type AgentSpan, type EvalSpan } from "./session/timeline.js";
export { RUN_OUTCOMES, AGENT_OUTCOMES, type Event, type OutputEvent, type RunOutcome, type AgentOutcome, type TokenUsage } from "./session/events.js";
export { SCHEMA_VERSION, type Session, type HistoryEntry } from "./exec/scope.js";
export type { StepRecord, WorkRecord } from "./index.js";
