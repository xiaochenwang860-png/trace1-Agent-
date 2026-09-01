import { describe, expect, it } from "vitest";
import { AttemptTrace } from "./attempt-trace.js";
import type { RunnerTraceEvent } from "./types.js";

describe("AttemptTrace", () => {
  it("correlates a failed attempt, retry, and successful attempt", () => {
    const events: RunnerTraceEvent[] = [];
    const first = new AttemptTrace((event) => events.push(event), {
      attemptId: "attempt-1",
      attemptNumber: 1,
    });
    first.capture({
      type: "model.requested",
      status: "info",
      timestamp: new Date().toISOString(),
      durationMs: null,
      summary: "Model request",
      error: null,
      operationId: "model-1",
    });
    expect(
      first.fail({
        error: new Error("upstream timeout"),
        errorCode: "TIMEOUT",
        retryable: true,
      }),
    ).toBe(true);
    expect(first.fail({ error: "duplicate", errorCode: "TIMEOUT", retryable: true })).toBe(
      false,
    );
    const nextAttemptId = first.scheduleRetry({
      nextAttemptId: "attempt-2",
      delayMs: 1_000,
    });
    const second = new AttemptTrace((event) => events.push(event), {
      attemptId: nextAttemptId,
      attemptNumber: 2,
      retryOfAttemptId: first.attemptId,
    });
    expect(second.complete(25)).toBe(true);

    expect(events.map((event) => event.type)).toEqual([
      "attempt.started",
      "model.requested",
      "attempt.failed",
      "retry.scheduled",
      "attempt.started",
      "attempt.completed",
    ]);
    expect(events[0]).toMatchObject({
      operationId: "attempt-1",
      attemptId: "attempt-1",
      attemptNumber: 1,
      retryOfAttemptId: null,
    });
    expect(events[1]).toMatchObject({
      operationId: "model-1",
      parentOperationId: "attempt-1",
      attemptId: "attempt-1",
    });
    expect(events[2]).toMatchObject({
      operationId: "attempt-1",
      errorCode: "TIMEOUT",
      retryable: true,
    });
    expect(events[3]).toMatchObject({
      parentOperationId: "attempt-1",
      nextAttemptId: "attempt-2",
      retryDelayMs: 1_000,
    });
    expect(events[4]).toMatchObject({
      operationId: "attempt-2",
      retryOfAttemptId: "attempt-1",
    });
    expect(events[5]).toMatchObject({
      operationId: "attempt-2",
      durationMs: 25,
    });
  });

  it("rejects retry scheduling after success or a non-retryable failure", () => {
    const completed = new AttemptTrace(undefined, { attemptNumber: 1 });
    completed.complete();
    expect(() => completed.scheduleRetry({ delayMs: 10 })).toThrow(
      "retryable attempt failure",
    );

    const permanentFailure = new AttemptTrace(undefined, { attemptNumber: 1 });
    permanentFailure.fail({
      error: "invalid credentials",
      errorCode: "AUTH",
      retryable: false,
    });
    expect(() => permanentFailure.scheduleRetry({ delayMs: 10 })).toThrow(
      "retryable attempt failure",
    );
  });
});
