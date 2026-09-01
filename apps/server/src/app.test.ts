import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
  getTrace: () => [
    {
      id: "trace-1",
      traceId: "00000000-0000-4000-8000-000000000001",
      spanId: "trace-1",
      parentSpanId: null,
      sequence: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      agentId: "agent-1",
      type: "run.completed",
      status: "success",
      timestamp: "2026-08-28T00:00:00.000Z",
      durationMs: 125,
      summary: "Agent Runtime execution completed",
      error: null,
    },
  ],
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("exposes self-registration and accepts account session tokens", async () => {
    const user = {
      id: "registered-user",
      name: "Alice",
      createdAt: "2026-08-29T00:00:00.000Z",
    };
    const authService = {
      registerUser: async () => ({ user, token: "session-token" }),
      loginUser: async () => ({ user, token: "session-token" }),
      authenticateSession: (token: string) =>
        token === "session-token" ? user : null,
      revokeSession: async () => undefined,
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), authService);

    expect((await app.inject({ method: "GET", url: "/api/auth" })).json()).toMatchObject({
      required: true,
      selfRegistration: true,
    });
    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Alice", password: "secure-password" },
    });
    expect(registration.statusCode).toBe(201);
    expect(registration.json()).toMatchObject({ user, token: "session-token" });

    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { authorization: "Bearer session-token" },
    });
    expect(session.json()).toEqual({ user: { id: user.id, name: user.name } });
    await app.close();
  });

  it("accepts ordinary user passwords with common special characters", async () => {
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        APP_USERS_JSON: JSON.stringify([
          { id: "alice", name: "Alice", token: "TikTokTechJam2026!" },
        ]),
      }),
      service,
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer TikTokTechJam2026!" },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("maps different user tokens to isolated Agent lists", async () => {
    const isolatedService = {
      listAgents: (ownerUserId: string) => [
        {
          id: ownerUserId + "-agent",
          ownerUserId,
          name: ownerUserId + " Agent",
        },
      ],
    } as unknown as AgentService;
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        APP_USERS_JSON: JSON.stringify([
          { id: "alice", name: "Alice", token: "alice-token" },
          { id: "bob", name: "Bob", token: "bob-token" },
        ]),
      }),
      isolatedService,
    );

    const alice = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer alice-token" },
    });
    const bob = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer bob-token" },
    });
    expect(alice.json().agents[0].ownerUserId).toBe("alice");
    expect(bob.json().agents[0].ownerUserId).toBe("bob");
    await app.close();
  });

  it("redacts prompts, outputs, workspace details, and API keys for developers", async () => {
    const redactionService = {
      developerOverview: () => ({
        users: [
          {
            id: "alice",
            name: "Alice",
            createdAt: "2026-08-28T00:00:00.000Z",
            agentCount: 1,
            runCount: 1,
            failedRunCount: 1,
            lastActivityAt: "2026-08-28T00:00:00.000Z",
          },
        ],
        agents: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            ownerUserId: "alice",
            instructions: "secret instructions",
            workspacePath: "/secret/workspace",
            codexThreadId: "secret-thread",
            lastError: "ARK_API_KEY=ark-secret-value",
          },
        ],
        runs: [
          {
            id: "00000000-0000-4000-8000-000000000002",
            agentId: "00000000-0000-4000-8000-000000000001",
            prompt: "private overview prompt",
            output: "private overview output",
            error: "Bearer ark-secret-value",
            status: "failed",
            usage: null,
            startedAt: "2026-08-28T00:00:00.000Z",
            completedAt: "2026-08-28T00:00:01.000Z",
            createdAt: "2026-08-28T00:00:00.000Z",
          },
        ],
      }),
      developerAnalytics: () => ({
        userId: "alice",
        totalRuns: 1,
        completedRunCount: 0,
        failedRunCount: 1,
        successRate: 0,
        averageDurationMs: 120,
        inputTokens: 10,
        cachedInputTokens: 5,
        outputTokens: 2,
        agents: [],
      }),
      getRuns: () => [
        {
          prompt: "private prompt",
          output: "private output",
          error: "Bearer ark-secret-value",
        },
      ],
      getTrace: () => [
        {
          summary: "API_KEY=ark-secret-value",
          error: "invalid ark-secret-value",
        },
      ],
    } as unknown as AgentService;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", TRACE_VIEWER_TOKEN: "developer-token" }),
      redactionService,
    );
    const headers = { "x-trace-viewer-token": "developer-token" };
    const overview = await app.inject({
      method: "GET",
      url: "/api/developer/overview",
      headers,
    });
    const runs = await app.inject({
      method: "GET",
      url: "/api/developer/agents/00000000-0000-4000-8000-000000000001/runs",
      headers,
    });
    const analytics = await app.inject({
      method: "GET",
      url: "/api/developer/analytics?userId=alice",
      headers,
    });
    const traces = await app.inject({
      method: "GET",
      url: "/api/developer/runs/00000000-0000-4000-8000-000000000001/trace",
      headers,
    });

    expect(overview.json().agents[0]).toMatchObject({
      instructions: "[REDACTED]",
      workspacePath: "[REDACTED]",
      codexThreadId: null,
    });
    expect(overview.json().runs[0]).toMatchObject({
      prompt: "[REDACTED]",
      output: "[REDACTED]",
    });
    expect(JSON.stringify(overview.json())).not.toContain("ark-secret-value");
    expect(analytics.json()).toMatchObject({
      userId: "alice",
      totalRuns: 1,
      agents: [],
    });
    expect(runs.json().runs[0]).toMatchObject({
      prompt: "[REDACTED]",
      output: "[REDACTED]",
    });
    expect(JSON.stringify(runs.json())).not.toContain("ark-secret-value");
    expect(JSON.stringify(traces.json())).not.toContain("ark-secret-value");
    await app.close();
  });

  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "test-user-token" }),
      service,
    );
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-user-token",
      },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-user-token",
      },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("returns Trace records for an Agent run", async () => {
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        APP_AUTH_TOKEN: "test-user-token",
        TRACE_VIEWER_TOKEN: "developer-token",
      }),
      service,
    );
    const denied = await app.inject({
      method: "GET",
      url: "/api/runs/00000000-0000-4000-8000-000000000001/trace",
      headers: { authorization: "Bearer test-user-token" },
    });
    expect(denied.statusCode).toBe(403);

    const response = await app.inject({
      method: "GET",
      url: "/api/runs/00000000-0000-4000-8000-000000000001/trace",
      headers: {
        authorization: "Bearer test-user-token",
        "x-trace-viewer-token": "developer-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      traces: [{ type: "run.completed", status: "success" }],
    });
    await app.close();
  });

  it("streams live Trace events to an authorized Developer Console", async () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const baseEvent = {
      traceId: runId,
      runId,
      agentId: "agent-1",
      parentSpanId: null,
      durationMs: null,
      error: null,
    };
    const streamingService = {
      getRun: () => ({ id: runId, status: "running" }),
      getTrace: () => [
        {
          ...baseEvent,
          id: "snapshot-event",
          spanId: "snapshot-event",
          sequence: 1,
          type: "run.started",
          status: "info",
          timestamp: "2026-08-28T00:00:00.000Z",
          summary: "Task accepted",
        },
      ],
      subscribeToTrace: (
        _id: string,
        subscriber: (event: Record<string, unknown>) => void,
      ) => {
        const timer = setTimeout(() => {
          const toolEvent = {
            ...baseEvent,
            id: "tool-event",
            spanId: "tool-event",
            sequence: 2,
            type: "tool.started",
            status: "info",
            timestamp: "2026-08-28T00:00:01.000Z",
            summary: "Command execution: npm",
          };
          subscriber(toolEvent);
          subscriber(toolEvent);
          subscriber({
            ...baseEvent,
            id: "completed-event",
            spanId: "completed-event",
            sequence: 3,
            type: "run.completed",
            status: "success",
            timestamp: "2026-08-28T00:00:02.000Z",
            summary: "Run completed",
          });
        }, 0);
        return () => clearTimeout(timer);
      },
    } as unknown as AgentService;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", TRACE_VIEWER_TOKEN: "developer-token" }),
      streamingService,
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/developer/runs/${runId}/stream`,
      { headers: { "X-Trace-Viewer-Token": "developer-token" } },
    );
    const messages = (await response.text())
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; event?: { type: string } });

    expect(response.status).toBe(200);
    expect(messages[0]?.type).toBe("snapshot");
    expect(messages.slice(1).map((message) => message.event?.type)).toEqual([
      "tool.started",
      "run.completed",
    ]);
    await app.close();
  });

  it("validates Developer Console access independently from user access", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", TRACE_VIEWER_TOKEN: "developer-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/developer/auth" });
    expect(denied.json()).toEqual({ configured: true, authorized: false });

    const allowed = await app.inject({
      method: "GET",
      url: "/api/developer/auth",
      headers: { "x-trace-viewer-token": "developer-token" },
    });
    expect(allowed.json()).toEqual({ configured: true, authorized: true });
    await app.close();
  });
});
