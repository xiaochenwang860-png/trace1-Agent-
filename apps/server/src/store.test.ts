import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";
import { isGitWorkspaceRecoveryCheckpoint } from "./types.js";

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
      version: 6,
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

  it("adds empty recovery state to runs from database version 3", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 3,
        users: [],
        credentials: [],
        authSessions: [],
        agents: [],
        messages: [],
        runs: [
          {
            id: "run-1",
            agentId: "agent-1",
            status: "failed",
            prompt: "legacy run",
            output: null,
            error: "failed",
            usage: null,
            startedAt: null,
            completedAt: null,
            createdAt: "2026-08-30T00:00:00.000Z",
          },
        ],
        traces: [],
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();

    expect(store.snapshot().version).toBe(6);
    expect(store.snapshot().runs[0]?.recovery).toEqual({
      before: null,
      after: null,
      captureError: null,
      pendingRestores: [],
      restores: [],
    });
  });

  it("retains legacy checkpoint metadata but marks it unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    const legacyCheckpoint = {
      rootHash: "a".repeat(64),
      policyId: "workspace-v1",
      fileCount: 3,
      totalBytes: 128,
      capturedAt: "2026-08-30T00:00:00.000Z",
    };
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 4,
        users: [],
        credentials: [],
        authSessions: [],
        agents: [],
        messages: [],
        runs: [
          {
            id: "run-legacy",
            agentId: "agent-1",
            status: "failed",
            prompt: "legacy run",
            output: null,
            error: "failed",
            usage: null,
            recovery: {
              before: legacyCheckpoint,
              after: null,
              captureError: null,
              pendingRestores: [],
              restores: [],
            },
            startedAt: null,
            completedAt: null,
            createdAt: "2026-08-30T00:00:00.000Z",
          },
        ],
        traces: [],
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();

    const before = store.snapshot().runs[0]?.recovery.before;
    expect(before).toEqual({
      ...legacyCheckpoint,
      storage: "legacy-unavailable-v1",
      unavailableReason:
        "This checkpoint predates Git-backed recovery and is retained for history only",
    });
    expect(isGitWorkspaceRecoveryCheckpoint(before)).toBe(false);
    expect(JSON.parse(await readFile(databasePath, "utf8"))).toMatchObject({
      version: 6,
      runs: [{ recovery: { before: { storage: "legacy-unavailable-v1" } } }],
    });
  });

  it("keeps complete Git checkpoint locators and rejects incomplete ones", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    const metadata = {
      rootHash: "1".repeat(64),
      policyId: "workspace-v1",
      fileCount: 1,
      totalBytes: 8,
      capturedAt: "2026-08-31T00:00:00.000Z",
    };
    const gitCheckpoint = {
      ...metadata,
      storage: "git-sha256-v1",
      repositoryId: "agent-1",
      commitOid: "2".repeat(64),
      workspaceTreeOid: "3".repeat(64),
      manifestBlobOid: "4".repeat(64),
    };
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 5,
        users: [],
        credentials: [],
        authSessions: [],
        agents: [],
        messages: [],
        runs: [
          {
            id: "run-git",
            agentId: "agent-1",
            status: "failed",
            prompt: "git run",
            output: null,
            error: "failed",
            usage: null,
            recovery: {
              before: gitCheckpoint,
              after: { ...gitCheckpoint, commitOid: "not-a-sha256-oid" },
              captureError: null,
              pendingRestores: [],
              restores: [],
            },
            startedAt: null,
            completedAt: null,
            createdAt: "2026-08-31T00:00:00.000Z",
          },
        ],
        traces: [],
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();

    const recovery = store.snapshot().runs[0]?.recovery;
    expect(recovery?.before).toEqual(gitCheckpoint);
    expect(isGitWorkspaceRecoveryCheckpoint(recovery?.before)).toBe(true);
    expect(recovery?.after).toEqual({
      ...metadata,
      storage: "legacy-unavailable-v1",
      unavailableReason: "Git-backed checkpoint metadata is incomplete and cannot be restored",
    });
    expect(isGitWorkspaceRecoveryCheckpoint(recovery?.after)).toBe(false);
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
