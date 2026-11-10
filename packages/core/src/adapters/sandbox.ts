/**
 * The sandbox: one git worktree per issue branch under `.sous/worktrees/`,
 * agents and evals as host processes in it (no container). Opening reuses
 * the worktree the branch is already checked out in.
 *
 * `runAgent` runs the provider's command through the host exec, parses the
 * streamed lines, writes a readable log, and looks for the last `<result>`
 * tag in what the agent said; when that does not parse it resumes the
 * session once with a validation message, then gives up with
 * `AgentOutputError`. A failing agent process (non-zero exit, idle timeout,
 * a CLI that is not installed) becomes `AgentProcessError` with the exit
 * code and the log tail.
 *
 * The abort signal goes to the host exec; once it fires, `runAgent` and
 * `exec` reject only with `InterruptedError`, never with an
 * `AgentProcessError` or a failed result.
 */
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Settings } from "../config/settings.js";
import { AgentOutputError, AgentProcessError, interruptedBy } from "../exec/errors.js";
import { invalidOutputPrompt } from "../exec/prompt.js";
import type { ExecOptions, ExecResult } from "../index.js";
import type { Git } from "../ports/git.js";
import type { AgentRequest, AgentResult, Sandbox, ToolCall } from "../ports/sandbox.js";
import { PROJECT_DIR } from "../root.js";
import type { TokenUsage } from "../session/events.js";
import type { Provider } from "./agents/provider.js";
import { parseEnvelope, selectAgent } from "./agent.js";
import { createHostExec, type HostExec, type HostExecResult } from "./hostexec.js";
import { withAttempt } from "./logs.js";

export type SandboxSettings = Pick<Settings, "baseBranch" | "idleTimeoutSeconds">;

export type OpenSandboxOptions = {
  /** The repository checkout the worktrees live under. */
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

export const WORKTREES_DIR = "worktrees";

/** Where runs before 0.6.0 kept their worktrees; one found there is reused as it is. */
export const LEGACY_WORKTREES_PARENT = ".sandcastle";

export const worktreesRoot = (repoRoot: string): string => join(repoRoot, PROJECT_DIR, WORKTREES_DIR);

/** The directory name for `branch`: slashes become dashes. */
export const worktreeDirName = (branch: string): string => branch.replaceAll("/", "-");

export const worktreePathFor = (repoRoot: string, branch: string): string => join(worktreesRoot(repoRoot), worktreeDirName(branch));

/** A worktree sous made: under `.sous/worktrees/` or the pre-0.6.0 `.sandcastle/worktrees/`. */
export const isManagedWorktree = (path: string): boolean =>
  basename(dirname(path)) === WORKTREES_DIR && [PROJECT_DIR, LEGACY_WORKTREES_PARENT].includes(basename(dirname(dirname(path))));

/**
 * The worktree of `branch`: the one it is checked out in, else a new one
 * under `.sous/worktrees/`, forked from the base branch when the branch
 * does not exist yet. A branch checked out anywhere else (the primary
 * checkout, say) cannot be run: git refuses a second checkout, and sous
 * never runs an agent outside its own worktree.
 */
export const worktreeFor = async (git: Git, repoRoot: string, branch: string, baseBranch: string): Promise<string> => {
  const existing = await git.worktreeOf(repoRoot, branch);
  if (existing !== undefined) {
    if (!isManagedWorktree(existing)) throw new Error(`branch ${branch} is checked out at ${existing}; sous runs it in a worktree of its own, so check out another branch there first`);
    return existing;
  }
  const path = worktreePathFor(repoRoot, branch);
  await git.addWorktree(repoRoot, path, branch, baseBranch);
  return path;
};

export const toExecResult = ({ stdout, stderr, exitCode }: HostExecResult): ExecResult => ({ code: exitCode, stdout, stderr });

export const AGENT_LOG_TAIL_LINES = 20;

const readLogTail = async (path: string): Promise<string | undefined> => {
  try {
    const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.trim() !== "");
    return lines.length > 0 ? lines.slice(-AGENT_LOG_TAIL_LINES).join("\n") : undefined;
  } catch {
    return undefined;
  }
};

/** The one argument worth a line in the log, by the fields the common tools use. */
const ARG_FIELDS = ["command", "file_path", "skill", "pattern", "query", "url", "description", "path", "prompt"];

export const formatToolArgs = (input: Record<string, unknown>): string => {
  for (const field of ARG_FIELDS) {
    const value = input[field];
    if (typeof value === "string") return value;
  }
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
};

/**
 * The readable log of one call: a header, the agent's prose, one line per
 * tool call (`Bash(./gradlew test)`), and the failure when the process
 * fails. The raw stream is not kept.
 */
const openLog = (path: string): { line: (text: string) => void; close: () => Promise<void> } => {
  const stream: WriteStream = createWriteStream(path, { flags: "a" });
  stream.on("error", () => undefined);
  stream.write(`\n--- Run started: ${new Date().toISOString()} ---\n`);
  return {
    line: (text) => {
      stream.write(text.endsWith("\n") ? text : `${text}\n`);
    },
    close: () => new Promise((resolve) => stream.end(resolve)),
  };
};

/** Collects one call's stream: what the agent said, its session, usage, cost and tool calls. */
const collect = (provider: Provider, log: { line: (text: string) => void }) => {
  const texts: string[] = [];
  let result: string | undefined;
  let sessionId: string | undefined;
  let usage: TokenUsage | undefined;
  let costUsd: number | undefined;
  const tools: ToolCall[] = [];
  return {
    onLine: (line: string): void => {
      for (const event of provider.parseLine(line)) {
        if (event.type === "text") {
          texts.push(event.text);
          log.line(event.text);
        } else if (event.type === "result") result = event.text;
        else if (event.type === "session") sessionId = event.id;
        else if (event.type === "usage") usage = event.usage;
        else if (event.type === "cost") costUsd = event.usd;
        else {
          tools.push(event.call);
          log.line(`${event.call.name}(${formatToolArgs(event.call.input)})`);
        }
      }
    },
    /** The envelope is the last `<result>` tag in the prose, the final answer last. */
    output: (): string => [...texts, ...(result !== undefined ? [result] : [])].join("\n"),
    get result() {
      return result;
    },
    get sessionId() {
      return sessionId;
    },
    get usage() {
      return usage;
    },
    get costUsd() {
      return costUsd;
    },
    tools,
  };
};

export type RunAgentDeps = { exec: HostExec; idleTimeoutSeconds: number; signal?: AbortSignal };

type Call = { output: string; sessionId: string | undefined; usage: TokenUsage | undefined; costUsd: number | undefined; tools: ToolCall[] };

export const createRunAgent =
  ({ exec, idleTimeoutSeconds, signal }: RunAgentDeps) =>
  async (req: AgentRequest): Promise<AgentResult> => {
    const provider = selectAgent(req.agent);
    await mkdir(dirname(req.logPath), { recursive: true });

    /** One agent process; an aborted one fails with `InterruptedError`, any other failure with `AgentProcessError`. */
    const call = async (prompt: string, resumeSession: string | undefined, path: string): Promise<Call> => {
      const command = provider.buildCommand({ model: req.agent.model, prompt, ...(resumeSession !== undefined ? { resumeSession } : {}) });
      const log = openLog(path);
      const stream = collect(provider, log);
      const fail = async (message: string, exitCode?: number): Promise<never> => {
        log.line(message);
        await log.close();
        const logTail = await readLogTail(path);
        const sessionId = stream.sessionId ?? resumeSession;
        throw new AgentProcessError(message, {
          ...(exitCode !== undefined ? { exitCode } : {}),
          logPath: path,
          ...(logTail !== undefined ? { logTail } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
        });
      };
      let result: HostExecResult;
      try {
        result = await exec(command.argv, { stdin: command.stdin, onLine: stream.onLine, idleTimeoutMs: idleTimeoutSeconds * 1000 });
      } catch (error) {
        if (signal?.aborted === true) {
          await log.close();
          throw interruptedBy(signal);
        }
        return fail(error instanceof Error ? error.message : String(error));
      }
      if (result.timedOut === true) return fail(`Agent idle for ${idleTimeoutSeconds} seconds: no output received`, result.exitCode);
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || stream.result?.trim() || result.stdout.split("\n").filter((l) => l.trim() !== "").slice(-AGENT_LOG_TAIL_LINES).join("\n");
        return fail(`${provider.name} exited with code ${result.exitCode}:\n${detail}`, result.exitCode);
      }
      await log.close();
      return { output: stream.output(), sessionId: stream.sessionId ?? resumeSession, usage: stream.usage, costUsd: stream.costUsd, tools: stream.tools };
    };

    let path = req.logPath;
    let run = await call(req.prompt, req.resumeSession, path);
    let sessionId = run.sessionId;
    let parsed = parseEnvelope(run.output, req.outputSchema);
    const tools = [...run.tools];
    let costUsd = run.costUsd;

    if (!parsed.ok && sessionId !== undefined) {
      path = withAttempt(req.logPath, 2);
      run = await call(invalidOutputPrompt(parsed), sessionId, path);
      sessionId = run.sessionId ?? sessionId;
      parsed = parseEnvelope(run.output, req.outputSchema);
      tools.push(...run.tools);
      // Both processes were billed; a retry without a figure makes the total unknown, not lower.
      costUsd = costUsd !== undefined && run.costUsd !== undefined ? costUsd + run.costUsd : undefined;
    }

    if (!parsed.ok) throw new AgentOutputError(parsed.reason, parsed.rawMatched, sessionId, path);
    return {
      envelope: parsed.envelope,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(run.usage !== undefined ? { usage: run.usage } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      logPath: path,
      toolCalls: tools,
    };
  };

/**
 * A failure to run becomes exit 1, never a throw, except once `signal`
 * aborted: then the command was terminated (or never started) and it
 * rejects with `InterruptedError`.
 */
export const createSandboxExec =
  (inner: HostExec, signal?: AbortSignal) =>
  async (command: string, options: ExecOptions = {}): Promise<ExecResult> => {
    let result: ExecResult;
    try {
      result = toExecResult(await inner(command, { ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.env !== undefined ? { env: options.env } : {}) }));
    } catch (error) {
      result = { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
    if (signal?.aborted === true) throw interruptedBy(signal);
    return result;
  };

export const createOpenSandbox =
  (git: Git): OpenSandbox =>
  async ({ repoRoot, branch, settings, signal }) => {
    const worktreePath = await worktreeFor(git, repoRoot, branch, settings.baseBranch);
    const exec = createHostExec({ cwd: worktreePath, env: process.env, ...(signal !== undefined ? { signal } : {}) });
    return {
      worktreePath,
      branch,
      runAgent: createRunAgent({ exec, idleTimeoutSeconds: settings.idleTimeoutSeconds, ...(signal !== undefined ? { signal } : {}) }),
      exec: createSandboxExec(exec, signal),
      /**
       * A worktree with changes of any kind, untracked files included, is kept.
       * Idempotent: a worktree an earlier step or a crashed run already removed
       * leaves nothing to keep or remove. One whose status cannot even be taken
       * is removed rather than kept by accident (`removeWorktree` tolerates a
       * registration that is gone), unless the run was interrupted.
       */
      async close() {
        if (!existsSync(worktreePath)) return;
        // An interrupt still propagates: a forced removal of a worktree nobody inspected would lose its changes.
        const status = await exec("git status --porcelain").catch((error: unknown) => {
          if (signal?.aborted === true) throw error;
          return undefined;
        });
        if (status === undefined || (status.exitCode === 0 && status.stdout.trim() === "")) await git.removeWorktree(repoRoot, worktreePath);
      },
    };
  };
