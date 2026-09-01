import type {
  Agent,
  AgentRun,
  DeveloperAnalytics,
  DeveloperUserSummary,
  Message,
  RecoveryPreview,
  RecoverySelection,
  RestoreOperation,
  RunRecovery,
  SystemInfo,
  TraceEvent,
  User,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly data: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let authToken = "";
let traceViewerToken = "";
let recoveryOperatorToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

export function setTraceViewerToken(token: string): void {
  traceViewerToken = token.trim();
}

export function setRecoveryOperatorToken(token: string): void {
  recoveryOperatorToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status, data);
  }
  return data;
}

async function streamDeveloperTrace(
  id: string,
  onMessage: (
    message:
      | { type: "snapshot"; traces: TraceEvent[] }
      | { type: "trace"; event: TraceEvent },
  ) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/developer/runs/" + id + "/stream", {
    headers: traceViewerToken
      ? { "X-Trace-Viewer-Token": traceViewerToken }
      : {},
    signal,
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(
      data.error ?? "Trace stream failed",
      response.status,
      data,
    );
  }
  if (!response.body) {
    throw new Error("Trace streaming is not supported by this browser");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    onMessage(
      JSON.parse(line) as
        | { type: "snapshot"; traces: TraceEvent[] }
        | { type: "trace"; event: TraceEvent },
    );
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  consumeLine(buffer);
}

export const api = {
  auth: () =>
    request<{
      required: boolean;
      multiUser: boolean;
      selfRegistration: boolean;
      legacyTokenEnabled: boolean;
    }>("/api/auth"),
  register: (name: string, password: string) =>
    request<{ user: User; token: string }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, password }),
    }),
  login: (name: string, password: string) =>
    request<{ user: User; token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ name, password }),
    }),
  logout: () =>
    request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  session: () => request<{ user: User }>("/api/session"),
  developerAuth: () =>
    request<{ configured: boolean; authorized: boolean }>("/api/developer/auth", {
      headers: traceViewerToken
        ? { "X-Trace-Viewer-Token": traceViewerToken }
        : {},
    }),
  developerOverview: () =>
    request<{ users: DeveloperUserSummary[]; agents: Agent[]; runs: AgentRun[] }>(
      "/api/developer/overview",
      {
        headers: traceViewerToken
          ? { "X-Trace-Viewer-Token": traceViewerToken }
          : {},
      },
    ),
  developerAnalytics: (userId: string) =>
    request<DeveloperAnalytics>(
      "/api/developer/analytics?userId=" + encodeURIComponent(userId),
      {
        headers: traceViewerToken
          ? { "X-Trace-Viewer-Token": traceViewerToken }
          : {},
      },
    ),
  developerRuns: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/developer/agents/" + id + "/runs", {
      headers: traceViewerToken
        ? { "X-Trace-Viewer-Token": traceViewerToken }
        : {},
    }),
  developerTrace: (id: string) =>
    request<{ traces: TraceEvent[] }>("/api/developer/runs/" + id + "/trace", {
      headers: traceViewerToken
        ? { "X-Trace-Viewer-Token": traceViewerToken }
        : {},
    }),
  streamDeveloperTrace,
  developerRecovery: (id: string) =>
    request<{ recovery: RunRecovery }>(
      "/api/developer/runs/" + id + "/recovery",
      {
        headers: traceViewerToken
          ? { "X-Trace-Viewer-Token": traceViewerToken }
          : {},
      },
    ),
  developerRecoveryPreview: (
    id: string,
    body: { checkpointId: string; selection: RecoverySelection },
  ) =>
    request<{ preview: RecoveryPreview }>(
      "/api/developer/runs/" + id + "/recovery/preview",
      {
        method: "POST",
        headers: traceViewerToken
          ? { "X-Trace-Viewer-Token": traceViewerToken }
          : {},
        body: JSON.stringify(body),
      },
    ),
  developerRecoveryRestore: (
    id: string,
    body: {
      checkpointId: string;
      previewId: string;
      selection: RecoverySelection;
    },
    idempotencyKey: string,
  ) =>
    request<{ operation: RestoreOperation }>(
      "/api/developer/runs/" + id + "/recovery/restore",
      {
        method: "POST",
        headers: {
          ...(traceViewerToken
            ? { "X-Trace-Viewer-Token": traceViewerToken }
            : {}),
          ...(recoveryOperatorToken
            ? { "X-Recovery-Operator-Token": recoveryOperatorToken }
            : {}),
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      },
    ),
  recovery: (id: string) =>
    request<{ recovery: RunRecovery }>("/api/runs/" + id + "/recovery"),
  recoveryPreview: (
    id: string,
    body: { checkpointId: string; selection: RecoverySelection },
  ) =>
    request<{ preview: RecoveryPreview }>(
      "/api/runs/" + id + "/recovery/preview",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  recoveryRestore: (
    id: string,
    body: {
      checkpointId: string;
      previewId: string;
      selection: RecoverySelection;
    },
    idempotencyKey: string,
  ) =>
    request<{ operation: RestoreOperation }>(
      "/api/runs/" + id + "/recovery/restore",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body),
      },
    ),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  trace: (id: string) =>
    request<{ traces: TraceEvent[] }>("/api/runs/" + id + "/trace", {
      headers: traceViewerToken
        ? { "X-Trace-Viewer-Token": traceViewerToken }
        : {},
    }),
};
