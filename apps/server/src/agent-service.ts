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
import { AttemptTrace } from "./attempt-trace.js";
import { createTextRedactor, redactNullable, type TextRedactor } from "./redaction.js";
import {
  diffSnapshots,
  RecoveryStore,
  RecoveryStoreError,
  WorkspaceChangedError,
  type RecoverySnapshot,
  type RecoverySnapshotChange,
  type RecoverySnapshotEntry,
  type RestoreResult,
  type RecoverySnapshotLocator,
  type WorkspaceRecoveryLocation,
} from "./recovery-store.js";
import { JsonStore } from "./store.js";
import { TraceJournal } from "./trace-journal.js";
import { isGitWorkspaceRecoveryCheckpoint } from "./types.js";
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
  RecoveryFile,
  RecoveryPreview,
  RecoverySelection,
  RecoverySummary,
  RestoreConflict,
  RestoreOperation,
  RunRecovery,
  RunnerTraceEvent,
  TraceEvent,
  UpdateAgentInput,
  User,
  GitWorkspaceRecoveryCheckpoint,
  WorkspaceRecoveryCheckpoint,
} from "./types.js";
import {
  diffWorkspaceSnapshots,
  WorkspaceManager,
  type WorkspaceSnapshot,
} from "./workspace.js";

const now = () => new Date().toISOString();
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
const recoveryPreviewLifetimeMs = 5 * 60 * 1_000;

function classifyAttemptFailure(error: unknown): {
  errorCode: string;
  retryable: boolean;
} {
  if (error instanceof RunCancelledError) {
    return { errorCode: "CANCELLED", retryable: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) {
    return { errorCode: "TIMEOUT", retryable: true };
  }
  if (/rate limit|429/i.test(message)) {
    return { errorCode: "RATE_LIMIT", retryable: true };
  }
  if (/network|socket|connect|fetch/i.test(message)) {
    return { errorCode: "NETWORK", retryable: true };
  }
  if (/auth|unauthori[sz]ed|forbidden|api key/i.test(message)) {
    return { errorCode: "AUTH", retryable: false };
  }
  if (/validat/i.test(message)) {
    return { errorCode: "VALIDATION", retryable: false };
  }
  return { errorCode: "RUNTIME_ERROR", retryable: false };
}

function recoveryLocation(agent: Agent): WorkspaceRecoveryLocation {
  return {
    repositoryId: agent.id,
    workspacePath: agent.workspacePath,
  };
}

function runRecoveryRef(runId: string, phase: "before" | "after"): string {
  return `refs/launchpad/runs/${runId}/${phase}`;
}

function recoverySnapshotLocator(
  checkpoint: GitWorkspaceRecoveryCheckpoint,
): RecoverySnapshotLocator {
  return {
    repositoryId: checkpoint.repositoryId,
    commitOid: checkpoint.commitOid,
    rootHash: checkpoint.rootHash,
    workspaceTreeOid: checkpoint.workspaceTreeOid,
    manifestBlobOid: checkpoint.manifestBlobOid,
  };
}

export interface RecoveryActor {
  type: "owner" | "developer";
  id: string | null;
}

interface StoredRecoveryPreview {
  preview: RecoveryPreview;
  runId: string;
  agentId: string;
  actorKey: string;
  selection: RecoverySelection;
  selectedPaths: string[];
  resultingRootHash: string;
}

interface IdempotentRestore {
  fingerprint: string;
  operation: Promise<RestoreOperation>;
}

interface RecoveryContext {
  run: AgentRun;
  agent: Agent;
  before: RecoverySnapshot;
  after: RecoverySnapshot | null;
  files: RecoveryFile[];
}

function checkpointFromSnapshot(
  snapshot: RecoverySnapshot,
  capturedAt: string,
): WorkspaceRecoveryCheckpoint {
  if (
    snapshot.storage !== "git-sha256-v1" ||
    !snapshot.repositoryId ||
    !snapshot.commitOid ||
    !snapshot.workspaceTreeOid ||
    !snapshot.manifestBlobOid
  ) {
    throw new RecoveryStoreError(
      "RECOVERY_INTEGRITY_ERROR",
      "Git recovery capture did not return a complete checkpoint locator",
    );
  }
  return {
    storage: "git-sha256-v1",
    repositoryId: snapshot.repositoryId,
    commitOid: snapshot.commitOid,
    workspaceTreeOid: snapshot.workspaceTreeOid,
    manifestBlobOid: snapshot.manifestBlobOid,
    rootHash: snapshot.rootHash,
    policyId: snapshot.policyId,
    fileCount: snapshot.fileCount,
    totalBytes: snapshot.totalBytes,
    capturedAt,
  };
}

function entryHash(entry: RecoverySnapshotEntry | null): string | null {
  return entry?.kind === "file" ? (entry.blobHash ?? null) : null;
}

function entrySize(entry: RecoverySnapshotEntry | null): number | null {
  return entry?.kind === "file" ? (entry.size ?? null) : null;
}

function sameRecoveryEntry(
  left: RecoverySnapshotEntry | undefined,
  right: RecoverySnapshotEntry | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.kind === right.kind &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.blobHash === right.blobHash
  );
}

function toRecoveryFile(change: RecoverySnapshotChange): RecoveryFile {
  const kind = change.kind === "type-changed" ? "modified" : change.kind;
  const target = change.before;
  return {
    path: change.path,
    kind,
    beforeHash: entryHash(change.before),
    afterHash: entryHash(change.after),
    sizeBefore: entrySize(change.before),
    sizeAfter: entrySize(change.after),
    restorable:
      target === null || target.kind === "directory" || typeof target.blobHash === "string",
  };
}

function summarizeRecovery(files: RecoveryFile[]): RecoverySummary {
  return {
    created: files.filter((file) => file.kind === "created").length,
    modified: files.filter((file) => file.kind === "modified").length,
    deleted: files.filter((file) => file.kind === "deleted").length,
    total: files.length,
  };
}

function actorKey(actor: RecoveryActor): string {
  return actor.type + ":" + (actor.id ?? "operator");
}

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

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
  operationId?: string | undefined;
  parentOperationId?: string | undefined;
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
  "workspace.checkpoint.created",
  "workspace.diff.generated",
  "workspace.restore.started",
  "workspace.restore.completed",
  "workspace.restore.blocked",
  "workspace.restore.failed",
]);

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly recoveryPreviews = new Map<string, StoredRecoveryPreview>();
  private readonly idempotentRestores = new Map<string, IdempotentRestore>();
  private readonly liveTraces = new Map<string, TraceEvent[]>();
  private readonly traceSequences = new Map<string, number>();
  private readonly traceSubscribers = new Map<string, Set<(event: TraceEvent) => void>>();
  private readonly redactText: TextRedactor;
  private readonly traceJournal: TraceJournal;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly recoveryStore: RecoveryStore,
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
    await this.recoveryStore.initialize();
    const pendingRestoreOutcomes = new Map<
      string,
      "committed" | "rolled_back" | "ambiguous"
    >();
    const pendingSafetySnapshots = new Map<string, string>();
    const interruptedRecovery = new Map<
      string,
      {
        checkpoint: WorkspaceRecoveryCheckpoint | null;
        captureError: string | null;
        changeCount: number | null;
      }
    >();
    const startupDatabase = this.store.snapshot();
    await Promise.all(
      startupDatabase.runs.flatMap((run) =>
        run.recovery.pendingRestores.map(async (intent) => {
          const agent = startupDatabase.agents.find(
            (candidate) => candidate.id === run.agentId,
          );
          if (!agent) {
            pendingRestoreOutcomes.set(intent.id, "ambiguous");
            return;
          }
          try {
            const current = await this.recoveryStore.inspect(recoveryLocation(agent));
            const outcome =
              current.rootHash === intent.resultingRootHash
                ? "committed"
                : current.rootHash === intent.expectedRootHash
                  ? "rolled_back"
                  : "ambiguous";
            pendingRestoreOutcomes.set(intent.id, outcome);
            if (outcome === "committed") {
              const safetySnapshotId =
                await this.recoveryStore.resolveSafetySnapshotId(
                  agent.id,
                  intent.id,
                  intent.expectedRootHash,
                );
              if (safetySnapshotId) {
                pendingSafetySnapshots.set(intent.id, safetySnapshotId);
              }
            }
          } catch {
            pendingRestoreOutcomes.set(intent.id, "ambiguous");
          }
        }),
      ),
    );
    await Promise.all(
      startupDatabase.runs
        .filter((run) => run.status === "queued" || run.status === "running")
        .map(async (run) => {
          const agent = startupDatabase.agents.find((candidate) => candidate.id === run.agentId);
          if (!agent || !isGitWorkspaceRecoveryCheckpoint(run.recovery.before)) {
            interruptedRecovery.set(run.id, {
              checkpoint: null,
              captureError:
                run.recovery.before?.storage === "legacy-unavailable-v1"
                  ? run.recovery.before.unavailableReason
                  : "Server restarted before a complete Git recovery checkpoint was available",
              changeCount: null,
            });
            return;
          }
          try {
            const [before, after] = await Promise.all([
              this.recoveryStore.load(
                recoverySnapshotLocator(run.recovery.before),
              ),
              this.recoveryStore.capture(recoveryLocation(agent), {
                refName: runRecoveryRef(run.id, "after"),
              }),
            ]);
            interruptedRecovery.set(run.id, {
              checkpoint: checkpointFromSnapshot(after, now()),
              captureError: null,
              changeCount: diffSnapshots(before, after).length,
            });
          } catch (error) {
            interruptedRecovery.set(run.id, {
              checkpoint: null,
              captureError: this.redactText(
                error instanceof Error ? error.message : String(error),
              ),
              changeCount: null,
            });
          }
        }),
    );
    await this.store.mutate((database) => {
      for (const events of recoveredTraces.values()) {
        this.addRecoveredTraces(database, events);
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
        const agent = database.agents.find((candidate) => candidate.id === run.agentId);
        const stillPending = [];
        for (const intent of run.recovery.pendingRestores) {
          const outcome = pendingRestoreOutcomes.get(intent.id) ?? "ambiguous";
          if (outcome === "ambiguous") {
            stillPending.push(intent);
            if (agent) {
              agent.status = "error";
              agent.lastError =
                "An interrupted workspace restore requires manual reconciliation";
              agent.updatedAt = now();
            }
            continue;
          }
          const completedAt = now();
          if (outcome === "committed") {
            if (!run.recovery.restores.some((audit) => audit.id === intent.id)) {
              run.recovery.restores.push({
                id: intent.id,
                idempotencyKeyHash: intent.idempotencyKeyHash,
                checkpointId: intent.checkpointId,
                actorType: intent.actorType,
                actorId: intent.actorId,
                mode: intent.mode,
                selectedPaths: intent.selectedPaths,
                restoredPaths: intent.restoredPaths,
                previousRootHash: intent.expectedRootHash,
                restoredRootHash: intent.resultingRootHash,
                safetySnapshotId:
                  pendingSafetySnapshots.get(intent.id) ?? intent.expectedRootHash,
                quarantinePath: "[reconciled managed quarantine]",
                completedAt,
              });
              this.addTrace(database, {
                runId: run.id,
                agentId: run.agentId,
                type: "workspace.restore.completed",
                status: "success",
                durationMs: Date.parse(completedAt) - Date.parse(intent.startedAt),
                summary:
                  "Workspace restore reconciled after restart for " +
                  intent.restoredPaths.length +
                  " paths",
                error: null,
              });
            }
            if (agent) {
              agent.status = agent.status === "stopped" ? "stopped" : "ready";
              agent.codexThreadId = null;
              agent.lastError = null;
              agent.updatedAt = completedAt;
            }
          } else {
            this.addTrace(database, {
              runId: run.id,
              agentId: run.agentId,
              type: "workspace.restore.blocked",
              status: "error",
              durationMs: Date.parse(completedAt) - Date.parse(intent.startedAt),
              summary: "Interrupted workspace restore was rolled back during restart",
              error: "The original workspace remained active",
            });
            if (agent) {
              agent.status = agent.status === "stopped" ? "stopped" : "ready";
              agent.lastError = null;
              agent.updatedAt = completedAt;
            }
          }
        }
        run.recovery.pendingRestores = stillPending;
      }
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          const completedAt = now();
          const recovered = interruptedRecovery.get(run.id);
          if (recovered) {
            run.recovery.after = recovered.checkpoint;
            run.recovery.captureError = recovered.captureError;
            if (recovered.changeCount !== null) {
              this.addTrace(database, {
                runId: run.id,
                agentId: run.agentId,
                type: "workspace.diff.generated",
                status: "success",
                durationMs: null,
                summary:
                  "Recovered interrupted-run diff with " +
                  recovered.changeCount +
                  " changed paths",
                error: null,
              });
            }
          }
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
          const hasUnresolvedRestore = database.runs.some(
            (run) =>
              run.agentId === agent.id && run.recovery.pendingRestores.length > 0,
          );
          agent.status = hasUnresolvedRestore ? "error" : "ready";
          if (hasUnresolvedRestore) {
            agent.lastError =
              "An interrupted workspace restore requires manual reconciliation";
          }
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
      .traces.filter((event) => event.runId === runId);
    const byId = new Map(
      [...persisted, ...(this.liveTraces.get(runId) ?? [])].map((event) => [
        event.id,
        event,
      ]),
    );
    return [...byId.values()].sort(
      (left, right) =>
        left.sequence - right.sequence ||
        left.timestamp.localeCompare(right.timestamp),
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

  async getRunRecovery(runId: string, ownerUserId?: string): Promise<RunRecovery> {
    const context = await this.loadRecoveryContext(runId, ownerUserId);
    const latestRestore = context.run.recovery.restores
      .slice()
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
    const hasPendingRestore = this.store
      .snapshot()
      .runs.some(
        (run) =>
          run.agentId === context.agent.id &&
          run.recovery.pendingRestores.length > 0,
      );
    let currentStateHash =
      latestRestore?.restoredRootHash ??
      context.after?.rootHash ??
      context.before.rootHash;
    let status: RunRecovery["status"] =
      context.run.recovery.captureError || !context.after ? "blocked" : "available";
    if (
      context.agent.status === "busy" ||
      hasPendingRestore
    ) {
      status = "blocked";
    } else {
      try {
        currentStateHash = (
          await this.recoveryStore.inspect(recoveryLocation(context.agent))
        ).rootHash;
      } catch {
        status = "blocked";
      }
    }
    if (latestRestore && status !== "blocked") status = "restored";
    return {
      runId: context.run.id,
      checkpointId:
        context.run.recovery.before?.storage === "git-sha256-v1"
          ? context.run.recovery.before.commitOid
          : context.before.rootHash,
      status,
      capturedAt: context.run.recovery.before?.capturedAt ?? context.run.createdAt,
      beforeStateHash: context.before.rootHash,
      afterStateHash: context.after?.rootHash ?? "",
      currentStateHash,
      restoredAt: latestRestore?.completedAt ?? null,
      summary: summarizeRecovery(context.files),
      files: context.files,
    };
  }

  async previewRunRecovery(
    runId: string,
    checkpointId: string,
    selection: RecoverySelection,
    actor: RecoveryActor,
    ownerUserId?: string,
  ): Promise<RecoveryPreview> {
    const context = await this.loadRecoveryContext(runId, ownerUserId);
    this.assertCheckpoint(context, checkpointId);
    const hasPendingRestore = this.store
      .snapshot()
      .runs.some(
        (run) =>
          run.agentId === context.agent.id &&
          run.recovery.pendingRestores.length > 0,
      );
    if (hasPendingRestore) {
      throw new HttpError(
        409,
        "An interrupted restore must be reconciled before creating a new preview",
      );
    }
    if (context.agent.status === "busy") {
      throw new HttpError(409, "Stop the active run before previewing workspace recovery");
    }
    const selectedPaths = this.resolveRecoverySelection(context.files, selection);
    const current = await this.recoveryStore.inspect(recoveryLocation(context.agent));
    const conflicts = this.recoveryConflicts(context, current, selectedPaths);
    let actions: RecoveryPreview["actions"] = [];
    let resultingRootHash = current.rootHash;
    try {
      const plan = await this.recoveryStore.previewRestore({
        workspacePath: context.agent.workspacePath,
        repositoryId: context.agent.id,
        snapshot: context.before,
        expectedCurrentRootHash: current.rootHash,
        paths: selectedPaths,
      });
      actions = plan.changes.map((change) => ({
        path: change.path,
        action:
          change.kind === "created"
            ? "create"
            : change.kind === "deleted"
              ? "delete"
              : "replace",
      }));
      resultingRootHash = plan.resultingRootHash;
    } catch (error) {
      if (error instanceof WorkspaceChangedError) {
        conflicts.push({
          path: "*",
          code: "changed_since_run",
          expectedHash: error.expectedRootHash,
          actualHash: error.actualRootHash,
          message: "Workspace changed while the restore preview was being prepared",
        });
      } else if (error instanceof RecoveryStoreError) {
        conflicts.push({
          path: "*",
          code: error.code === "RECOVERY_INTEGRITY_ERROR" ? "artifact_missing" : "path_blocked",
          expectedHash: context.before.rootHash,
          actualHash: current.rootHash,
          message: this.redactText(error.message),
        });
      } else {
        throw error;
      }
    }
    const createdAt = Date.now();
    const preview: RecoveryPreview = {
      id: randomUUID(),
      checkpointId,
      expiresAt: new Date(createdAt + recoveryPreviewLifetimeMs).toISOString(),
      observedStateHash: current.rootHash,
      canApply: conflicts.length === 0,
      actions,
      conflicts,
    };
    this.recoveryPreviews.set(preview.id, {
      preview,
      runId,
      agentId: context.agent.id,
      actorKey: actorKey(actor),
      selection: structuredClone(selection),
      selectedPaths,
      resultingRootHash,
    });
    this.deleteExpiredRecoveryPreviews(createdAt);
    return preview;
  }

  async restoreRunRecovery(
    runId: string,
    checkpointId: string,
    previewId: string,
    selection: RecoverySelection,
    idempotencyKey: string,
    actor: RecoveryActor,
    ownerUserId?: string,
  ): Promise<RestoreOperation> {
    const context = await this.loadRecoveryContext(runId, ownerUserId);
    this.assertCheckpoint(context, checkpointId);
    const selectedPaths = this.resolveRecoverySelection(context.files, selection);
    const keyHash = sha256Text(actorKey(actor) + "\0" + idempotencyKey);
    const fingerprint = JSON.stringify({ checkpointId, selectedPaths });
    const priorAudit = context.run.recovery.restores.find(
      (restore) => restore.idempotencyKeyHash === keyHash,
    );
    if (priorAudit) {
      const priorFingerprint = JSON.stringify({
        checkpointId: priorAudit.checkpointId,
        selectedPaths: priorAudit.selectedPaths,
      });
      if (priorFingerprint !== fingerprint) {
        throw new HttpError(409, "Idempotency key was already used for another restore");
      }
      return {
        id: priorAudit.id,
        status: "completed",
        safetySnapshotId: priorAudit.safetySnapshotId,
        restoredPaths: priorAudit.restoredPaths,
        newStateHash: priorAudit.restoredRootHash,
        completedAt: priorAudit.completedAt,
      };
    }
    const pendingAudit = context.run.recovery.pendingRestores.find(
      (restore) => restore.idempotencyKeyHash === keyHash,
    );
    if (pendingAudit) {
      const pendingFingerprint = JSON.stringify({
        checkpointId: pendingAudit.checkpointId,
        selectedPaths: pendingAudit.selectedPaths,
      });
      if (pendingFingerprint !== fingerprint) {
        throw new HttpError(409, "Idempotency key is attached to another restore");
      }
      throw new HttpError(
        409,
        "This restore was interrupted and requires server reconciliation",
      );
    }
    const requestKey = runId + ":" + keyHash;
    const inFlight = this.idempotentRestores.get(requestKey);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        throw new HttpError(409, "Idempotency key is already executing another restore");
      }
      return inFlight.operation;
    }
    const operation = this.performRestore(
      context,
      checkpointId,
      previewId,
      selection,
      selectedPaths,
      keyHash,
      actor,
    );
    this.idempotentRestores.set(requestKey, { fingerprint, operation });
    try {
      return await operation;
    } finally {
      this.idempotentRestores.delete(requestKey);
    }
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
      recovery: {
        before: null,
        after: null,
        captureError: null,
        pendingRestores: [],
        restores: [],
      },
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

  private async loadRecoveryContext(
    runId: string,
    ownerUserId?: string,
  ): Promise<RecoveryContext> {
    const run = this.getRun(runId, ownerUserId);
    const agent = this.getAgent(run.agentId, ownerUserId);
    if (!run.recovery.before) {
      throw new HttpError(404, "This run does not have a recovery checkpoint");
    }
    if (!isGitWorkspaceRecoveryCheckpoint(run.recovery.before)) {
      throw new HttpError(409, run.recovery.before.unavailableReason);
    }
    if (run.recovery.before.repositoryId !== agent.id) {
      throw new HttpError(409, "Recovery checkpoint belongs to a different Agent repository");
    }
    let before: RecoverySnapshot;
    let after: RecoverySnapshot | null = null;
    try {
      before = await this.recoveryStore.load(
        recoverySnapshotLocator(run.recovery.before),
      );
      if (run.recovery.after) {
        if (!isGitWorkspaceRecoveryCheckpoint(run.recovery.after)) {
          throw new Error(run.recovery.after.unavailableReason);
        }
        if (run.recovery.after.repositoryId !== agent.id) {
          throw new Error("Recovery checkpoint belongs to a different Agent repository");
        }
        after = await this.recoveryStore.load(
          recoverySnapshotLocator(run.recovery.after),
        );
      }
    } catch (error) {
      const message = this.redactText(error instanceof Error ? error.message : String(error));
      throw new HttpError(409, "Recovery artifacts are unavailable: " + message);
    }
    const files = after
      ? diffSnapshots(before, after).map(toRecoveryFile)
      : [];
    return { run, agent, before, after, files };
  }

  private assertCheckpoint(context: RecoveryContext, checkpointId: string): void {
    const checkpoint = context.run.recovery.before;
    if (
      !isGitWorkspaceRecoveryCheckpoint(checkpoint) ||
      checkpointId !== checkpoint.commitOid
    ) {
      throw new HttpError(409, "Recovery checkpoint no longer matches this run");
    }
  }

  private resolveRecoverySelection(
    files: RecoveryFile[],
    selection: RecoverySelection,
  ): string[] {
    const available = new Set(files.map((file) => file.path));
    const requested =
      selection.mode === "all"
        ? files.map((file) => file.path)
        : (selection.paths ?? []);
    const selectedPaths = [...new Set(requested)].sort();
    if (selectedPaths.length === 0) {
      throw new HttpError(400, "Select at least one workspace path to restore");
    }
    const invalid = selectedPaths.find((filePath) => !available.has(filePath));
    if (invalid) {
      throw new HttpError(400, "Path is not part of this run's recovery set: " + invalid);
    }
    return selectedPaths;
  }

  private recoveryConflicts(
    context: RecoveryContext,
    current: RecoverySnapshot,
    selectedPaths: string[],
  ): RestoreConflict[] {
    const selected = new Set(selectedPaths);
    const conflicts: RestoreConflict[] = context.files
      .filter((file) => selected.has(file.path) && !file.restorable)
      .map((file) => ({
        path: file.path,
        code: "artifact_missing" as const,
        expectedHash: file.beforeHash,
        actualHash: file.afterHash,
        message: "The checkpoint content needed to restore this path is unavailable",
      }));
    if (!context.after) return conflicts;
    const targetByPath = new Map(context.before.entries.map((entry) => [entry.path, entry]));
    const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]));
    for (const drift of diffSnapshots(context.after, current, selectedPaths)) {
      if (sameRecoveryEntry(targetByPath.get(drift.path), currentByPath.get(drift.path))) {
        continue;
      }
      conflicts.push({
        path: drift.path,
        code: "changed_since_run",
        expectedHash: entryHash(drift.before),
        actualHash: entryHash(drift.after),
        message: "This path changed after the Agent run; restoring it could overwrite newer work",
      });
    }
    return conflicts;
  }

  private deleteExpiredRecoveryPreviews(referenceTime = Date.now()): void {
    for (const [id, stored] of this.recoveryPreviews) {
      if (Date.parse(stored.preview.expiresAt) <= referenceTime) {
        this.recoveryPreviews.delete(id);
      }
    }
  }

  private async performRestore(
    context: RecoveryContext,
    checkpointId: string,
    previewId: string,
    selection: RecoverySelection,
    selectedPaths: string[],
    idempotencyKeyHash: string,
    actor: RecoveryActor,
  ): Promise<RestoreOperation> {
    const storedPreview = this.recoveryPreviews.get(previewId);
    const sameSelection =
      storedPreview &&
      JSON.stringify(storedPreview.selectedPaths) === JSON.stringify(selectedPaths);
    if (
      !storedPreview ||
      storedPreview.runId !== context.run.id ||
      storedPreview.agentId !== context.agent.id ||
      storedPreview.actorKey !== actorKey(actor) ||
      storedPreview.preview.checkpointId !== checkpointId ||
      !sameSelection
    ) {
      throw new HttpError(409, "Recovery preview is missing or does not match this request");
    }
    if (Date.parse(storedPreview.preview.expiresAt) <= Date.now()) {
      this.recoveryPreviews.delete(previewId);
      throw new HttpError(409, "Recovery preview expired; inspect the workspace again");
    }
    if (!storedPreview.preview.canApply) {
      throw new HttpError(409, "Recovery preview contains unresolved conflicts", {
        preview: storedPreview.preview,
      });
    }
    const operationId = randomUUID();
    const restoreStartedAt = now();
    const plannedRestoredPaths = storedPreview.preview.actions.map(
      (action) => action.path,
    );
    const priorStatus = await this.store.mutate((database) => {
      const agent = database.agents.find((candidate) => candidate.id === context.agent.id);
      const run = database.runs.find((candidate) => candidate.id === context.run.id);
      if (!agent || !run) throw new HttpError(404, "Run or Agent not found");
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before restoring this workspace");
      }
      const unresolvedRestore = database.runs.some(
        (candidate) =>
          candidate.agentId === agent.id &&
          candidate.recovery.pendingRestores.length > 0,
      );
      if (unresolvedRestore) {
        throw new HttpError(
          409,
          "This Agent has an interrupted restore that requires reconciliation",
        );
      }
      const status = agent.status;
      run.recovery.pendingRestores.push({
        id: operationId,
        idempotencyKeyHash,
        checkpointId,
        actorType: actor.type,
        actorId: actor.id,
        mode: selection.mode,
        selectedPaths,
        restoredPaths: plannedRestoredPaths,
        expectedRootHash: storedPreview.preview.observedStateHash,
        resultingRootHash: storedPreview.resultingRootHash,
        startedAt: restoreStartedAt,
      });
      agent.status = "busy";
      agent.updatedAt = restoreStartedAt;
      this.addTrace(database, {
        runId: run.id,
        agentId: agent.id,
        type: "workspace.restore.started",
        status: "info",
        durationMs: null,
        summary: "Workspace restore started for " + selectedPaths.length + " selected paths",
        error: null,
      });
      return status;
    });

    const persistCompletedRestore = async (
      result: RestoreResult,
      operation: RestoreOperation,
    ): Promise<void> => {
      await this.store.mutate((database) => {
        const run = database.runs.find((candidate) => candidate.id === context.run.id);
        const agent = database.agents.find((candidate) => candidate.id === context.agent.id);
        if (!run || !agent) throw new HttpError(404, "Run or Agent no longer exists");
        run.recovery.pendingRestores = run.recovery.pendingRestores.filter(
          (intent) => intent.id !== operation.id,
        );
        const alreadyRecorded = run.recovery.restores.some(
          (audit) => audit.id === operation.id,
        );
        if (!alreadyRecorded) {
          run.recovery.restores.push({
            id: operation.id,
            idempotencyKeyHash,
            checkpointId,
            actorType: actor.type,
            actorId: actor.id,
            mode: selection.mode,
            selectedPaths,
            restoredPaths: operation.restoredPaths,
            previousRootHash: result.previousRootHash,
            restoredRootHash: result.restoredRootHash,
            safetySnapshotId: operation.safetySnapshotId,
            quarantinePath: "[managed quarantine]",
            completedAt: operation.completedAt,
          });
          this.addTrace(database, {
            runId: run.id,
            agentId: agent.id,
            type: "workspace.restore.completed",
            status: "success",
            durationMs:
              Date.parse(operation.completedAt) - Date.parse(restoreStartedAt),
            summary:
              "Workspace restore completed for " +
              operation.restoredPaths.length +
              " paths",
            error: null,
          });
        }
        agent.status = priorStatus === "stopped" ? "stopped" : "ready";
        agent.codexThreadId = null;
        agent.lastError = null;
        agent.updatedAt = operation.completedAt;
      });
    };

    const restore = (async (): Promise<RestoreOperation> => {
      let appliedResult: RestoreResult | null = null;
      let completedOperation: RestoreOperation | null = null;
      try {
        appliedResult = await this.recoveryStore.restore({
          workspacePath: context.agent.workspacePath,
          repositoryId: context.agent.id,
          snapshot: context.before,
          expectedCurrentRootHash: storedPreview.preview.observedStateHash,
          operationId,
          paths: selectedPaths,
        });
        const completedAt = now();
        completedOperation = {
          id: appliedResult.operationId,
          status: "completed",
          safetySnapshotId: appliedResult.safetySnapshotId,
          restoredPaths: appliedResult.restoredPaths,
          newStateHash: appliedResult.restoredRootHash,
          completedAt,
        };
        await persistCompletedRestore(appliedResult, completedOperation);
        this.recoveryPreviews.delete(previewId);
        return completedOperation;
      } catch (caught) {
        let error: unknown = caught;
        if (appliedResult && completedOperation) {
          try {
            await persistCompletedRestore(appliedResult, completedOperation);
            this.recoveryPreviews.delete(previewId);
            return completedOperation;
          } catch (retryError) {
            error = retryError;
          }
        }
        let returnedToExpectedState = error instanceof WorkspaceChangedError;
        if (!returnedToExpectedState) {
          try {
            const current = await this.recoveryStore.inspect(
              recoveryLocation(context.agent),
            );
            returnedToExpectedState =
              current.rootHash === storedPreview.preview.observedStateHash;
          } catch {
            // Keep the durable intent when the active workspace cannot be verified.
          }
        }
        await this.store.mutate((database) => {
          const agent = database.agents.find((candidate) => candidate.id === context.agent.id);
          const run = database.runs.find((candidate) => candidate.id === context.run.id);
          if (!agent) return;
          if (run && returnedToExpectedState) {
            run.recovery.pendingRestores = run.recovery.pendingRestores.filter(
              (intent) => intent.id !== operationId,
            );
          }
          agent.status = returnedToExpectedState
            ? priorStatus
            : priorStatus === "stopped"
              ? "stopped"
              : "error";
          agent.updatedAt = now();
          if (run) {
            const blocked = error instanceof RecoveryStoreError;
            const message = this.redactText(
              error instanceof Error ? error.message : String(error),
            );
            this.addTrace(database, {
              runId: run.id,
              agentId: agent.id,
              type: blocked ? "workspace.restore.blocked" : "workspace.restore.failed",
              status: "error",
              durationMs: null,
              summary: blocked ? "Workspace restore blocked" : "Workspace restore failed",
              error: message,
            });
          }
          if (!returnedToExpectedState) {
            agent.lastError =
              "Workspace restore outcome requires restart reconciliation: " +
              this.redactText(error instanceof Error ? error.message : String(error));
          }
        });
        if (error instanceof WorkspaceChangedError) {
          const conflictPreview: RecoveryPreview = {
            ...storedPreview.preview,
            observedStateHash: error.actualRootHash,
            canApply: false,
            actions: [],
            conflicts: [
              {
                path: "*",
                code: "changed_since_run",
                expectedHash: error.expectedRootHash,
                actualHash: error.actualRootHash,
                message: "Workspace changed after preview; create a new preview before restoring",
              },
            ],
          };
          throw new HttpError(409, "Workspace changed after recovery preview", {
            preview: conflictPreview,
          });
        }
        if (error instanceof RecoveryStoreError) {
          throw new HttpError(409, this.redactText(error.message));
        }
        throw error;
      }
    })();
    const completion = restore.then(
      () => undefined,
      () => undefined,
    );
    this.activeExecutions.set(context.agent.id, completion);
    try {
      return await restore;
    } finally {
      if (this.activeExecutions.get(context.agent.id) === completion) {
        this.activeExecutions.delete(context.agent.id);
      }
    }
  }

  private createTrace(
    event: TraceEventInput,
    parentSpanId: string | null,
    spanId: string = randomUUID(),
  ): TraceEvent {
    const {
      timestamp = now(),
      operationId,
      parentOperationId,
      ...details
    } = event;
    return {
      id: randomUUID(),
      traceId: event.runId,
      spanId: operationId ?? spanId,
      parentSpanId: parentOperationId ?? parentSpanId,
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

  private addRecoveredTraces(database: Database, events: TraceEvent[]): void {
    for (const event of events) {
      if (!database.traces.some((candidate) => candidate.id === event.id)) {
        database.traces.push(event);
      }
    }
  }

  private addRunnerTraces(database: Database, events: TraceEvent[]): void {
    this.addRecoveredTraces(database, events);
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
    this.publishTrace(trace);
  }

  private publishTrace(event: TraceEvent): void {
    const live = this.liveTraces.get(event.runId) ?? [];
    if (!live.some((candidate) => candidate.id === event.id)) {
      live.push(event);
      this.liveTraces.set(event.runId, live);
    }
    void this.traceJournal.append(event).catch((error: unknown) => {
      console.error("Failed to append Trace journal", error);
    });
    this.notifyTrace(event);
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
    attempt: Pick<AttemptTrace, "attemptId" | "attemptNumber"> | null,
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
          ...(attempt
            ? {
                attemptId: attempt.attemptId,
                attemptNumber: attempt.attemptNumber,
                parentOperationId: attempt.attemptId,
              }
            : {}),
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
    let workspaceBefore: WorkspaceSnapshot | null = null;
    let recoveryBefore: RecoverySnapshot | null = null;
    let recoveryAfter: RecoverySnapshot | null = null;
    let recoveryCaptureError: string | null = null;
    let attemptTrace: AttemptTrace | null = null;
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = startedAt;
      }
    });
    try {
      recoveryBefore = await this.recoveryStore.capture(
        recoveryLocation(agentAtStart),
        { refName: runRecoveryRef(run.id, "before") },
      );
      const capturedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        if (storedRun && recoveryBefore) {
          storedRun.recovery.before = checkpointFromSnapshot(recoveryBefore, capturedAt);
          const checkpointTrace = this.addTrace(database, {
            runId: run.id,
            agentId: agentAtStart.id,
            type: "workspace.checkpoint.created",
            status: "success",
            durationMs: null,
            summary:
              "Recovery checkpoint created for " +
              recoveryBefore.fileCount +
              " files (" +
              recoveryBefore.rootHash.slice(0, 12) +
              ")",
            error: null,
          });
          const runtimeTrace = this.addTrace(database, {
            runId: run.id,
            agentId: agentAtStart.id,
            type: "runtime.started",
            status: "info",
            durationMs: null,
            summary: "Agent Runtime execution started",
            error: null,
          });
          runtimeSpanId = runtimeTrace.spanId;
          this.publishTrace(checkpointTrace);
          this.publishTrace(runtimeTrace);
        }
      });
    } catch (error) {
      recoveryCaptureError = this.redactText(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (recoveryBefore) {
      try {
        workspaceBefore = await this.workspaces.snapshot(agentAtStart.workspacePath);
      } catch {
        workspaceBefore = null;
      }
    }
    try {
      if (!recoveryBefore) {
        throw new Error(
          "Unable to create the pre-run recovery checkpoint: " +
            (recoveryCaptureError ?? "unknown snapshot error"),
        );
      }
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      attemptTrace = new AttemptTrace(
        (event) =>
          this.captureRunnerTrace(
            run.id,
            agentAtStart.id,
            runtimeSpanId,
            event,
            runnerTraces,
          ),
        { attemptNumber: 1 },
      );
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        onTrace: attemptTrace.capture,
      });
      attemptTrace.complete();
      await this.appendWorkspaceTraces(
        agentAtStart.workspacePath,
        workspaceBefore,
        run.id,
        agentAtStart.id,
        attemptTrace.attemptId,
        attemptTrace,
        runnerTraces,
      );
      try {
        recoveryAfter = await this.recoveryStore.capture(
          recoveryLocation(agentAtStart),
          { refName: runRecoveryRef(run.id, "after") },
        );
      } catch (error) {
        recoveryCaptureError = this.redactText(
          error instanceof Error ? error.message : String(error),
        );
        throw new Error(
          "Agent execution finished, but its recovery snapshot could not be preserved: " +
            recoveryCaptureError,
        );
      }
      const completedAt = now();
      const completedRecovery = recoveryAfter;
      const recoveryChanges = diffSnapshots(recoveryBefore, completedRecovery);
      let completedTrace: TraceEvent | null = null;
      let diffTrace: TraceEvent | null = null;
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = this.redactText(result.output);
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        storedRun.recovery.after = checkpointFromSnapshot(completedRecovery, completedAt);
        storedRun.recovery.captureError = null;
        diffTrace = this.addTrace(database, {
          runId: run.id,
          agentId: agent.id,
          type: "workspace.diff.generated",
          status: "success",
          durationMs: null,
          summary: "Recovery diff generated with " + recoveryChanges.length + " changed paths",
          error: null,
        });
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
      if (diffTrace) this.publishTrace(diffTrace);
      if (completedTrace) this.publishTrace(completedTrace);
    } catch (error) {
      if (attemptTrace) {
        const failure = classifyAttemptFailure(error);
        try {
          attemptTrace.fail({ error, ...failure });
        } catch {
          // A malformed observer event must not mask the original Runner error.
        }
      }
      if (recoveryBefore && !recoveryAfter && recoveryCaptureError === null) {
        try {
          recoveryAfter = await this.recoveryStore.capture(
            recoveryLocation(agentAtStart),
            { refName: runRecoveryRef(run.id, "after") },
          );
        } catch (snapshotError) {
          recoveryCaptureError = this.redactText(
            snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
          );
        }
      }
      await this.appendWorkspaceTraces(
        agentAtStart.workspacePath,
        workspaceBefore,
        run.id,
        agentAtStart.id,
        attemptTrace?.attemptId ?? runtimeSpanId,
        attemptTrace,
        runnerTraces,
      );
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = this.redactText(error instanceof Error ? error.message : String(error));
      const recoveryChanges =
        recoveryBefore && recoveryAfter ? diffSnapshots(recoveryBefore, recoveryAfter) : null;
      let completedTrace: TraceEvent | null = null;
      let diffTrace: TraceEvent | null = null;
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
          storedRun.recovery.after = recoveryAfter
            ? checkpointFromSnapshot(recoveryAfter, completedAt)
            : null;
          storedRun.recovery.captureError = recoveryCaptureError;
          if (recoveryChanges) {
            diffTrace = this.addTrace(database, {
              runId: run.id,
              agentId: agentAtStart.id,
              type: "workspace.diff.generated",
              status: "success",
              durationMs: null,
              summary:
                "Recovery diff generated with " + recoveryChanges.length + " changed paths",
              error: null,
            });
          }
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
      if (diffTrace) this.publishTrace(diffTrace);
      if (completedTrace) this.publishTrace(completedTrace);
    }
    this.liveTraces.delete(run.id);
    await this.traceJournal.complete(run.id).catch((journalError: unknown) => {
      console.error("Failed to clean completed Trace journal", journalError);
    });
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
