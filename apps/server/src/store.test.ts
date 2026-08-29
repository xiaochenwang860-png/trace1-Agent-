import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("migrates legacy Trace records to stable Trace and Span IDs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 1,
        agents: [],
        messages: [],
        runs: [],
        traces: [
          {
            id: "root-event",
            runId: "run-1",
            agentId: "agent-1",
            type: "run.started",
            status: "info",
            timestamp: "2026-08-28T00:00:00.000Z",
            durationMs: null,
            summary: "Task accepted",
            error: null,
          },
          {
            id: "runtime-event",
            runId: "run-1",
            agentId: "agent-1",
            type: "runtime.started",
            status: "info",
            timestamp: "2026-08-28T00:00:01.000Z",
            durationMs: null,
            summary: "Runtime started",
            error: null,
          },
          {
            id: "model-event",
            runId: "run-1",
            agentId: "agent-1",
            type: "model.requested",
            status: "info",
            timestamp: "2026-08-28T00:00:02.000Z",
            durationMs: null,
            summary: "Model requested",
            error: null,
          },
        ],
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();
    const traces = store.snapshot().traces;

    expect(store.snapshot()).toMatchObject({
      version: 3,
      users: [{ id: "local-user", name: "Local User" }],
      credentials: [],
      authSessions: [],
    });

    expect(traces.map((event) => event.traceId)).toEqual(["run-1", "run-1", "run-1"]);
    expect(traces[0]).toMatchObject({ spanId: "root-event", parentSpanId: null });
    expect(traces[1]).toMatchObject({
      spanId: "runtime-event",
      parentSpanId: "root-event",
    });
    expect(traces[2]).toMatchObject({
      spanId: "model-event",
      parentSpanId: "runtime-event",
    });
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});
