import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { createTextRedactor, redactNullable } from "./redaction.js";
import type { AgentService } from "./agent-service.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const checkpointId = z.string().regex(/^[a-f0-9]{64}$/, "Invalid recovery checkpoint");
const recoverySelection = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({
    mode: z.literal("paths"),
    paths: z.array(z.string().min(1).max(1_024)).min(1).max(10_000),
  }),
]);
const recoveryPreviewBody = z.object({
  checkpointId,
  selection: recoverySelection,
});
const recoveryRestoreBody = z.object({
  checkpointId,
  previewId: z.string().uuid(),
  selection: recoverySelection,
});
const idempotencyKey = z.string().trim().min(8).max(200);
const developerAnalyticsQuery = z.object({
  userId: z.string().trim().min(1).max(128),
});
const accountCredentialsBody = z.object({
  name: z.string().trim().min(2).max(80),
  password: z.string().min(8).max(128),
});

function tokenMatches(expected: string, candidate: string): boolean {
  if (!expected || !candidate) return false;
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.x-trace-viewer-token",
        "req.headers.x-recovery-operator-token",
      ],
    },
    bodyLimit: 1_048_576,
  });
  const redactText = createTextRedactor(config);
  const redactValue = (value: string | null) => redactNullable(redactText, value);
  const requestUsers = new WeakMap<FastifyRequest, { id: string; name: string }>();

  const developerAuthorized = (request: FastifyRequest): boolean => {
    const header = request.headers["x-trace-viewer-token"];
    const candidate = typeof header === "string" ? header : "";
    return tokenMatches(config.traceViewerToken, candidate);
  };

  const requireDeveloper = (request: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => {
    if (!developerAuthorized(request)) {
      return reply.code(403).send({ error: "Developer Trace access required" });
    }
  };

  const recoveryOperatorAuthorized = (request: FastifyRequest): boolean => {
    const header = request.headers["x-recovery-operator-token"];
    const candidate = typeof header === "string" ? header : "";
    return tokenMatches(config.recoveryOperatorToken, candidate);
  };

  const requireRecoveryOperator = (
    request: FastifyRequest,
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    if (!recoveryOperatorAuthorized(request)) {
      return reply.code(403).send({ error: "Recovery operator access required" });
    }
  };

  const currentUser = (request: FastifyRequest) => {
    const user = requestUsers.get(request);
    if (!user) throw new HttpError(401, "Authentication required");
    return user;
  };

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth" ||
      request.url === "/api/auth/register" ||
      request.url === "/api/auth/login" ||
      request.url === "/api/system" ||
      request.url.startsWith("/api/developer/")
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const configuredAccount = config.userAccounts.find(
      (entry) => entry.token && tokenMatches(entry.token, candidate),
    );
    const sessionUser =
      configuredAccount || !candidate ? null : service.authenticateSession(candidate);
    const user = configuredAccount
      ? { id: configuredAccount.id, name: configuredAccount.name }
      : sessionUser;
    if (!user) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    requestUsers.set(request, { id: user.id, name: user.name });
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({
    required: true,
    multiUser: true,
    selfRegistration: true,
    legacyTokenEnabled: config.userAuthRequired,
  }));

  app.post("/api/auth/register", async (request, reply) => {
    const body = accountCredentialsBody.parse(request.body);
    return reply.code(201).send(await service.registerUser(body.name, body.password));
  });

  app.post("/api/auth/login", async (request) => {
    const body = accountCredentialsBody.parse(request.body);
    return service.loginUser(body.name, body.password);
  });

  app.post("/api/auth/logout", async (request) => {
    currentUser(request);
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    await service.revokeSession(token);
    return { ok: true };
  });

  app.get("/api/session", async (request) => ({ user: currentUser(request) }));

  app.get("/api/developer/auth", async (request) => {
    return {
      configured: config.traceViewerToken.length > 0,
      authorized: developerAuthorized(request),
      recoveryConfigured: config.recoveryOperatorToken.length > 0,
    };
  });

  app.get("/api/developer/overview", async (request, reply) => {
    const denied = requireDeveloper(request, reply);
    if (denied) return denied;
    const overview = service.developerOverview();
    return {
      users: overview.users,
      agents: overview.agents.map((agent) => ({
        ...agent,
        instructions: "[REDACTED]",
        workspacePath: "[REDACTED]",
        codexThreadId: null,
        lastError: redactValue(agent.lastError),
      })),
      runs: overview.runs.map((run) => ({
        ...run,
        prompt: "[REDACTED]",
        output: run.output === null ? null : "[REDACTED]",
        error: redactValue(run.error),
      })),
    };
  });

  app.get("/api/developer/analytics", async (request, reply) => {
    const denied = requireDeveloper(request, reply);
    if (denied) return denied;
    const { userId } = developerAnalyticsQuery.parse(request.query);
    return service.developerAnalytics(userId);
  });

  app.get("/api/developer/agents/:id/runs", async (request, reply) => {
    const denied = requireDeveloper(request, reply);
    if (denied) return denied;
    const { id } = agentIdParams.parse(request.params);
    return {
      runs: service.getRuns(id).map((run) => ({
        ...run,
        prompt: "[REDACTED]",
        output: run.output === null ? null : "[REDACTED]",
        error: redactValue(run.error),
      })),
    };
  });

  app.get("/api/developer/runs/:id/trace", async (request, reply) => {
    const denied = requireDeveloper(request, reply);
    if (denied) return denied;
    const { id } = runIdParams.parse(request.params);
    return {
      traces: service.getTrace(id).map((event) => ({
        ...event,
        summary: redactText(event.summary),
        error: redactValue(event.error),
      })),
    };
  });

  app.get("/api/developer/runs/:id/stream", async (request, reply) => {
    const denied = requireDeveloper(request, reply);
    if (denied) return denied;
    const { id } = runIdParams.parse(request.params);
    service.getRun(id);
    const sanitize = (event: ReturnType<AgentService["getTrace"]>[number]) => ({
      ...event,
      summary: redactText(event.summary),
      error: redactValue(event.error),
    });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });

    let closed = false;
    let snapshotSent = false;
    const sentEventIds = new Set<string>();
    const pending: ReturnType<AgentService["getTrace"]> = [];
    const write = (value: unknown) => {
      if (!closed && !reply.raw.destroyed) {
        reply.raw.write(JSON.stringify(value) + "\n");
      }
    };
    const unsubscribe = service.subscribeToTrace(id, (event) => {
      if (!snapshotSent) {
        pending.push(event);
        return;
      }
      if (sentEventIds.has(event.id)) return;
      sentEventIds.add(event.id);
      write({ type: "trace", event: sanitize(event) });
      if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) {
        closed = true;
        unsubscribe();
        reply.raw.end();
      }
    });
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
    };
    reply.raw.once("close", close);

    const snapshot = service.getTrace(id);
    for (const event of snapshot) sentEventIds.add(event.id);
    write({ type: "snapshot", traces: snapshot.map(sanitize) });
    snapshotSent = true;
    for (const event of pending) {
      if (sentEventIds.has(event.id)) continue;
      sentEventIds.add(event.id);
      write({ type: "trace", event: sanitize(event) });
    }
    if (!["queued", "running"].includes(service.getRun(id).status) && !closed) {
      close();
      reply.raw.end();
    }
    return reply;
  });

  app.get("/api/developer/runs/:id/recovery", async (request, reply) => {
    const denied = requireDeveloper(request, reply);
    if (denied) return denied;
    const { id } = runIdParams.parse(request.params);
    return { recovery: await service.getRunRecovery(id) };
  });

  app.post("/api/developer/runs/:id/recovery/preview", async (request, reply) => {
    const denied = requireDeveloper(request, reply);
    if (denied) return denied;
    const { id } = runIdParams.parse(request.params);
    const body = recoveryPreviewBody.parse(request.body);
    return {
      preview: await service.previewRunRecovery(
        id,
        body.checkpointId,
        body.selection,
        { type: "developer", id: config.recoveryOperatorId },
      ),
    };
  });

  app.post("/api/developer/runs/:id/recovery/restore", async (request, reply) => {
    const denied = requireDeveloper(request, reply);
    if (denied) return denied;
    const recoveryDenied = requireRecoveryOperator(request, reply);
    if (recoveryDenied) return recoveryDenied;
    const { id } = runIdParams.parse(request.params);
    const body = recoveryRestoreBody.parse(request.body);
    const operationKey = idempotencyKey.parse(request.headers["idempotency-key"]);
    return {
      operation: await service.restoreRunRecovery(
        id,
        body.checkpointId,
        body.previewId,
        body.selection,
        operationKey,
        { type: "developer", id: config.recoveryOperatorId },
      ),
    };
  });

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async (request) => ({
    agents: service.listAgents(currentUser(request).id),
  }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body, currentUser(request).id);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id, currentUser(request).id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body, currentUser(request).id) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id, currentUser(request).id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id, currentUser(request).id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id, currentUser(request).id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id, currentUser(request).id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id, currentUser(request).id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content, currentUser(request).id);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id, currentUser(request).id) };
  });

  app.get("/api/runs/:id/recovery", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const user = currentUser(request);
    return { recovery: await service.getRunRecovery(id, user.id) };
  });

  app.post("/api/runs/:id/recovery/preview", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const body = recoveryPreviewBody.parse(request.body);
    const user = currentUser(request);
    return {
      preview: await service.previewRunRecovery(
        id,
        body.checkpointId,
        body.selection,
        { type: "owner", id: user.id },
        user.id,
      ),
    };
  });

  app.post("/api/runs/:id/recovery/restore", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const body = recoveryRestoreBody.parse(request.body);
    const operationKey = idempotencyKey.parse(request.headers["idempotency-key"]);
    const user = currentUser(request);
    return {
      operation: await service.restoreRunRecovery(
        id,
        body.checkpointId,
        body.previewId,
        body.selection,
        operationKey,
        { type: "owner", id: user.id },
        user.id,
      ),
    };
  });

  app.get("/api/runs/:id/trace", async (request, reply) => {
    const header = request.headers["x-trace-viewer-token"];
    const candidate = typeof header === "string" ? header : "";
    if (!tokenMatches(config.traceViewerToken, candidate)) {
      return reply.code(403).send({ error: "Developer Trace access required" });
    }
    const { id } = runIdParams.parse(request.params);
    return {
      traces: service.getTrace(id).map((event) => ({
        ...event,
        summary: redactText(event.summary),
        error: redactValue(event.error),
      })),
    };
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error({ error: redactText(appError.message) }, "request failed");
    }
    return reply.code(statusCode).send({
      error: redactText(appError.message),
      ...(error instanceof HttpError && error.payload ? error.payload : {}),
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
