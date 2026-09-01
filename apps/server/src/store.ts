import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Agent,
  AuthSession,
  Database,
  TraceEvent,
  User,
  UserCredential,
} from "./types.js";

const fallbackUser = (): User => ({
  id: "local-user",
  name: "Local User",
  createdAt: new Date().toISOString(),
});

const emptyDatabase = (user?: User): Database => ({
  version: 4,
  users: user ? [user] : [],
  credentials: [],
  authSessions: [],
  agents: [],
  messages: [],
  runs: [],
  traces: [],
});
type StoredAgent = Omit<Agent, "ownerUserId"> & Partial<Pick<Agent, "ownerUserId">>;
type StoredDatabase = Omit<
  Database,
  "version" | "users" | "credentials" | "authSessions" | "agents" | "traces"
> & {
  version: 1 | 2 | 3 | 4;
  users?: unknown;
  credentials?: unknown;
  authSessions?: unknown;
  agents: StoredAgent[];
  traces?: unknown;
};
type StoredTraceEvent = Omit<
  TraceEvent,
  "traceId" | "spanId" | "parentSpanId" | "sequence"
> &
  Partial<Pick<TraceEvent, "traceId" | "spanId" | "parentSpanId" | "sequence">>;

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
      if (![1, 2, 3, 4].includes(parsed.version) || !Array.isArray(parsed.agents)) {
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
      const needsUserMigration =
        parsed.version !== 4 ||
        storedUsers.length === 0 ||
        parsed.agents.some((agent) => !agent.ownerUserId);

      if (parsed.traces === undefined) {
        this.data = {
          ...parsed,
          version: 4,
          users,
          credentials,
          authSessions,
          agents,
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
          version: 4,
          users,
          credentials,
          authSessions,
          agents,
          traces: migrateTraces(parsed.traces as StoredTraceEvent[]),
        } as Database;
        if (needsMigration || needsUserMigration) {
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
