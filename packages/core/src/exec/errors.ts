/**
 * Errors the CLI reports as a message instead of a stack trace. The two agent
 * errors become failed iterations; an interrupt is not a failure at all.
 */
export class SousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The agent finished without a valid `<result>` envelope, even after the
 * adapter's one in-session retry. The executor records it as a failed
 * iteration and resumes `sessionId` with the message instead of crashing.
 */
export class AgentOutputError extends SousError {
  constructor(
    message: string,
    /** Undefined when no `<result>` tag was emitted. */
    readonly rawMatched: string | undefined,
    readonly sessionId: string | undefined,
    /** The agent log of the attempt whose output did not validate. */
    readonly logPath?: string,
  ) {
    super(message);
  }
}

/**
 * The agent process itself failed: a non-zero exit, an idle timeout or any
 * other error sandcastle raised while running it. The executor records it as
 * a failed iteration and retries, resuming `sessionId` when one is known.
 */
export class AgentProcessError extends SousError {
  readonly exitCode: number | undefined;
  /** The agent log of the failed run. */
  readonly logPath: string | undefined;
  /** Last lines of that log, when it could be read. */
  readonly logTail: string | undefined;
  readonly sessionId: string | undefined;

  constructor(message: string, details: { exitCode?: number; logPath?: string; logTail?: string; sessionId?: string } = {}) {
    super(message);
    this.exitCode = details.exitCode;
    this.logPath = details.logPath;
    this.logTail = details.logTail;
    this.sessionId = details.sessionId;
  }
}

/**
 * The sandbox's abort signal fired. Not a failed iteration: the executor
 * lets it through without recording anything, and the run command's
 * interrupt handling ends the segment.
 */
export class InterruptedError extends SousError {
  constructor(message = "the run was interrupted") {
    super(message);
  }
}

/** What an aborted sandbox call rejects with; reuses the signal's reason when it already is one. */
export const interruptedBy = (signal: AbortSignal): InterruptedError =>
  signal.reason instanceof InterruptedError ? signal.reason : new InterruptedError(signal.reason instanceof Error ? `the run was interrupted: ${signal.reason.message}` : undefined);

/** A `when`, `${{ }}` or `resume` expression that does not compile. */
export class ExpressionError extends SousError {
  constructor(
    readonly source: string,
    reason: string,
  ) {
    super(`cannot compile expression \`${source}\`: ${reason}`);
  }
}
