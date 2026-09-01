export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface User {
  id: string;
  name: string;
  createdAt: string;
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
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
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
  | "workspace.checkpoint.created"
  | "workspace.diff.generated"
  | "workspace.restore.started"
  | "workspace.restore.completed"
  | "workspace.restore.blocked"
  | "workspace.restore.failed"
  | "model.requested"
  | "model.completed"
  | "model.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "file.changed"
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
  attemptId?: string;
  attemptNumber?: number;
  retryOfAttemptId?: string | null;
  nextAttemptId?: string;
  retryDelayMs?: number;
  errorCode?: string;
  retryable?: boolean;
}

export type RecoveryStatus =
  | "available"
  | "restored"
  | "blocked"
  | "unavailable";

export type RecoveryFileKind = "created" | "modified" | "deleted";
export type RestoreAction = "create" | "replace" | "delete";

export interface RecoveryFile {
  path: string;
  kind: RecoveryFileKind;
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
  paths?: string[];
}

export interface RestoreConflict {
  path: string;
  code: "changed_since_run" | "path_blocked" | "artifact_missing";
  expectedHash: string | null;
  actualHash: string | null;
  message: string;
}

export interface RestorePreviewAction {
  path: string;
  action: RestoreAction;
}

export interface RecoveryPreview {
  id: string;
  checkpointId: string;
  expiresAt: string;
  observedStateHash: string;
  canApply: boolean;
  actions: RestorePreviewAction[];
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

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
