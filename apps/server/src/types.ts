export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface User {
  id: string;
  name: string;
  createdAt: string;
}

export interface UserCredential {
  userId: string;
  loginName: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface DeveloperUserSummary extends User {
  agentCount: number;
  runCount: number;
  failedRunCount: number;
  lastActivityAt: string | null;
}

export interface DeveloperAgentMetric {
  agentId: string;
  agentName: string;
  runCount: number;
  completedRunCount: number;
  failedRunCount: number;
  averageDurationMs: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  lastRunAt: string | null;
}

export interface DeveloperAnalytics {
  userId: string;
  totalRuns: number;
  completedRunCount: number;
  failedRunCount: number;
  successRate: number | null;
  averageDurationMs: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  agents: DeveloperAgentMetric[];
}

export interface Agent {
  id: string;
  ownerUserId: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface WorkspaceRecoveryCheckpointMetadata {
  rootHash: string;
  policyId: string;
  fileCount: number;
  totalBytes: number;
  capturedAt: string;
}

export interface GitWorkspaceRecoveryCheckpoint
  extends WorkspaceRecoveryCheckpointMetadata {
  storage: "git-sha256-v1";
  repositoryId: string;
  commitOid: string;
  workspaceTreeOid: string;
  manifestBlobOid: string;
}

export interface LegacyUnavailableWorkspaceRecoveryCheckpoint
  extends WorkspaceRecoveryCheckpointMetadata {
  storage: "legacy-unavailable-v1";
  unavailableReason: string;
}

export type WorkspaceRecoveryCheckpoint =
  | GitWorkspaceRecoveryCheckpoint
  | LegacyUnavailableWorkspaceRecoveryCheckpoint;

export function isGitWorkspaceRecoveryCheckpoint(
  checkpoint: WorkspaceRecoveryCheckpoint | null | undefined,
): checkpoint is GitWorkspaceRecoveryCheckpoint {
  return checkpoint?.storage === "git-sha256-v1";
}

export interface WorkspaceRestoreAudit {
  id: string;
  idempotencyKeyHash: string;
  checkpointId: string;
  actorType: "owner" | "developer";
  actorId: string | null;
  mode: "all" | "paths";
  selectedPaths: string[];
  restoredPaths: string[];
  previousRootHash: string;
  restoredRootHash: string;
  safetySnapshotId: string;
  quarantinePath: string;
  completedAt: string;
}

export interface WorkspaceRestoreIntent {
  id: string;
  idempotencyKeyHash: string;
  checkpointId: string;
  actorType: "owner" | "developer";
  actorId: string | null;
  mode: "all" | "paths";
  selectedPaths: string[];
  restoredPaths: string[];
  expectedRootHash: string;
  resultingRootHash: string;
  startedAt: string;
}

export interface RunRecoveryState {
  before: WorkspaceRecoveryCheckpoint | null;
  after: WorkspaceRecoveryCheckpoint | null;
  captureError: string | null;
  pendingRestores: WorkspaceRestoreIntent[];
  restores: WorkspaceRestoreAudit[];
}

export type RecoveryStatus = "available" | "restored" | "blocked" | "unavailable";

export interface RecoveryFile {
  path: string;
  kind: "created" | "modified" | "deleted";
  beforeHash: string | null;
  afterHash: string | null;
  sizeBefore: number | null;
  sizeAfter: number | null;
  restorable: boolean;
}

export interface RecoverySummary {
  created: number;
  modified: number;
  deleted: number;
  total: number;
}

export interface RunRecovery {
  runId: string;
  checkpointId: string;
  status: RecoveryStatus;
  capturedAt: string;
  beforeStateHash: string;
  afterStateHash: string;
  currentStateHash: string;
  restoredAt: string | null;
  summary: RecoverySummary;
  files: RecoveryFile[];
}

export interface RecoverySelection {
  mode: "all" | "paths";
  paths?: string[] | undefined;
}

export interface RestoreConflict {
  path: string;
  code: "changed_since_run" | "path_blocked" | "artifact_missing";
  expectedHash: string | null;
  actualHash: string | null;
  message: string;
}

export interface RecoveryPreview {
  id: string;
  checkpointId: string;
  expiresAt: string;
  observedStateHash: string;
  canApply: boolean;
  actions: Array<{ path: string; action: "create" | "replace" | "delete" }>;
  conflicts: RestoreConflict[];
}

export interface RestoreOperation {
  id: string;
  status: "completed" | "failed";
  safetySnapshotId: string;
  restoredPaths: string[];
  newStateHash: string;
  completedAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  recovery: RunRecoveryState;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}
export type TraceEventType =
  | "run.started"
  | "runtime.started"
  | "attempt.started"
  | "attempt.completed"
  | "attempt.failed"
  | "retry.scheduled"
  | "model.requested"
  | "model.completed"
  | "model.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "file.changed"
  | "workspace.checkpoint.created"
  | "workspace.diff.generated"
  | "workspace.restore.started"
  | "workspace.restore.completed"
  | "workspace.restore.blocked"
  | "workspace.restore.failed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";
export type TraceEventStatus = "info" | "success" | "error";
export interface TraceEvent {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  runId: string;
  agentId: string;
  type: TraceEventType;
  status: TraceEventStatus;
  timestamp: string;
  durationMs: number | null;
  summary: string;
  error: string | null;
  sequence: number;
  attemptId?: string | undefined;
  attemptNumber?: number | undefined;
  retryOfAttemptId?: string | null | undefined;
  nextAttemptId?: string | undefined;
  retryDelayMs?: number | undefined;
  errorCode?: string | undefined;
  retryable?: boolean | undefined;
}

export interface RunnerTraceEvent {
  type:
    | "attempt.started"
    | "attempt.completed"
    | "attempt.failed"
    | "retry.scheduled"
    | "model.requested"
    | "model.completed"
    | "model.failed"
    | "tool.started"
    | "tool.completed"
    | "tool.failed"
    | "file.changed";
  status: TraceEventStatus;
  timestamp: string;
  durationMs: number | null;
  summary: string;
  error: string | null;
  operationId?: string | undefined;
  parentOperationId?: string | undefined;
  attemptId?: string | undefined;
  attemptNumber?: number | undefined;
  retryOfAttemptId?: string | null | undefined;
  nextAttemptId?: string | undefined;
  retryDelayMs?: number | undefined;
  errorCode?: string | undefined;
  retryable?: boolean | undefined;
}

export interface Database {
  version: 6;
  users: User[];
  credentials: UserCredential[];
  authSessions: AuthSession[];
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  traces: TraceEvent[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  onTrace?: ((event: RunnerTraceEvent) => void) | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
