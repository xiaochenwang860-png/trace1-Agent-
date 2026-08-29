import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
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
    expect(new Set(trace.map((event) => event.spanId)).size).toBe(trace.length);
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
