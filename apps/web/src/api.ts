import type {
  Agent,
  AgentRun,
  DeveloperAnalytics,
  DeveloperUserSummary,
  Message,
  SystemInfo,
  TraceEvent,
  User,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";
let traceViewerToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

export function setTraceViewerToken(token: string): void {
  traceViewerToken = token.trim();
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
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
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
