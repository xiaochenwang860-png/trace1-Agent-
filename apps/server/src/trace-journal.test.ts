import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TraceJournal } from "./trace-journal.js";
import type { TraceEvent } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function trace(id: string, sequence: number): TraceEvent {
  return {
    id,
    traceId: "run-1",
    spanId: "operation-1",
    parentSpanId: "runtime-1",
    sequence,
    runId: "run-1",
    agentId: "agent-1",
    type: sequence === 1 ? "tool.started" : "tool.completed",
    status: sequence === 1 ? "info" : "success",
    timestamp: new Date(sequence).toISOString(),
    durationMs: sequence === 1 ? null : 1,
    summary: "Command execution: npm",
    error: null,
  };
}

describe("TraceJournal", () => {
  it("recovers appended events and removes them after durable completion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "trace-journal-test-"));
    temporaryDirectories.push(root);
    const journal = new TraceJournal(root);
    await journal.initialize();
    await Promise.all([
      journal.append(trace("event-1", 1)),
      journal.append(trace("event-2", 2)),
    ]);

    expect((await journal.recover()).get("run-1")?.map((event) => event.id)).toEqual([
      "event-1",
      "event-2",
    ]);

    await journal.complete("run-1");
    expect((await journal.recover()).has("run-1")).toBe(false);
  });

  it("keeps valid records when a crash leaves an incomplete final line", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "trace-journal-test-"));
    temporaryDirectories.push(root);
    const journal = new TraceJournal(root);
    await journal.initialize();
    await writeFile(
      path.join(root, "run-1.ndjson"),
      JSON.stringify(trace("event-1", 1)) + "\n{\"id\":",
      "utf8",
    );

    expect((await journal.recover()).get("run-1")?.map((event) => event.id)).toEqual([
      "event-1",
    ]);
    expect(await readFile(path.join(root, "run-1.ndjson"), "utf8")).toContain(
      "event-1",
    );
  });

  it("ignores structurally incomplete JSON records during recovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "trace-journal-test-"));
    temporaryDirectories.push(root);
    const journal = new TraceJournal(root);
    await journal.initialize();
    await writeFile(
      path.join(root, "run-1.ndjson"),
      JSON.stringify({
        id: "invalid-event",
        traceId: "run-1",
        spanId: "span-1",
        parentSpanId: null,
        sequence: 1,
        runId: "run-1",
        agentId: "agent-1",
        type: "tool.started",
        timestamp: new Date().toISOString(),
      }) + "\n",
      "utf8",
    );

    expect((await journal.recover()).has("run-1")).toBe(false);
  });
});
