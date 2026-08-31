import { randomUUID } from "node:crypto";
import type { RunnerTraceEvent } from "./types.js";

export interface AttemptTraceOptions {
  attemptNumber: number;
  attemptId?: string | undefined;
  retryOfAttemptId?: string | null | undefined;
}

export interface AttemptFailure {
  error: unknown;
  errorCode: string;
  retryable: boolean;
  summary?: string | undefined;
}

export interface RetrySchedule {
  delayMs: number;
  nextAttemptId?: string | undefined;
  summary?: string | undefined;
}

type TraceSink = ((event: RunnerTraceEvent) => void) | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Adds a stable attempt identity around Runner events without owning retry policy.
 * The caller still decides whether, when, and how often to retry.
 */
export class AttemptTrace {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly retryOfAttemptId: string | null;
  private readonly startedAtMs = Date.now();
  private terminal: "completed" | "failed" | null = null;
  private retryable = false;

  constructor(
    private readonly sink: TraceSink,
    options: AttemptTraceOptions,
  ) {
    if (!Number.isInteger(options.attemptNumber) || options.attemptNumber < 1) {
      throw new Error("attemptNumber must be a positive integer");
    }
    this.attemptId = options.attemptId ?? randomUUID();
    this.attemptNumber = options.attemptNumber;
    this.retryOfAttemptId = options.retryOfAttemptId ?? null;
    this.emit({
      type: "attempt.started",
      status: "info",
      timestamp: new Date().toISOString(),
      durationMs: null,
      summary: `Execution attempt ${this.attemptNumber} started`,
      error: null,
      operationId: this.attemptId,
    });
  }

  /** Attach this attempt to an existing model/tool Trace callback. */
  capture = (event: RunnerTraceEvent): void => {
    this.emit({
      ...event,
      parentOperationId: event.parentOperationId ?? this.attemptId,
    });
  };

  complete(durationMs?: number | null): boolean {
    if (this.terminal) return false;
    this.terminal = "completed";
    this.emit({
      type: "attempt.completed",
      status: "success",
      timestamp: new Date().toISOString(),
      durationMs: durationMs === undefined ? Date.now() - this.startedAtMs : durationMs,
      summary: `Execution attempt ${this.attemptNumber} completed`,
      error: null,
      operationId: this.attemptId,
    });
    return true;
  }

  fail(failure: AttemptFailure, durationMs?: number | null): boolean {
    if (this.terminal) return false;
    if (!/^[A-Z0-9_.-]{1,64}$/.test(failure.errorCode)) {
      throw new Error("errorCode must contain 1-64 uppercase code characters");
    }
    this.terminal = "failed";
    this.retryable = failure.retryable;
    this.emit({
      type: "attempt.failed",
      status: "error",
      timestamp: new Date().toISOString(),
      durationMs: durationMs === undefined ? Date.now() - this.startedAtMs : durationMs,
      summary:
        failure.summary ?? `Execution attempt ${this.attemptNumber} failed`,
      error: errorMessage(failure.error),
      errorCode: failure.errorCode,
      retryable: failure.retryable,
      operationId: this.attemptId,
    });
    return true;
  }

  scheduleRetry(schedule: RetrySchedule): string {
    if (this.terminal !== "failed" || !this.retryable) {
      throw new Error("A retry can only be scheduled after a retryable attempt failure");
    }
    if (!Number.isFinite(schedule.delayMs) || schedule.delayMs < 0) {
      throw new Error("delayMs must be a non-negative number");
    }
    const nextAttemptId = schedule.nextAttemptId ?? randomUUID();
    this.emit({
      type: "retry.scheduled",
      status: "info",
      timestamp: new Date().toISOString(),
      durationMs: null,
      summary:
        schedule.summary ??
        `Retry scheduled after attempt ${this.attemptNumber}`,
      error: null,
      operationId: randomUUID(),
      parentOperationId: this.attemptId,
      nextAttemptId,
      retryDelayMs: schedule.delayMs,
    });
    return nextAttemptId;
  }

  private emit(event: RunnerTraceEvent): void {
    this.sink?.({
      ...event,
      attemptId: this.attemptId,
      attemptNumber: this.attemptNumber,
      retryOfAttemptId: this.retryOfAttemptId,
    });
  }
}
