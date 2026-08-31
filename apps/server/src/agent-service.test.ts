import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { AttemptTrace } from "./attempt-trace.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import { TraceJournal } from "./trace-journal.js";
import type { AgentRunner, RunnerRequest, RunnerResult, TraceEvent } from "./types.js";
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
      operationId: "model-turn-1",
    });
    request.onTrace?.({
      type: "model.completed",
      status: "success",
      timestamp: new Date().toISOString(),
      durationMs: 1,
      summary: "Codex model turn completed",
      error: null,
      operationId: "model-turn-1",
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
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...environment,
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
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
      "runtime.started",
      "model.requested",
      "model.completed",
      "run.completed",
    ]);
    expect(new Set(trace.map((event) => event.traceId))).toEqual(new Set([run.id]));
    expect(trace.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(trace[2]?.spanId).toBe(trace[3]?.spanId);
    expect(trace[0]?.parentSpanId).toBeNull();
    expect(trace[1]?.parentSpanId).toBe(trace[0]?.spanId);
    expect(trace[2]?.parentSpanId).toBe(trace[1]?.spanId);
    expect(trace[3]?.parentSpanId).toBe(trace[1]?.spanId);
    expect(trace[4]?.parentSpanId).toBe(trace[0]?.spanId);
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

    expect(service.getTrace(run.id).map((event) => event.type)).toEqual([
      "run.started",
      "runtime.started",
      "file.changed",
      "run.failed",
    ]);
    expect(service.getTrace(run.id).at(-1)).toMatchObject({
      status: "error",
      error: "Runtime unavailable",
    });
    expect(service.getTrace(run.id)[2]?.summary).toContain("partial-result.txt");
  });

  it("keeps the Run successful when a failed attempt is recovered by retry", async () => {
    const service = await makeService({
      run: async (request) => {
        const first = new AttemptTrace(request.onTrace, {
          attemptId: "attempt-1",
          attemptNumber: 1,
        });
        first.fail({
          error: new Error("temporary upstream timeout"),
          errorCode: "TIMEOUT",
          retryable: true,
        });
        const nextAttemptId = first.scheduleRetry({
          nextAttemptId: "attempt-2",
          delayMs: 0,
        });
        const second = new AttemptTrace(request.onTrace, {
          attemptId: nextAttemptId,
          attemptNumber: 2,
          retryOfAttemptId: first.attemptId,
        });
        second.complete();
        return { output: "recovered", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Retry Agent" });
    const { run } = await service.sendMessage(agent.id, "retry a transient failure");

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const trace = service.getTrace(run.id);
    expect(trace.map((event) => event.type)).toEqual([
      "run.started",
      "runtime.started",
      "attempt.started",
      "attempt.failed",
      "retry.scheduled",
      "attempt.started",
      "attempt.completed",
      "run.completed",
    ]);
    expect(trace[2]).toMatchObject({
      spanId: "attempt-1",
      attemptId: "attempt-1",
      attemptNumber: 1,
      parentSpanId: trace[1]?.spanId,
    });
    expect(trace[3]).toMatchObject({
      spanId: "attempt-1",
      errorCode: "TIMEOUT",
      retryable: true,
    });
    expect(trace[4]).toMatchObject({
      parentSpanId: "attempt-1",
      nextAttemptId: "attempt-2",
      retryDelayMs: 0,
    });
    expect(trace[5]).toMatchObject({
      spanId: "attempt-2",
      retryOfAttemptId: "attempt-1",
    });
    expect(trace.at(-1)?.type).toBe("run.completed");
  });

  it("publishes Runner Trace events before the Run completes", async () => {
    let emitTrace: RunnerRequest["onTrace"];
    let finish!: (result: RunnerResult) => void;
    let announceRunner!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      announceRunner = resolve;
    });
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: (request) => {
        emitTrace = request.onTrace;
        announceRunner();
        return pending;
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Live Trace" });
    const { run } = await service.sendMessage(agent.id, "observe this run");
    const received: string[] = [];
    const unsubscribe = service.subscribeToTrace(run.id, (event) => {
      received.push(event.type);
    });

    await runnerStarted;
    emitTrace?.({
      type: "model.requested",
      status: "info",
      timestamp: new Date().toISOString(),
      durationMs: null,
      summary: "Codex model turn started",
      error: null,
    });

    expect(received).toEqual(["runtime.started", "model.requested"]);
    expect(service.getRun(run.id).status).toBe("running");
    expect(service.getTrace(run.id).map((event) => event.type)).toContain(
      "model.requested",
    );

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    unsubscribe();
  });

  it("recovers live Trace journal records after a server restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-recovery-test-"));
    temporaryDirectories.push(root);
    const dataDirectory = path.join(root, "data");
    const workspaceRoot = path.join(root, "workspaces");
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: dataDirectory,
      AGENT_WORKSPACE_ROOT: workspaceRoot,
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const seedStore = new JsonStore(path.join(dataDirectory, "db.json"));
    await seedStore.initialize();
    const createdAt = "2026-08-28T00:00:00.000Z";
    await seedStore.mutate((database) => {
      database.agents.push({
        id: "agent-1",
        ownerUserId: "local-user",
        name: "Recovery Agent",
        description: "",
        instructions: "",
        status: "busy",
        workspacePath: path.join(workspaceRoot, "agent-1"),
        codexThreadId: null,
        lastError: null,
        createdAt,
        updatedAt: createdAt,
      });
      database.runs.push({
        id: "run-1",
        agentId: "agent-1",
        status: "running",
        prompt: "recover me",
        output: null,
        error: null,
        usage: null,
        startedAt: createdAt,
        completedAt: null,
        createdAt,
      });
      database.traces.push(
        {
          id: "event-1",
          traceId: "run-1",
          spanId: "run-span",
          parentSpanId: null,
          sequence: 1,
          runId: "run-1",
          agentId: "agent-1",
          type: "run.started",
          status: "info",
          timestamp: createdAt,
          durationMs: null,
          summary: "Task accepted",
          error: null,
        },
        {
          id: "event-2",
          traceId: "run-1",
          spanId: "runtime-span",
          parentSpanId: "run-span",
          sequence: 2,
          runId: "run-1",
          agentId: "agent-1",
          type: "runtime.started",
          status: "info",
          timestamp: createdAt,
          durationMs: null,
          summary: "Runtime started",
          error: null,
        },
      );
    });
    const journal = new TraceJournal(path.join(dataDirectory, "trace-journal"));
    await journal.initialize();
    const liveEvent: TraceEvent = {
      id: "event-3",
      traceId: "run-1",
      spanId: "tool-span",
      parentSpanId: "runtime-span",
      sequence: 3,
      runId: "run-1",
      agentId: "agent-1",
      type: "tool.started",
      status: "info",
      timestamp: "2026-08-28T00:00:01.000Z",
      durationMs: null,
      summary: "Command execution: npm",
      error: null,
    };
    await journal.append(liveEvent);

    const service = new AgentService(
      config,
      new JsonStore(path.join(dataDirectory, "db.json")),
      new WorkspaceManager(workspaceRoot),
      new FakeRunner(),
    );
    await service.initialize();

    expect(service.getTrace("run-1").map((event) => [event.sequence, event.type])).toEqual([
      [1, "run.started"],
      [2, "runtime.started"],
      [3, "tool.started"],
      [4, "run.cancelled"],
    ]);
    expect((await journal.recover()).has("run-1")).toBe(false);
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
