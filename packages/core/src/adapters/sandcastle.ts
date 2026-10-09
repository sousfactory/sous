/**
 * Sandbox over `@ai-hero/sandcastle`: one worktree per issue branch under
 * `.sandcastle/worktrees/`, no container. Opening reuses an existing
 * worktree on the branch.
 *
 * The long-lived `Sandbox.run()` has no `output` option, so `runAgent`
 * parses the last `<result>` tag itself, resumes the session once with a
 * validation message when it does not parse, then gives up with
 * `AgentOutputError`. A failing agent process (non-zero exit, idle timeout)
 * becomes `AgentProcessError` with the exit code and its log tail.
 *
 * The abort signal goes to every `run()` and to `killableNoSandbox`; once it
 * fires, `runAgent` and `exec` reject only with `InterruptedError`, never
 * with an `AgentProcessError` or a failed result.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSandbox, type AgentStreamEvent, type ExecResult as SandcastleExecResult, type SandboxRunOptions, type SandboxRunResult } from "@ai-hero/sandcastle";
import type { Settings } from "../config/settings.js";
import { AgentOutputError, AgentProcessError, interruptedBy } from "../exec/errors.js";
import { invalidOutputPrompt } from "../exec/prompt.js";
import type { ExecOptions, ExecResult } from "../index.js";
import type { AgentRequest, AgentResult, Sandbox, ToolCall } from "../ports/sandbox.js";
import type { TokenUsage } from "../session/events.js";
import { buildRunOptions, parseEnvelope, selectAgent } from "./agent.js";
import { killableNoSandbox } from "./hostexec.js";
import { withAttempt } from "./logs.js";

export type SandboxSettings = Pick<Settings, "baseBranch" | "idleTimeoutSeconds">;

export type OpenSandboxOptions = {
  /** The repository checkout `.sandcastle/` lives in. */
  repoRoot: string;
  branch: string;
  /** `baseBranch` is what a new branch forks from; `idleTimeoutSeconds` bounds every agent call. */
  settings: SandboxSettings;
  /**
   * The run's interrupt. Aborting it terminates the agent process and any
   * command in flight; `runAgent` and `exec` then reject with `InterruptedError`.
   */
  signal?: AbortSignal;
};

export type OpenSandbox = (options: OpenSandboxOptions) => Promise<Sandbox>;

/** The sandcastle call `runAgent` is built on; tests inject a scripted one. */
export type RunInSandbox = (options: SandboxRunOptions) => Promise<SandboxRunResult>;

export type RunAgentDeps = { run: RunInSandbox; idleTimeoutSeconds: number; signal?: AbortSignal };

export const worktreesRoot = (repoRoot: string): string => join(repoRoot, ".sandcastle", "worktrees");

/** Sandcastle's directory name for `branch` (slashes become dashes). */
export const worktreeDirName = (branch: string): string => branch.replaceAll("/", "-");

export const worktreePathFor = (repoRoot: string, branch: string): string => join(worktreesRoot(repoRoot), worktreeDirName(branch));

export const toExecResult = ({ stdout, stderr, exitCode }: SandcastleExecResult): ExecResult => ({ code: exitCode, stdout, stderr });

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Sandcastle's `exec` takes no environment; `env` becomes exports in front of the command. */
export const withEnv = (command: string, env: Record<string, string> | undefined): string =>
  env === undefined || Object.keys(env).length === 0
    ? command
    : `${Object.entries(env)
        .map(([k, v]) => `export ${k}=${shellQuote(v)};`)
        .join(" ")} ${command}`;

const lastSessionId = (result: SandboxRunResult): string | undefined => result.iterations.at(-1)?.sessionId;

/** Claude only. */
export const usageOf = (result: SandboxRunResult): TokenUsage | undefined => {
  const usage = result.iterations[0]?.usage;
  if (usage === undefined) return undefined;
  const { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens } = usage;
  return { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens };
};

/**
 * Collects the tool calls of one or more sandcastle runs from the stream
 * events. Claude's raw stream-json lines carry every tool call with its full
 * input; sandcastle's own `toolCall` events drop `Read` and `Skill` and keep
 * one argument, so they are the fallback for providers without such lines.
 */
export const toolCallCollector = () => {
  const fromRaw: ToolCall[] = [];
  const fromEvents: ToolCall[] = [];
  const onEvent = (event: AgentStreamEvent): void => {
    if (event.type === "raw") fromRaw.push(...claudeToolCalls(event.line));
    else if (event.type === "toolCall") fromEvents.push({ name: event.name, input: event.name === "Read" ? { file_path: event.formattedArgs } : { command: event.formattedArgs } });
  };
  return { onEvent, calls: (): ToolCall[] => (fromRaw.length > 0 ? fromRaw : fromEvents) };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The `tool_use` blocks of one Claude stream-json line; none for any other line. */
export const claudeToolCalls = (line: string): ToolCall[] => {
  if (!line.startsWith("{")) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(obj) || obj["type"] !== "assistant" || !isRecord(obj["message"]) || !Array.isArray(obj["message"]["content"])) return [];
  return obj["message"]["content"].flatMap((block: unknown) =>
    isRecord(block) && block["type"] === "tool_use" && typeof block["name"] === "string" && isRecord(block["input"]) ? [{ name: block["name"], input: block["input"] }] : [],
  );
};

export const AGENT_LOG_TAIL_LINES = 20;

/** Sandcastle reports a failed agent as "<provider> exited with code <n>: …". */
export const exitCodeOf = (message: string): number | undefined => {
  const match = /exited with code (-?\d+)/.exec(message);
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
};

const readLogTail = async (path: string): Promise<string | undefined> => {
  try {
    const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.trim() !== "");
    return lines.length > 0 ? lines.slice(-AGENT_LOG_TAIL_LINES).join("\n") : undefined;
  } catch {
    return undefined;
  }
};

/** An aborted call fails with `InterruptedError`, any other failure with `AgentProcessError`. */
const runProcess = async (run: RunInSandbox, options: SandboxRunOptions, path: string, sessionId: string | undefined): Promise<SandboxRunResult> => {
  try {
    return await run(options);
  } catch (error) {
    if (options.signal?.aborted === true) throw interruptedBy(options.signal);
    const message = error instanceof Error ? error.message : String(error);
    const exitCode = exitCodeOf(message);
    const logTail = await readLogTail(path);
    throw new AgentProcessError(message, {
      ...(exitCode !== undefined ? { exitCode } : {}),
      logPath: path,
      ...(logTail !== undefined ? { logTail } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  }
};

export const createRunAgent =
  ({ run, idleTimeoutSeconds, signal }: RunAgentDeps) =>
  async (req: AgentRequest): Promise<AgentResult> => {
    const agent = selectAgent(req.agent);
    await mkdir(dirname(req.logPath), { recursive: true });

    const tools = toolCallCollector();
    let path = req.logPath;
    let result = await runProcess(run, buildRunOptions(req, { agent, idleTimeoutSeconds, onEvent: tools.onEvent, ...(signal !== undefined ? { signal } : {}) }), path, undefined);
    let sessionId = lastSessionId(result);
    let parsed = parseEnvelope(result.stdout, req.outputSchema);

    if (!parsed.ok && sessionId !== undefined) {
      path = withAttempt(req.logPath, 2);
      const retry: SandboxRunOptions = {
        agent,
        prompt: invalidOutputPrompt(parsed),
        resumeSession: sessionId,
        idleTimeoutSeconds,
        logging: { type: "file", path, onAgentStreamEvent: tools.onEvent },
        ...(signal !== undefined ? { signal } : {}),
      };
      result = await runProcess(run, retry, path, sessionId);
      sessionId = lastSessionId(result) ?? sessionId;
      parsed = parseEnvelope(result.stdout, req.outputSchema);
    }

    if (!parsed.ok) throw new AgentOutputError(parsed.reason, parsed.rawMatched, sessionId, path);
    const usage = usageOf(result);
    return {
      envelope: parsed.envelope,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(usage !== undefined ? { usage } : {}),
      logPath: path,
      toolCalls: tools.calls(),
    };
  };

export type InnerExec = (command: string, options: { cwd?: string }) => Promise<SandcastleExecResult>;

/**
 * A failure to run becomes exit 1, never a throw, except once `signal`
 * aborted: then the command was terminated (or never started) and it
 * rejects with `InterruptedError`.
 */
export const createSandboxExec =
  (inner: InnerExec, signal?: AbortSignal) =>
  async (command: string, options: ExecOptions = {}): Promise<ExecResult> => {
    let result: ExecResult;
    try {
      result = toExecResult(await inner(withEnv(command, options.env), options.cwd !== undefined ? { cwd: options.cwd } : {}));
    } catch (error) {
      result = { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
    if (signal?.aborted === true) throw interruptedBy(signal);
    return result;
  };

export const openSandbox: OpenSandbox = async ({ repoRoot, branch, settings, signal }) => {
  const inner = await createSandbox({ branch, baseBranch: settings.baseBranch, sandbox: killableNoSandbox(signal), cwd: repoRoot });
  return {
    worktreePath: inner.worktreePath,
    branch: inner.branch,
    runAgent: createRunAgent({ run: (options) => inner.run(options), idleTimeoutSeconds: settings.idleTimeoutSeconds, ...(signal !== undefined ? { signal } : {}) }),
    exec: createSandboxExec((command, options) => inner.exec(command, options), signal),
    async close() {
      await inner.close();
    },
  };
};
