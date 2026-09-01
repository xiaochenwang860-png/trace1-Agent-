import { appendFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { TraceEvent } from "./types.js";

const journalExtension = ".ndjson";
const traceEventTypes = new Set([
  "run.started",
  "runtime.started",
  "attempt.started",
  "attempt.completed",
  "attempt.failed",
  "retry.scheduled",
  "model.requested",
  "model.completed",
  "model.failed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "file.changed",
  "workspace.checkpoint.created",
  "workspace.diff.generated",
  "workspace.restore.started",
  "workspace.restore.completed",
  "workspace.restore.blocked",
  "workspace.restore.failed",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);
const traceStatuses = new Set(["info", "success", "error"]);
const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

function isTraceEvent(value: unknown): value is TraceEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<TraceEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.runId === "string" &&
    typeof event.agentId === "string" &&
    typeof event.traceId === "string" &&
    typeof event.spanId === "string" &&
    (event.parentSpanId === null || typeof event.parentSpanId === "string") &&
    typeof event.sequence === "number" &&
    Number.isInteger(event.sequence) &&
    event.sequence > 0 &&
    typeof event.type === "string" &&
    traceEventTypes.has(event.type) &&
    typeof event.status === "string" &&
    traceStatuses.has(event.status) &&
    typeof event.timestamp === "string" &&
    Number.isFinite(Date.parse(event.timestamp)) &&
    (event.durationMs === null ||
      (typeof event.durationMs === "number" &&
        Number.isFinite(event.durationMs) &&
        event.durationMs >= 0)) &&
    typeof event.summary === "string" &&
    (event.error === null || typeof event.error === "string") &&
    optionalString(event.attemptId) &&
    (event.attemptNumber === undefined ||
      (Number.isInteger(event.attemptNumber) && (event.attemptNumber ?? 0) > 0)) &&
    (event.retryOfAttemptId === undefined ||
      event.retryOfAttemptId === null ||
      typeof event.retryOfAttemptId === "string") &&
    optionalString(event.nextAttemptId) &&
    (event.retryDelayMs === undefined ||
      (typeof event.retryDelayMs === "number" &&
        Number.isFinite(event.retryDelayMs) &&
        event.retryDelayMs >= 0)) &&
    optionalString(event.errorCode) &&
    (event.retryable === undefined || typeof event.retryable === "boolean")
  );
}

export class TraceJournal {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  append(event: TraceEvent): Promise<void> {
    const previous = this.queues.get(event.runId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() =>
        appendFile(this.filePath(event.runId), JSON.stringify(event) + "\n", {
          encoding: "utf8",
          mode: 0o600,
        }),
      );
    this.queues.set(event.runId, operation);
    void operation.catch(() => undefined);
    return operation;
  }

  async recover(): Promise<Map<string, TraceEvent[]>> {
    const recovered = new Map<string, TraceEvent[]>();
    const entries = await readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(journalExtension)) continue;
      try {
        const expectedRunId = entry.name.slice(0, -journalExtension.length);
        const raw = await readFile(path.join(this.directory, entry.name), "utf8");
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const event: unknown = JSON.parse(line);
            if (!isTraceEvent(event) || event.runId !== expectedRunId) continue;
            const events = recovered.get(event.runId) ?? [];
            if (!events.some((candidate) => candidate.id === event.id)) events.push(event);
            recovered.set(event.runId, events);
          } catch {
            // A process crash can leave the final line incomplete. Earlier lines remain valid.
          }
        }
      } catch (error) {
        console.error(`Failed to read Trace journal ${entry.name}`, error);
      }
    }
    return recovered;
  }

  async complete(runId: string): Promise<void> {
    const queued = this.queues.get(runId);
    if (queued) await queued;
    try {
      await unlink(this.filePath(runId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      this.queues.delete(runId);
    }
  }

  private filePath(runId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
      throw new Error("Trace journal run ID contains unsupported characters");
    }
    return path.join(this.directory, runId + journalExtension);
  }
}
