import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Agent,
  AgentRun,
  AuthSession,
  Database,
  RunRecoveryState,
  TraceEvent,
  User,
  UserCredential,
  WorkspaceRecoveryCheckpoint,
  WorkspaceRecoveryCheckpointMetadata,
} from "./types.js";

const fallbackUser = (): User => ({
  id: "local-user",
  name: "Local User",
  createdAt: new Date().toISOString(),
});

const emptyDatabase = (user?: User): Database => ({
  version: 6,
  users: user ? [user] : [],
  credentials: [],
  authSessions: [],
  agents: [],
  messages: [],
  runs: [],
  traces: [],
});
type StoredAgent = Omit<Agent, "ownerUserId"> & Partial<Pick<Agent, "ownerUserId">>;
type StoredRun = Omit<AgentRun, "recovery"> & Partial<Pick<AgentRun, "recovery">>;
type StoredDatabase = Omit<
  Database,
  | "version"
  | "users"
  | "credentials"
  | "authSessions"
  | "agents"
  | "runs"
  | "traces"
> & {
  version: 1 | 2 | 3 | 4 | 5 | 6;
  users?: unknown;
  credentials?: unknown;
  authSessions?: unknown;
  agents: StoredAgent[];
  runs: StoredRun[];
  traces?: unknown;
};
type StoredTraceEvent = Omit<
  TraceEvent,
  "traceId" | "spanId" | "parentSpanId" | "sequence"
> &
  Partial<
    Pick<TraceEvent, "traceId" | "spanId" | "parentSpanId" | "sequence">
  >;

const GIT_SHA256_OID = /^[0-9a-f]{64}$/;
const GIT_RECOVERY_REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const LEGACY_CHECKPOINT_REASON =
  "This checkpoint predates Git-backed recovery and is retained for history only";
const INVALID_GIT_CHECKPOINT_REASON =
  "Git-backed checkpoint metadata is incomplete and cannot be restored";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkpointMetadata(
  value: Record<string, unknown>,
): WorkspaceRecoveryCheckpointMetadata | null {
  if (
    typeof value.rootHash !== "string" ||
    typeof value.policyId !== "string" ||
    !Number.isSafeInteger(value.fileCount) ||
    (value.fileCount as number) < 0 ||
    !Number.isSafeInteger(value.totalBytes) ||
    (value.totalBytes as number) < 0 ||
    typeof value.capturedAt !== "string"
  ) {
    return null;
  }
  return {
    rootHash: value.rootHash,
    policyId: value.policyId,
    fileCount: value.fileCount as number,
    totalBytes: value.totalBytes as number,
    capturedAt: value.capturedAt,
  };
}

function migrateCheckpoint(value: unknown): WorkspaceRecoveryCheckpoint | null {
  if (!isRecord(value)) return null;
  const metadata = checkpointMetadata(value);
  if (!metadata) return null;

  if (
    value.storage === "git-sha256-v1" &&
    typeof value.repositoryId === "string" &&
    GIT_RECOVERY_REPOSITORY_ID.test(value.repositoryId) &&
    GIT_SHA256_OID.test(metadata.rootHash) &&
    typeof value.commitOid === "string" &&
    GIT_SHA256_OID.test(value.commitOid) &&
    typeof value.workspaceTreeOid === "string" &&
    GIT_SHA256_OID.test(value.workspaceTreeOid) &&
    typeof value.manifestBlobOid === "string" &&
    GIT_SHA256_OID.test(value.manifestBlobOid)
  ) {
    return {
      ...metadata,
      storage: "git-sha256-v1",
      repositoryId: value.repositoryId,
      commitOid: value.commitOid,
      workspaceTreeOid: value.workspaceTreeOid,
      manifestBlobOid: value.manifestBlobOid,
    };
  }

  return {
    ...metadata,
    storage: "legacy-unavailable-v1",
    unavailableReason:
      value.storage === "legacy-unavailable-v1" &&
      typeof value.unavailableReason === "string" &&
      value.unavailableReason.length > 0
        ? value.unavailableReason
        : value.storage === "git-sha256-v1"
          ? INVALID_GIT_CHECKPOINT_REASON
          : LEGACY_CHECKPOINT_REASON,
  };
}

function checkpointNeedsMigration(value: unknown): boolean {
  if (value === null) return false;
  const migrated = migrateCheckpoint(value);
  if (!isRecord(value) || !migrated || value.storage !== migrated.storage) return true;
  return (
    migrated.storage === "legacy-unavailable-v1" &&
    value.unavailableReason !== migrated.unavailableReason
  );
}

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

function migrateTraces(events: StoredTraceEvent[]): TraceEvent[] {
  const sequences = new Map<string, number>();
  const withIds = events.map((event) => {
    const nextSequence = (sequences.get(event.runId) ?? 0) + 1;
    const sequence = event.sequence ?? nextSequence;
    sequences.set(event.runId, Math.max(nextSequence, sequence));
    return {
      ...event,
      traceId: event.traceId ?? event.runId,
      spanId: event.spanId ?? event.id,
      sequence,
    };
  });

  return withIds.map((event) => {
    if (event.parentSpanId !== undefined) {
      return event as TraceEvent;
    }
    const rootSpan = withIds.find(
      (candidate) =>
        candidate.runId === event.runId && candidate.type === "run.started",
    );
    const runtimeSpan = withIds.find(
      (candidate) =>
        candidate.runId === event.runId && candidate.type === "runtime.started",
    );
    const parentSpanId =
      event.type === "run.started"
        ? null
        : runtimeChildEventTypes.has(event.type)
          ? (runtimeSpan?.spanId ?? rootSpan?.spanId ?? null)
          : (rootSpan?.spanId ?? null);
    return { ...event, parentSpanId };
  });
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(defaultUser?: User): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoredDatabase;
      if (
        ![1, 2, 3, 4, 5, 6].includes(parsed.version) ||
        !Array.isArray(parsed.agents) ||
        !Array.isArray(parsed.runs)
      ) {
        throw new Error("Unsupported database format");
      }

      const migrationUser = defaultUser ?? fallbackUser();
      const storedUsers = Array.isArray(parsed.users)
        ? (parsed.users as User[])
        : [];
      const users = storedUsers.length > 0 ? storedUsers : [migrationUser];
      if (parsed.credentials !== undefined && !Array.isArray(parsed.credentials)) {
        throw new Error("Unsupported database format");
      }
      if (parsed.authSessions !== undefined && !Array.isArray(parsed.authSessions)) {
        throw new Error("Unsupported database format");
      }
      const credentials = (parsed.credentials ?? []) as UserCredential[];
      const authSessions = (parsed.authSessions ?? []) as AuthSession[];
      const agents = parsed.agents.map((agent) => ({
        ...agent,
        ownerUserId: agent.ownerUserId ?? migrationUser.id,
      })) as Agent[];
      const runs = parsed.runs.map((run) => {
        const recovery = run.recovery as Partial<RunRecoveryState> | undefined;
        return {
          ...run,
          recovery: {
            before: migrateCheckpoint(recovery?.before),
            after: migrateCheckpoint(recovery?.after),
            captureError: recovery?.captureError ?? null,
            pendingRestores: Array.isArray(recovery?.pendingRestores)
              ? recovery.pendingRestores
              : [],
            restores: Array.isArray(recovery?.restores) ? recovery.restores : [],
          },
        };
      }) as AgentRun[];
      const needsUserMigration =
        parsed.version !== 6 ||
        storedUsers.length === 0 ||
        parsed.agents.some((agent) => !agent.ownerUserId);
      const needsRecoveryMigration = parsed.runs.some(
        (run) =>
          !run.recovery ||
          checkpointNeedsMigration(run.recovery.before) ||
          checkpointNeedsMigration(run.recovery.after) ||
          !Array.isArray(run.recovery.pendingRestores) ||
          !Array.isArray(run.recovery.restores),
      );

      if (parsed.traces === undefined) {
        this.data = {
          ...parsed,
          version: 6,
          users,
          credentials,
          authSessions,
          agents,
          runs,
          traces: [],
        } as Database;
        await this.persist();
      } else {
        if (!Array.isArray(parsed.traces)) {
          throw new Error("Unsupported database format");
        }
        const needsMigration = parsed.traces.some(
          (event) =>
            typeof event !== "object" ||
            event === null ||
            !("traceId" in event) ||
            !("spanId" in event) ||
             !("parentSpanId" in event) ||
             !("sequence" in event),
        );
        this.data = {
          ...parsed,
          version: 6,
          users,
          credentials,
          authSessions,
          agents,
          runs,
          traces: migrateTraces(parsed.traces as StoredTraceEvent[]),
        } as Database;
        if (needsMigration || needsUserMigration || needsRecoveryMigration) {
          await this.persist();
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.data = emptyDatabase(defaultUser);
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
