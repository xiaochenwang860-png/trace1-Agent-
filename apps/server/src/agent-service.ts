import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { createTextRedactor, redactNullable, type TextRedactor } from "./redaction.js";
import { JsonStore } from "./store.js";
import { TraceJournal } from "./trace-journal.js";
import type {
  Agent,
  AgentRun,
  DeveloperAnalytics,
  DeveloperAgentMetric,
  AgentRunner,
  CreateAgentInput,
  Database,
  DeveloperUserSummary,
  Message,
  RunnerTraceEvent,
  TraceEvent,
  UpdateAgentInput,
  User,
} from "./types.js";
import {
  diffWorkspaceSnapshots,
  WorkspaceManager,
  type WorkspaceSnapshot,
} from "./workspace.js";

const now = () => new Date().toISOString();
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1_000;

function normalizedLoginName(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function derivePasswordHash(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString("hex"));
    });
  });
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function secureTextMatch(expected: string, candidate: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  return (
    expectedBuffer.length === candidateBuffer.length &&
    timingSafeEqual(expectedBuffer, candidateBuffer)
  );
}

type TraceEventInput = Omit<
  TraceEvent,
  "id" | "traceId" | "spanId" | "parentSpanId" | "sequence" | "timestamp"
> & {
  timestamp?: string | undefined;
};

const runtimeChildEventTypes = new Set<TraceEvent["type"]>([
  "attempt.started",
  "attempt.completed",
  "attempt.failed",
  "retry.scheduled",
  "model.requested",
  "model.completed",
  "model.failed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "file.changed",
]);

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly liveTraces = new Map<string, TraceEvent[]>();
  private readonly traceSequences = new Map<string, number>();
  private readonly traceSubscribers = new Map<
    string,
    Set<(event: TraceEvent) => void>
  >();
  private readonly redactText: TextRedactor;
  private readonly traceJournal: TraceJournal;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {
    this.redactText = createTextRedactor(config);
    this.traceJournal = new TraceJournal(
      path.join(config.dataDirectory, "trace-journal"),
    );
  }

  async initialize(): Promise<void> {
    const defaultAccount = this.config.userAccounts.find((account) => account.token.length > 0);
    const defaultUser: User | undefined = defaultAccount
      ? {
          id: defaultAccount.id,
          name: defaultAccount.name,
          createdAt: now(),
        }
      : undefined;
    await this.store.initialize(defaultUser);
    await this.traceJournal.initialize();
    const recoveredTraces = await this.traceJournal.recover();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const events of recoveredTraces.values()) {
        this.addRunnerTraces(database, events);
      }
      this.traceSequences.clear();
      for (const trace of database.traces) {
        this.traceSequences.set(
          trace.runId,
          Math.max(this.traceSequences.get(trace.runId) ?? 0, trace.sequence),
        );
      }
      this.redactPersistedText(database);
      for (const account of this.config.userAccounts) {
        if (!account.token) continue;
        const existing = database.users.find((user) => user.id === account.id);
        if (existing) {
          existing.name = account.name;
        } else {
          database.users.push({ id: account.id, name: account.name, createdAt: now() });
        }
      }
      database.authSessions = database.authSessions.filter(
        (session) => Date.parse(session.expiresAt) > Date.now(),
      );
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          const completedAt = now();
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = completedAt;
          this.addTrace(database, {
            runId: run.id,
            agentId: run.agentId,
            type: "run.cancelled",
            status: "info",
            durationMs: run.startedAt
              ? Date.parse(completedAt) - Date.parse(run.startedAt)
              : null,
            summary: "Run cancelled because the server restarted",
            error: null,
          });
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
    await Promise.all(
      [...recoveredTraces.keys()].map((runId) =>
        this.traceJournal.complete(runId).catch((error: unknown) => {
          console.error("Failed to clean recovered Trace journal", error);
        }),
      ),
    );
    await Promise.all(
      this.store
        .snapshot()
        .agents.map((agent) => this.workspaces.writeInstructions(agent).catch(() => undefined)),
    );
  }

  async registerUser(name: string, password: string): Promise<{ user: User; token: string }> {
    const displayName = name.trim().normalize("NFKC");
    const loginName = normalizedLoginName(displayName);
    const timestamp = now();
    const user: User = { id: randomUUID(), name: displayName, createdAt: timestamp };
    const passwordSalt = randomBytes(16).toString("hex");
    const passwordHash = await derivePasswordHash(password, passwordSalt);

    await this.store.mutate((database) => {
      const nameTaken = database.users.some(
        (candidate) => normalizedLoginName(candidate.name) === loginName,
      );
      if (nameTaken || database.credentials.some((credential) => credential.loginName === loginName)) {
        throw new HttpError(409, "That username is already registered");
      }
      database.users.push(user);
      database.credentials.push({
        userId: user.id,
        loginName,
        passwordSalt,
        passwordHash,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    });

    return { user, token: await this.issueSession(user.id) };
  }

  async loginUser(name: string, password: string): Promise<{ user: User; token: string }> {
    const database = this.store.snapshot();
    const credential = database.credentials.find(
      (candidate) => candidate.loginName === normalizedLoginName(name),
    );
    if (!credential) throw new HttpError(401, "Username or password is incorrect");
    const candidateHash = await derivePasswordHash(password, credential.passwordSalt);
    if (!secureTextMatch(credential.passwordHash, candidateHash)) {
      throw new HttpError(401, "Username or password is incorrect");
    }
    const user = database.users.find((candidate) => candidate.id === credential.userId);
    if (!user) throw new HttpError(401, "Username or password is incorrect");
    return { user, token: await this.issueSession(user.id) };
  }

  authenticateSession(token: string): User | null {
    if (!token) return null;
    const database = this.store.snapshot();
    const tokenHash = hashSessionToken(token);
    const session = database.authSessions.find(
      (candidate) =>
        Date.parse(candidate.expiresAt) > Date.now() &&
        secureTextMatch(candidate.tokenHash, tokenHash),
    );
    return session
      ? (database.users.find((user) => user.id === session.userId) ?? null)
      : null;
  }

  async revokeSession(token: string): Promise<void> {
    if (!token) return;
    const tokenHash = hashSessionToken(token);
    await this.store.mutate((database) => {
      database.authSessions = database.authSessions.filter(
        (session) => !secureTextMatch(session.tokenHash, tokenHash),
      );
    });
  }

  private async issueSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const timestamp = new Date();
    await this.store.mutate((database) => {
      database.authSessions = database.authSessions.filter(
        (session) => Date.parse(session.expiresAt) > timestamp.getTime(),
      );
      database.authSessions.push({
        id: randomUUID(),
        userId,
        tokenHash: hashSessionToken(token),
        createdAt: timestamp.toISOString(),
        expiresAt: new Date(timestamp.getTime() + sessionLifetimeMs).toISOString(),
      });
    });
    return token;
  }

  listAgents(ownerUserId?: string): Agent[] {
    return this.store
      .snapshot()
      .agents.filter((agent) => !ownerUserId || agent.ownerUserId === ownerUserId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string, ownerUserId?: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent || (ownerUserId && agent.ownerUserId !== ownerUserId)) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(
    input: CreateAgentInput,
    ownerUserId: string = this.config.userAccounts[0]!.id,
  ): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      ownerUserId,
      name: this.redactText(input.name.trim()),
      description: this.redactText(input.description?.trim() ?? ""),
      instructions: this.redactText(input.instructions?.trim() ?? ""),
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(
    id: string,
    input: UpdateAgentInput,
    ownerUserId?: string,
  ): Promise<Agent> {
    const current = this.getAgent(id, ownerUserId);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent || (ownerUserId && agent.ownerUserId !== ownerUserId)) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = this.redactText(input.name.trim());
      if (input.description !== undefined) agent.description = this.redactText(input.description.trim());
      if (input.instructions !== undefined) agent.instructions = this.redactText(input.instructions.trim());
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(
    id: string,
    ownerUserId?: string,
  ): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id, ownerUserId);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      database.traces = database.traces.filter((event) => event.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string, ownerUserId?: string): Promise<Agent> {
    this.getAgent(id, ownerUserId);
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string, ownerUserId?: string): Promise<Agent> {
    this.getAgent(id, ownerUserId);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string, ownerUserId?: string): Message[] {
    this.getAgent(agentId, ownerUserId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string, ownerUserId?: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    this.getAgent(run.agentId, ownerUserId);
    return run;
  }

  getRuns(agentId: string, ownerUserId?: string): AgentRun[] {
    this.getAgent(agentId, ownerUserId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getTrace(runId: string, ownerUserId?: string): TraceEvent[] {
    this.getRun(runId, ownerUserId);
    const persisted = this.store
      .snapshot()
      .traces.filter((event) => event.runId === runId)
    const byId = new Map(
      [...persisted, ...(this.liveTraces.get(runId) ?? [])].map((event) => [
        event.id,
        event,
      ]),
    );
    return [...byId.values()].sort((left, right) =>
      left.sequence - right.sequence || left.timestamp.localeCompare(right.timestamp),
    );
  }

  subscribeToTrace(
    runId: string,
    subscriber: (event: TraceEvent) => void,
  ): () => void {
    this.getRun(runId);
    const subscribers = this.traceSubscribers.get(runId) ?? new Set();
    subscribers.add(subscriber);
    this.traceSubscribers.set(runId, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.traceSubscribers.delete(runId);
    };
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    ownerUserId?: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    this.getAgent(agentId, ownerUserId);
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const safePrompt = this.redactText(prompt);
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt: safePrompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: safePrompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      this.addTrace(database, {
        runId: run.id,
        agentId,
        type: "run.started",
        status: "info",
        durationMs: null,
        summary: "Task accepted and queued",
        error: null,
      });
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  developerOverview(): {
    users: DeveloperUserSummary[];
    agents: Agent[];
    runs: AgentRun[];
  } {
    const database = this.store.snapshot();
    const users = database.users
      .map((user) => {
        const userAgents = database.agents.filter(
          (agent) => agent.ownerUserId === user.id,
        );
        const agentIds = new Set(userAgents.map((agent) => agent.id));
        const runs = database.runs.filter((run) => agentIds.has(run.agentId));
        const activityTimes = [
          ...userAgents.map((agent) => agent.updatedAt),
          ...runs.map((run) => run.completedAt ?? run.startedAt ?? run.createdAt),
        ];
        return {
          ...user,
          agentCount: userAgents.length,
          runCount: runs.length,
          failedRunCount: runs.filter((run) => run.status === "failed").length,
          lastActivityAt: activityTimes.sort().at(-1) ?? null,
        } satisfies DeveloperUserSummary;
      })
      .sort((left, right) =>
        (right.lastActivityAt ?? right.createdAt).localeCompare(
          left.lastActivityAt ?? left.createdAt,
        ),
      );
    return {
      users,
      agents: database.agents.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
      runs: database.runs.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      ),
    };
  }

  developerAnalytics(ownerUserId: string): DeveloperAnalytics {
    const database = this.store.snapshot();
    const agents = database.agents.filter((agent) => agent.ownerUserId === ownerUserId);
    const agentIds = new Set(agents.map((agent) => agent.id));
    const runs = database.runs.filter((run) => agentIds.has(run.agentId));
    const durationOf = (run: AgentRun): number | null => {
      if (!run.startedAt || !run.completedAt) return null;
      const duration = Date.parse(run.completedAt) - Date.parse(run.startedAt);
      return Number.isFinite(duration) && duration >= 0 ? duration : null;
    };
    const averageDuration = (items: AgentRun[]): number | null => {
      const durations = items.map(durationOf).filter((value): value is number => value !== null);
      if (durations.length === 0) return null;
      return Math.round(durations.reduce((total, value) => total + value, 0) / durations.length);
    };
    const sumUsage = (items: AgentRun[]) =>
      items.reduce(
        (usage, run) => ({
          inputTokens: usage.inputTokens + (run.usage?.inputTokens ?? 0),
          cachedInputTokens: usage.cachedInputTokens + (run.usage?.cachedInputTokens ?? 0),
          outputTokens: usage.outputTokens + (run.usage?.outputTokens ?? 0),
        }),
        { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      );
    const completedRunCount = runs.filter((run) => run.status === "completed").length;
    const failedRunCount = runs.filter((run) => run.status === "failed").length;
    const settledRunCount = runs.filter((run) =>
      ["completed", "failed", "cancelled"].includes(run.status),
    ).length;
    const agentsWithMetrics: DeveloperAgentMetric[] = agents
      .map((agent) => {
        const agentRuns = runs.filter((run) => run.agentId === agent.id);
        const usage = sumUsage(agentRuns);
        return {
          agentId: agent.id,
          agentName: agent.name,
          runCount: agentRuns.length,
          completedRunCount: agentRuns.filter((run) => run.status === "completed").length,
          failedRunCount: agentRuns.filter((run) => run.status === "failed").length,
          averageDurationMs: averageDuration(agentRuns),
          ...usage,
          lastRunAt:
            agentRuns
              .map((run) => run.completedAt ?? run.startedAt ?? run.createdAt)
              .sort()
              .at(-1) ?? null,
        };
      })
      .sort((left, right) => right.runCount - left.runCount || left.agentName.localeCompare(right.agentName));
    const usage = sumUsage(runs);
    return {
      userId: ownerUserId,
      totalRuns: runs.length,
      completedRunCount,
      failedRunCount,
      successRate: settledRunCount === 0 ? null : completedRunCount / settledRunCount,
      averageDurationMs: averageDuration(runs),
      ...usage,
      agents: agentsWithMetrics,
    };
  }
  private createTrace(
    event: TraceEventInput,
    parentSpanId: string | null,
    spanId: string = randomUUID(),
  ): TraceEvent {
    const { timestamp = now(), ...details } = event;
    const id = randomUUID();
    return {
      id,
      traceId: event.runId,
      spanId,
      parentSpanId,
      sequence: this.nextTraceSequence(event.runId),
      timestamp,
      ...details,
      summary: this.redactText(details.summary),
      error: redactNullable(this.redactText, details.error),
      ...(details.errorCode
        ? { errorCode: this.redactText(details.errorCode).slice(0, 64) }
        : {}),
    };
  }

  private nextTraceSequence(runId: string): number {
    const sequence = (this.traceSequences.get(runId) ?? 0) + 1;
    this.traceSequences.set(runId, sequence);
    return sequence;
  }

  private addTrace(database: Database, event: TraceEventInput): TraceEvent {
    const rootSpan = database.traces.find(
      (candidate) => candidate.runId === event.runId && candidate.type === "run.started",
    );
    const runtimeSpan = database.traces.find(
      (candidate) =>
        candidate.runId === event.runId && candidate.type === "runtime.started",
    );
    const parentSpanId =
      event.type === "run.started"
        ? null
        : runtimeChildEventTypes.has(event.type)
          ? (runtimeSpan?.spanId ?? rootSpan?.spanId ?? null)
          : (rootSpan?.spanId ?? null);
    const trace = this.createTrace(event, parentSpanId);
    database.traces.push(trace);
    return trace;
  }

  private redactPersistedText(database: Database): void {
    for (const agent of database.agents) {
      agent.name = this.redactText(agent.name);
      agent.description = this.redactText(agent.description);
      agent.instructions = this.redactText(agent.instructions);
      agent.lastError = redactNullable(this.redactText, agent.lastError);
    }
    for (const message of database.messages) {
      message.content = this.redactText(message.content);
    }
    for (const run of database.runs) {
      run.prompt = this.redactText(run.prompt);
      run.output = redactNullable(this.redactText, run.output);
      run.error = redactNullable(this.redactText, run.error);
    }
    for (const trace of database.traces) {
      trace.summary = this.redactText(trace.summary);
      trace.error = redactNullable(this.redactText, trace.error);
    }
  }

  private addRunnerTraces(
    database: Database,
    events: TraceEvent[],
  ): void {
    for (const event of events) {
      if (!database.traces.some((candidate) => candidate.id === event.id)) {
        database.traces.push(event);
      }
    }
  }

  private captureRunnerTrace(
    runId: string,
    agentId: string,
    parentSpanId: string | null,
    event: RunnerTraceEvent,
    events: TraceEvent[],
  ): void {
    const { operationId, parentOperationId, ...details } = event;
    const trace = this.createTrace(
      { runId, agentId, ...details },
      parentOperationId ?? parentSpanId,
      operationId,
    );
    events.push(trace);
    const live = this.liveTraces.get(runId) ?? [];
    live.push(trace);
    this.liveTraces.set(runId, live);
    void this.traceJournal.append(trace).catch((error: unknown) => {
      console.error("Failed to append Trace journal", error);
    });
    this.notifyTrace(trace);
  }

  private notifyTrace(event: TraceEvent): void {
    for (const subscriber of this.traceSubscribers.get(event.runId) ?? []) {
      try {
        subscriber(event);
      } catch {
        // A disconnected observer must never change the Agent run outcome.
      }
    }
  }

  private async appendWorkspaceTraces(
    workspacePath: string,
    before: WorkspaceSnapshot | null,
    runId: string,
    agentId: string,
    parentSpanId: string | null,
    events: TraceEvent[],
  ): Promise<void> {
    if (!before) return;
    try {
      const after = await this.workspaces.snapshot(workspacePath);
      for (const change of diffWorkspaceSnapshots(before, after)) {
        const containerPath = "/workspace/" + change.path;
        const alreadyReported = events.some(
          (event) => event.type === "file.changed" && event.summary.includes(containerPath),
        );
        if (alreadyReported) continue;
        this.captureRunnerTrace(runId, agentId, parentSpanId, {
          type: "file.changed",
          status: "success",
          timestamp: new Date(change.timestampMs).toISOString(),
          durationMs: null,
          summary: "Workspace file " + change.kind + ": " + containerPath,
          error: null,
        }, events);
      }
    } catch {
      // Observability must not change the outcome of the Agent run.
    }
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    const startedAt = now();
    const runnerTraces: TraceEvent[] = [];
    let runtimeSpanId: string | null = null;
    let runtimeTrace: TraceEvent | null = null;
    let workspaceBefore: WorkspaceSnapshot | null = null;
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = startedAt;
        runtimeTrace = this.addTrace(database, {
          runId: run.id,
          agentId: agentAtStart.id,
          type: "runtime.started",
          status: "info",
          durationMs: null,
          summary: "Agent Runtime execution started",
          error: null,
        });
        runtimeSpanId = runtimeTrace.spanId;
      }
    });
    if (runtimeTrace) this.notifyTrace(runtimeTrace);
    try {
      workspaceBefore = await this.workspaces.snapshot(agentAtStart.workspacePath);
    } catch {
      workspaceBefore = null;
    }
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        onTrace: (event) =>
          this.captureRunnerTrace(
            run.id,
            agentAtStart.id,
            runtimeSpanId,
            event,
            runnerTraces,
          ),
      });
      await this.appendWorkspaceTraces(
        agentAtStart.workspacePath,
        workspaceBefore,
        run.id,
        agentAtStart.id,
        runtimeSpanId,
        runnerTraces,
      );
      const completedAt = now();
      let completedTrace: TraceEvent | null = null;
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = this.redactText(result.output);
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        this.addRunnerTraces(database, runnerTraces);
        completedTrace = this.addTrace(database, {
          runId: run.id,
          agentId: agent.id,
          type: "run.completed",
          status: "success",
          durationMs: Date.parse(completedAt) - Date.parse(startedAt),
          summary: "Agent Runtime execution completed",
          error: null,
        });
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: this.redactText(result.output),
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
      this.liveTraces.delete(run.id);
      if (completedTrace) this.notifyTrace(completedTrace);
      await this.traceJournal.complete(run.id).catch((error: unknown) => {
        console.error("Failed to clean completed Trace journal", error);
      });
    } catch (error) {
      await this.appendWorkspaceTraces(
        agentAtStart.workspacePath,
        workspaceBefore,
        run.id,
        agentAtStart.id,
        runtimeSpanId,
        runnerTraces,
      );
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = this.redactText(error instanceof Error ? error.message : String(error));
      let completedTrace: TraceEvent | null = null;
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
          this.addRunnerTraces(database, runnerTraces);
          completedTrace = this.addTrace(database, {
            runId: run.id,
            agentId: agentAtStart.id,
            type: cancelled ? "run.cancelled" : "run.failed",
            status: cancelled ? "info" : "error",
            durationMs: Date.parse(completedAt) - Date.parse(startedAt),
            summary: cancelled
              ? "Agent Runtime execution cancelled"
              : "Agent Runtime execution failed",
            error: cancelled ? null : message,
          });
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
      this.liveTraces.delete(run.id);
      if (completedTrace) this.notifyTrace(completedTrace);
      await this.traceJournal.complete(run.id).catch((journalError: unknown) => {
        console.error("Failed to clean completed Trace journal", journalError);
      });
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
