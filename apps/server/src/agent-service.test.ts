import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RecoveryStore } from "./recovery-store.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    const startedAt = new Date();
    request.onTrace?.({
      type: "model.requested",
      status: "info",
      timestamp: startedAt.toISOString(),
      durationMs: null,
      summary: "Codex model turn started",
      error: null,
    });
    request.onTrace?.({
      type: "model.completed",
      status: "success",
      timestamp: new Date().toISOString(),
      durationMs: 1,
      summary: "Codex model turn completed",
      error: null,
    });
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  environment: NodeJS.ProcessEnv = {},
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  return (await openService(root, runner, environment)).service;
}

async function openService(
  root: string,
  runner: AgentRunner = new FakeRunner(),
  environment: NodeJS.ProcessEnv = {},
): Promise<{
  service: AgentService;
  store: JsonStore;
  recoveryStore: RecoveryStore;
}> {
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...environment,
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const recoveryStore = new RecoveryStore(path.join(root, "data", "recovery"), {
    allowTestFileBackend: true,
  });
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    recoveryStore,
  );
  await service.initialize();
  return { service, store, recoveryStore };
}

describe("Agent lifecycle", () => {
  it("registers users, verifies hashed passwords, and revokes login sessions", async () => {
    const service = await makeService();
    const registered = await service.registerUser("Alice", "correct-horse-42");

    expect(registered.token).not.toContain("correct-horse-42");
    expect(service.authenticateSession(registered.token)).toMatchObject({
      id: registered.user.id,
      name: "Alice",
    });
    await expect(service.loginUser("alice", "wrong-password")).rejects.toMatchObject({
      statusCode: 401,
    });

    const login = await service.loginUser("ALICE", "correct-horse-42");
    expect(service.authenticateSession(login.token)?.id).toBe(registered.user.id);
    await expect(
      service.registerUser(" alice ", "another-password"),
    ).rejects.toMatchObject({ statusCode: 409 });

    const agent = await service.createAgent(
      { name: "Alice Agent" },
      registered.user.id,
    );
    expect(service.listAgents(registered.user.id)).toEqual([agent]);
    expect(service.developerOverview().users).toContainEqual(
      expect.objectContaining({
        id: registered.user.id,
        name: "Alice",
        agentCount: 1,
      }),
    );

    await service.revokeSession(login.token);
    expect(service.authenticateSession(login.token)).toBeNull();
  });

  it("isolates Agents by their owner user", async () => {
    const service = await makeService(new FakeRunner(), {
      APP_USERS_JSON: JSON.stringify([
        { id: "alice", name: "Alice", token: "alice-token" },
        { id: "bob", name: "Bob", token: "bob-token" },
      ]),
    });
    const aliceAgent = await service.createAgent({ name: "Alice Agent" }, "alice");
    const bobAgent = await service.createAgent({ name: "Bob Agent" }, "bob");

    expect(service.listAgents("alice").map((agent) => agent.id)).toEqual([
      aliceAgent.id,
    ]);
    expect(service.listAgents("bob").map((agent) => agent.id)).toEqual([
      bobAgent.id,
    ]);
    expect(() => service.getAgent(bobAgent.id, "alice")).toThrow("Agent not found");
    await expect(
      service.updateAgent(bobAgent.id, { name: "Stolen" }, "alice"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
    const trace = service.getTrace(run.id);
    expect(trace.map((event) => event.type)).toEqual([
      "run.started",
      "workspace.checkpoint.created",
      "runtime.started",
      "attempt.started",
      "model.requested",
      "model.completed",
      "attempt.completed",
      "workspace.diff.generated",
      "run.completed",
    ]);
    expect(new Set(trace.map((event) => event.traceId))).toEqual(new Set([run.id]));
    expect(new Set(trace.map((event) => event.spanId)).size).toBe(trace.length - 1);
    expect(trace[0]?.parentSpanId).toBeNull();
    expect(trace[1]?.parentSpanId).toBe(trace[0]?.spanId);
    expect(trace[2]?.parentSpanId).toBe(trace[0]?.spanId);
    expect(trace[3]?.parentSpanId).toBe(trace[2]?.spanId);
    expect(trace[4]?.parentSpanId).toBe(trace[3]?.spanId);
    expect(trace[5]?.parentSpanId).toBe(trace[3]?.spanId);
    expect(trace[6]?.parentSpanId).toBe(trace[2]?.spanId);
    expect(trace[7]?.parentSpanId).toBe(trace[2]?.spanId);
    expect(trace[8]?.parentSpanId).toBe(trace[0]?.spanId);
    expect(trace.at(-1)).toMatchObject({
      status: "success",
      durationMs: expect.any(Number),
    });
  });

  it("records a failure Trace when the Runtime throws", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(
          path.join(request.workspacePath, "partial-result.txt"),
          "created before failure",
          "utf8",
        );
        throw new Error("Runtime unavailable");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Failing Agent" });
    const { run } = await service.sendMessage(agent.id, "run a task");

    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    const trace = service.getTrace(run.id);
    const eventTypes = trace.map((event) => event.type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "run.started",
        "workspace.checkpoint.created",
        "runtime.started",
        "file.changed",
        "workspace.diff.generated",
        "run.failed",
      ]),
    );
    expect(eventTypes.indexOf("workspace.checkpoint.created")).toBeLessThan(
      eventTypes.indexOf("runtime.started"),
    );
    expect(trace.at(-1)).toMatchObject({
      status: "error",
      error: "Runtime unavailable",
    });
    expect(trace.find((event) => event.type === "file.changed")?.summary).toContain(
      "partial-result.txt",
    );
  });

  it("restores exact bytes deleted by a failed run and resets stale model context", async () => {
    let invocation = 0;
    const service = await makeService({
      run: async (request) => {
        invocation += 1;
        if (invocation === 1) {
          return { output: "thread established", threadId: "stale-thread", usage: null };
        }
        await rm(path.join(request.workspacePath, "src", "nested", "payload.bin"));
        throw new Error("failed after deleting payload");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Recovery Agent" });
    const first = await service.sendMessage(agent.id, "establish context");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    expect(service.getAgent(agent.id).codexThreadId).toBe("stale-thread");

    const deletedPath = path.join(agent.workspacePath, "src", "nested", "payload.bin");
    const originalBytes = Buffer.from([0, 255, 13, 10, 42, 128, 7]);
    await mkdir(path.dirname(deletedPath), { recursive: true });
    await writeFile(deletedPath, originalBytes);
    const failed = await service.sendMessage(agent.id, "delete then fail");
    await expect.poll(() => service.getRun(failed.run.id).status).toBe("failed");
    await expect(readFile(deletedPath)).rejects.toMatchObject({ code: "ENOENT" });

    const recovery = await service.getRunRecovery(failed.run.id, agent.ownerUserId);
    expect(recovery.summary).toMatchObject({ deleted: 1, total: 1 });
    expect(recovery.files).toContainEqual(
      expect.objectContaining({ path: "src/nested/payload.bin", kind: "deleted" }),
    );
    await expect(
      service.getRunRecovery(failed.run.id, "another-owner"),
    ).rejects.toMatchObject({ statusCode: 404 });

    const selection = { mode: "paths" as const, paths: ["src/nested/payload.bin"] };
    const actor = { type: "owner" as const, id: agent.ownerUserId };
    const preview = await service.previewRunRecovery(
      failed.run.id,
      recovery.checkpointId,
      selection,
      actor,
      agent.ownerUserId,
    );
    expect(preview).toMatchObject({
      canApply: true,
      actions: [{ path: "src/nested/payload.bin", action: "create" }],
      conflicts: [],
    });
    const operation = await service.restoreRunRecovery(
      failed.run.id,
      recovery.checkpointId,
      preview.id,
      selection,
      "restore-deleted-payload",
      actor,
      agent.ownerUserId,
    );

    expect(operation.status).toBe("completed");
    expect(operation.restoredPaths).toContain("src/nested/payload.bin");
    expect(service.getRun(failed.run.id).recovery).toMatchObject({
      pendingRestores: [],
      restores: [expect.objectContaining({ id: operation.id })],
    });
    expect(await readFile(deletedPath)).toEqual(originalBytes);
    expect(service.getAgent(agent.id)).toMatchObject({
      status: "ready",
      codexThreadId: null,
    });
    expect(service.getTrace(failed.run.id).map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "workspace.restore.started",
        "workspace.restore.completed",
      ]),
    );
  });

  it("blocks a stale restore preview without overwriting newer user content", async () => {
    const service = await makeService({
      run: async (request) => {
        await rm(path.join(request.workspacePath, "important.txt"));
        throw new Error("failed after delete");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Conflict Agent" });
    const importantPath = path.join(agent.workspacePath, "important.txt");
    await writeFile(importantPath, "checkpoint content", "utf8");
    const failed = await service.sendMessage(agent.id, "delete important file");
    await expect.poll(() => service.getRun(failed.run.id).status).toBe("failed");

    const recovery = await service.getRunRecovery(failed.run.id, agent.ownerUserId);
    const selection = { mode: "paths" as const, paths: ["important.txt"] };
    const actor = { type: "owner" as const, id: agent.ownerUserId };
    const preview = await service.previewRunRecovery(
      failed.run.id,
      recovery.checkpointId,
      selection,
      actor,
      agent.ownerUserId,
    );
    expect(preview.canApply).toBe(true);

    await writeFile(importantPath, "newer user content", "utf8");
    await expect(
      service.restoreRunRecovery(
        failed.run.id,
        recovery.checkpointId,
        preview.id,
        selection,
        "stale-preview-restore",
        actor,
        agent.ownerUserId,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      payload: { preview: { canApply: false } },
    });
    expect(await readFile(importantPath, "utf8")).toBe("newer user content");
    expect(service.getRun(failed.run.id).recovery.pendingRestores).toEqual([]);
    expect(service.getAgent(agent.id)).toMatchObject({
      status: "error",
      lastError: "failed after delete",
    });
    expect(service.getTrace(failed.run.id).map((event) => event.type)).toContain(
      "workspace.restore.blocked",
    );
  });

  it("reconciles a committed filesystem restore whose audit was interrupted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
    temporaryDirectories.push(root);
    const initial = await openService(root);
    const agent = await initial.service.createAgent({ name: "Restart Recovery" });
    const { run } = await initial.service.sendMessage(agent.id, "establish model context");
    await expect.poll(() => initial.service.getRun(run.id).status).toBe("completed");

    const statePath = path.join(agent.workspacePath, "state.txt");
    await writeFile(statePath, "broken state", "utf8");
    const expected = await initial.recoveryStore.capture(agent.workspacePath);
    await writeFile(statePath, "recovered state", "utf8");
    const resulting = await initial.recoveryStore.capture(agent.workspacePath);
    const operationId = "00000000-0000-4000-8000-000000000101";
    const startedAt = new Date(Date.now() - 1_000).toISOString();

    await initial.store.mutate((database) => {
      const storedRun = database.runs.find((candidate) => candidate.id === run.id);
      const storedAgent = database.agents.find((candidate) => candidate.id === agent.id);
      if (!storedRun || !storedAgent || !storedRun.recovery.before) {
        throw new Error("Recovery fixture was not persisted");
      }
      storedRun.recovery.pendingRestores.push({
        id: operationId,
        idempotencyKeyHash: "1".repeat(64),
        checkpointId: storedRun.recovery.before.rootHash,
        actorType: "owner",
        actorId: agent.ownerUserId,
        mode: "paths",
        selectedPaths: ["state.txt"],
        restoredPaths: ["state.txt"],
        expectedRootHash: expected.rootHash,
        resultingRootHash: resulting.rootHash,
        startedAt,
      });
      storedAgent.status = "busy";
      storedAgent.codexThreadId = "stale-thread-after-restore";
    });

    const restarted = await openService(root);
    const recoveredRun = restarted.service.getRun(run.id);
    expect(recoveredRun.recovery.pendingRestores).toEqual([]);
    expect(recoveredRun.recovery.restores).toContainEqual(
      expect.objectContaining({
        id: operationId,
        previousRootHash: expected.rootHash,
        restoredRootHash: resulting.rootHash,
        safetySnapshotId: expected.rootHash,
        restoredPaths: ["state.txt"],
      }),
    );
    expect(restarted.service.getAgent(agent.id)).toMatchObject({
      status: "ready",
      codexThreadId: null,
      lastError: null,
    });
    expect(await readFile(statePath, "utf8")).toBe("recovered state");
    expect(restarted.service.getTrace(run.id)).toContainEqual(
      expect.objectContaining({
        type: "workspace.restore.completed",
        status: "success",
        summary: expect.stringContaining("reconciled after restart"),
      }),
    );
  });

  it("clears a rolled-back restore intent without recording a successful restore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
    temporaryDirectories.push(root);
    const initial = await openService(root);
    const agent = await initial.service.createAgent({ name: "Rollback Recovery" });
    const { run } = await initial.service.sendMessage(agent.id, "establish model context");
    await expect.poll(() => initial.service.getRun(run.id).status).toBe("completed");

    const statePath = path.join(agent.workspacePath, "state.txt");
    await writeFile(statePath, "recovered state", "utf8");
    const resulting = await initial.recoveryStore.capture(agent.workspacePath);
    await writeFile(statePath, "original state", "utf8");
    const expected = await initial.recoveryStore.capture(agent.workspacePath);
    const operationId = "00000000-0000-4000-8000-000000000102";

    await initial.store.mutate((database) => {
      const storedRun = database.runs.find((candidate) => candidate.id === run.id);
      const storedAgent = database.agents.find((candidate) => candidate.id === agent.id);
      if (!storedRun || !storedAgent || !storedRun.recovery.before) {
        throw new Error("Recovery fixture was not persisted");
      }
      storedRun.recovery.pendingRestores.push({
        id: operationId,
        idempotencyKeyHash: "2".repeat(64),
        checkpointId: storedRun.recovery.before.rootHash,
        actorType: "owner",
        actorId: agent.ownerUserId,
        mode: "paths",
        selectedPaths: ["state.txt"],
        restoredPaths: ["state.txt"],
        expectedRootHash: expected.rootHash,
        resultingRootHash: resulting.rootHash,
        startedAt: new Date(Date.now() - 1_000).toISOString(),
      });
      storedAgent.status = "busy";
      storedAgent.codexThreadId = "valid-thread-before-rollback";
    });

    const restarted = await openService(root);
    const recoveredRun = restarted.service.getRun(run.id);
    expect(recoveredRun.recovery.pendingRestores).toEqual([]);
    expect(recoveredRun.recovery.restores).not.toContainEqual(
      expect.objectContaining({ id: operationId }),
    );
    expect(restarted.service.getAgent(agent.id)).toMatchObject({
      status: "ready",
      codexThreadId: "valid-thread-before-rollback",
      lastError: null,
    });
    expect(await readFile(statePath, "utf8")).toBe("original state");
    expect(restarted.service.getTrace(run.id)).toContainEqual(
      expect.objectContaining({
        type: "workspace.restore.blocked",
        status: "error",
        summary: "Interrupted workspace restore was rolled back during restart",
      }),
    );
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});
