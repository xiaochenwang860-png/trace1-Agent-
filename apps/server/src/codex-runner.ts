import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import type {
  AgentRunner,
  RunnerTraceEvent,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
  turnStartedAt: number | null;
  turnSpanId?: string | null;
  itemStartedAt: Record<string, number>;
}

const toolItemTypes = new Set(["command_execution", "mcp_tool_call", "web_search"]);

function traceText(value: unknown, fallback: string): string {
  const text = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return text
    .replace(/(bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s"']+/gi,
      "$1[REDACTED]",
    )
    .slice(0, 240);
}

function itemSummary(item: Record<string, unknown>): string {
  if (item.type === "command_execution") {
    const command = traceText(item.command, "unknown command");
    const executable = command.split(/\s+/)[0] ?? "unknown command";
    return "Command execution: " + executable;
  }
  if (item.type === "mcp_tool_call") {
    const server = traceText(item.server, "MCP");
    const tool = traceText(item.tool, "unknown tool");
    return "MCP tool: " + server + "/" + tool;
  }
  if (item.type === "web_search") {
    return "Web search: " + traceText(item.query, "query not reported");
  }
  return "Agent tool operation";
}

function itemDuration(parsed: ParsedEvents, item: Record<string, unknown>): number | null {
  if (typeof item.id !== "string") return null;
  const startedAt = parsed.itemStartedAt[item.id];
  delete parsed.itemStartedAt[item.id];
  return startedAt === undefined ? null : Math.max(0, Date.now() - startedAt);
}

function fileChangeSummary(item: Record<string, unknown>): string {
  if (!Array.isArray(item.changes)) return "File changes applied";
  const changes = item.changes
    .slice(0, 5)
    .map((change) => {
      if (!change || typeof change !== "object") return null;
      const record = change as Record<string, unknown>;
      const kind = traceText(record.kind, "changed");
      const path = traceText(record.path, "unknown file");
      return kind + " " + path;
    })
    .filter((change): change is string => change !== null);
  return changes.length ? "Files: " + changes.join(", ") : "File changes applied";
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

export function parseCodexEventLine(
  line: string,
  parsed: ParsedEvents,
  onTrace?: (event: RunnerTraceEvent) => void,
): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "turn.started") {
    const timestamp = new Date();
    parsed.turnStartedAt = timestamp.getTime();
    parsed.turnSpanId = randomUUID();
    onTrace?.({
      type: "model.requested",
      status: "info",
      timestamp: timestamp.toISOString(),
      durationMs: null,
      summary: "Codex model turn started",
      error: null,
      operationId: parsed.turnSpanId,
    });
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
  }

  if (event.type === "item.started" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (typeof item.id === "string") parsed.itemStartedAt[item.id] = Date.now();
    if (typeof item.type === "string" && toolItemTypes.has(item.type)) {
      onTrace?.({
        type: "tool.started",
        status: "info",
        timestamp: new Date().toISOString(),
        durationMs: null,
        summary: itemSummary(item),
        error: null,
        ...(typeof item.id === "string" ? { operationId: item.id } : {}),
        ...(parsed.turnSpanId ? { parentOperationId: parsed.turnSpanId } : {}),
      });
    }
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    }
    if (typeof item.type === "string" && toolItemTypes.has(item.type)) {
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
      const failed = item.status === "failed" || (exitCode !== null && exitCode !== 0);
      onTrace?.({
        type: failed ? "tool.failed" : "tool.completed",
        status: failed ? "error" : "success",
        timestamp: new Date().toISOString(),
        durationMs: itemDuration(parsed, item),
        summary: itemSummary(item),
        error: failed
          ? exitCode === null
            ? "Tool operation failed"
            : "Command exited with code " + exitCode
          : null,
        ...(typeof item.id === "string" ? { operationId: item.id } : {}),
        ...(parsed.turnSpanId ? { parentOperationId: parsed.turnSpanId } : {}),
      });
    }
    if (item.type === "file_change") {
      onTrace?.({
        type: "file.changed",
        status: item.status === "failed" ? "error" : "success",
        timestamp: new Date().toISOString(),
        durationMs: itemDuration(parsed, item),
        summary: fileChangeSummary(item),
        error: item.status === "failed" ? "File change failed" : null,
        ...(typeof item.id === "string" ? { operationId: item.id } : {}),
        ...(parsed.turnSpanId ? { parentOperationId: parsed.turnSpanId } : {}),
      });
    }
  }

  if (event.type === "turn.completed") {
    if (event.usage && typeof event.usage === "object") {
      const usage = event.usage as Record<string, unknown>;
      parsed.usage = {
        ...(typeof usage.input_tokens === "number"
          ? { inputTokens: usage.input_tokens }
          : {}),
        ...(typeof usage.cached_input_tokens === "number"
          ? { cachedInputTokens: usage.cached_input_tokens }
          : {}),
        ...(typeof usage.output_tokens === "number"
          ? { outputTokens: usage.output_tokens }
          : {}),
      };
    }

    const timestamp = new Date();
    onTrace?.({
      type: "model.completed",
      status: "success",
      timestamp: timestamp.toISOString(),
      durationMs:
        parsed.turnStartedAt === null
          ? null
          : Math.max(0, timestamp.getTime() - parsed.turnStartedAt),
      summary: "Codex model turn completed",
      error: null,
      ...(parsed.turnSpanId ? { operationId: parsed.turnSpanId } : {}),
    });
    parsed.turnSpanId = null;
  }

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    parsed.errors.push(message);
    onTrace?.({
      type: "model.failed",
      status: "error",
      timestamp: new Date().toISOString(),
      durationMs:
        parsed.turnStartedAt === null
          ? null
          : Math.max(0, Date.now() - parsed.turnStartedAt),
      summary: "Codex model turn failed",
      error: traceText(message, "Codex reported an unknown error"),
      ...(parsed.turnSpanId ? { operationId: parsed.turnSpanId } : {}),
    });
  }
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    const args = buildCodexArgs(request, this.config.codexSandboxMode);
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
    };
    this.active.set(request.agentId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
      turnStartedAt: null,
      itemStartedAt: {},
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          parseCodexEventLine(line, parsed, request.onTrace);
        }
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) {
          stderr = stderr.slice(-16_384);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) {
        parseCodexEventLine(stdout.trim(), parsed, request.onTrace);
      }
      if (active.cancelled) {
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        throw new Error("Codex timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new Error("Codex exited with code " + exitCode + ": " + detail);
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new Error("Codex completed without an agent message");
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
      };
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: this.config.codexHome,
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
