import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken, setTraceViewerToken } from "./api";
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

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

type TraceFilter = "all" | "lifecycle" | "model" | "tool" | "file" | "error";
type AuthMode = "login" | "register" | "token";
type DeveloperLevel = "users" | "user" | "agent";
type DeveloperOverviewPanel = "users" | "agents" | "runs" | "failures";

type TraceDiagnosis = {
  title: string;
  explanation: string;
  nextStep: string;
};

const traceViewerSessionKey = "launchpad.trace-viewer-token";
const userAccessSessionKey = "launchpad.user-access-token";
const selectedDeveloperAgentSessionKey = "launchpad.developer-selected-agent";
const selectedDeveloperUserSessionKey = "launchpad.developer-selected-user";

function readSessionValue(key: string): string {
  try {
    return window.sessionStorage.getItem(key)?.trim() ?? "";
  } catch {
    return "";
  }
}

function writeSessionValue(key: string, value: string): void {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Session persistence is optional; the current page can still operate.
  }
}

function readPersistentValue(key: string): string {
  try {
    return window.localStorage.getItem(key)?.trim() ?? "";
  } catch {
    return "";
  }
}

function writePersistentValue(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Persistence is optional; the current page can still operate.
  }
}

function readTraceViewerSession(): string {
  return readSessionValue(traceViewerSessionKey);
}

function writeTraceViewerSession(token: string): void {
  writeSessionValue(traceViewerSessionKey, token);
}

function readSelectedDeveloperAgent(): string {
  return readSessionValue(selectedDeveloperAgentSessionKey);
}

function writeSelectedDeveloperAgent(agentId: string): void {
  writeSessionValue(selectedDeveloperAgentSessionKey, agentId);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  return value < 1_000 ? value + " ms" : (value / 1_000).toFixed(1) + " s";
}

function runDuration(run: AgentRun): number | null {
  if (!run.startedAt || !run.completedAt) return null;
  const duration = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function runErrorType(run: AgentRun): string {
  if (run.status === "cancelled") return "Cancelled";
  const message = (run.error ?? "").toLocaleLowerCase();
  if (message.includes("401") || message.includes("api key") || message.includes("unauthorized")) {
    return "Authentication";
  }
  if (message.includes("docker") || message.includes("container")) return "Runtime";
  if (message.includes("command") || message.includes("exit code")) return "Tool execution";
  if (message.includes("timeout") || message.includes("timed out")) return "Timeout";
  return "Execution";
}

function formatNumber(value: number | undefined): string {
  return new Intl.NumberFormat().format(value ?? 0);
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function diagnoseTraceError(error: string): TraceDiagnosis {
  const message = error.toLowerCase();

  if (
    message.includes("api key doesn't exist") ||
    message.includes("api key format is incorrect") ||
    message.includes("invalid api key")
  ) {
    if (message.includes("ark.cn-beijing.volces.com")) {
      return {
        title: "Ark Key 与服务区域可能不匹配",
        explanation:
          "请求发往北京区域，但当前 API Key 或模型服务可能配置在新加坡区域，因此北京区域无法识别这把 Key。",
        nextStep:
          '在启动终端执行 export ARK_BASE_URL="https://ark.ap-southeast.bytepluses.com/api/v3"，然后重新运行 npm run poc。',
      };
    }
    return {
      title: "ModelArk API Key 无效或已失效",
      explanation: "服务拒绝了这把 Key；它可能复制不完整、被撤销，或不是 ModelArk API Key。",
      nextStep: "在 ModelArk 控制台重新生成 API Key，确认不是 BytePlus 账号 AK/SK，然后重启平台。",
    };
  }

  if (message.includes("401 unauthorized")) {
    return {
      title: "模型服务认证失败",
      explanation: "模型服务没有接受当前的认证信息。",
      nextStep: "检查 ARK_API_KEY、ARK_BASE_URL 和 ARK_MODEL 是否来自同一服务区域，再重启 npm run poc。",
    };
  }

  if (message.includes("429") || message.includes("rate limit") || message.includes("quota")) {
    return {
      title: "模型额度或请求频率受限",
      explanation: "服务暂时拒绝了这次模型调用，常见原因是免费额度用尽或短时间请求过多。",
      nextStep: "稍后重试，并在 ModelArk 控制台检查可用额度、模型状态和调用限额。",
    };
  }

  if (message.includes("404") || message.includes("model not found") || message.includes("endpoint not found")) {
    return {
      title: "Ark 模型或 Endpoint ID 不存在",
      explanation: "当前 ARK_MODEL 在配置的服务区域中不可用。",
      nextStep: "到 ModelArk 的 Sample code 页面复制已激活模型对应的 Endpoint ID，再重启平台。",
    };
  }

  if (message.includes("timed out") || message.includes("timeout") || message.includes("etimedout")) {
    return {
      title: "模型或运行环境响应超时",
      explanation: "本次任务在规定时间内没有完成，可能是网络、模型服务或任务本身耗时较长。",
      nextStep: "先重试一次；若持续发生，请缩短任务或检查网络和容器 Runtime 状态。",
    };
  }

  const exitCode = error.match(/(?:exit(?:ed)? with code|exit code)\s+(\d+)/i)?.[1];
  if (exitCode) {
    return {
      title: "Agent 执行的命令失败",
      explanation: "工具进程返回了非零退出码 " + exitCode + "，因此这一步没有成功完成。",
      nextStep: "在下方 Trace 中查看 tool.failed 事件；根据命令、退出码和上下文修正任务或环境后重试。",
    };
  }

  if (message.includes("docker") || message.includes("container runtime")) {
    return {
      title: "Agent 容器运行环境异常",
      explanation: "本地 Docker/Colima/Podman Runtime 未能正常完成本次 Agent 执行。",
      nextStep: "确认 Docker Desktop 正在运行，然后在启动终端重新执行 npm run poc。",
    };
  }

  return {
    title: "需要进一步查看运行证据",
    explanation: "系统记录到了失败，但还不能从当前错误文本判断唯一原因。",
    nextStep: "使用 Errors only 筛选失败事件，查看第一个红色事件的原始错误、耗时和上下级 Span。",
  };
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const developerView = window.location.pathname === "/developer";
  const [agents, setAgents] = useState<Agent[]>([]);
  const [developerUsers, setDeveloperUsers] = useState<DeveloperUserSummary[]>([]);
  const [developerAgentInventory, setDeveloperAgentInventory] = useState<Agent[]>([]);
  const [developerRunInventory, setDeveloperRunInventory] = useState<AgentRun[]>([]);
  const [developerAnalytics, setDeveloperAnalytics] = useState<DeveloperAnalytics | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [developerLevel, setDeveloperLevel] = useState<DeveloperLevel>("users");
  const [developerUserSearch, setDeveloperUserSearch] = useState("");
  const [developerAgentSearch, setDeveloperAgentSearch] = useState("");
  const [developerRunSearch, setDeveloperRunSearch] = useState("");
  const [developerFailureSearch, setDeveloperFailureSearch] = useState("");
  const [developerOverviewPanel, setDeveloperOverviewPanel] =
    useState<DeveloperOverviewPanel | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [traces, setTraces] = useState<TraceEvent[]>([]);
  const [traceFilter, setTraceFilter] = useState<TraceFilter>("all");
  const [expandedTraceIds, setExpandedTraceIds] = useState<Set<string>>(new Set());
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [authName, setAuthName] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authInput, setAuthInput] = useState("");
  const [legacyTokenEnabled, setLegacyTokenEnabled] = useState(false);
  const [developerAccess, setDeveloperAccess] = useState(false);
  const [developerConfigured, setDeveloperConfigured] = useState<boolean | null>(null);
  const [developerInput, setDeveloperInput] = useState("");
  const [developerError, setDeveloperError] = useState<string | null>(null);
  const messageEnd = useRef<HTMLDivElement>(null);
  const developerDetail = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const activeRunRef = useRef<AgentRun | null>(null);
  const latestRunIdRef = useRef<string | null>(null);
  const followLatestRunRef = useRef(true);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;
  activeRunRef.current = activeRun;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const selectedDeveloperUser = useMemo(
    () => developerUsers.find((user) => user.id === selectedUserId) ?? null,
    [developerUsers, selectedUserId],
  );

  const filteredDeveloperUsers = useMemo(() => {
    const query = developerUserSearch.trim().toLocaleLowerCase();
    if (!query) return developerUsers;
    return developerUsers.filter((user) =>
      user.name.toLocaleLowerCase().includes(query),
    );
  }, [developerUserSearch, developerUsers]);

  const developerTotals = useMemo(
    () => ({
      users: developerUsers.length,
      agents: developerAgentInventory.length,
      runs: developerUsers.reduce((total, user) => total + user.runCount, 0),
      failedRuns: developerUsers.reduce(
        (total, user) => total + user.failedRunCount,
        0,
      ),
    }),
    [developerAgentInventory.length, developerUsers],
  );

  const developerUserById = useMemo(
    () => new Map(developerUsers.map((user) => [user.id, user])),
    [developerUsers],
  );

  const developerAgentById = useMemo(
    () => new Map(developerAgentInventory.map((agent) => [agent.id, agent])),
    [developerAgentInventory],
  );

  const filteredDeveloperAgents = useMemo(() => {
    const query = developerAgentSearch.trim().toLocaleLowerCase();
    if (!query) return developerAgentInventory;
    return developerAgentInventory.filter((agent) => {
      const owner = developerUserById.get(agent.ownerUserId);
      return [agent.name, owner?.name, agent.status, agent.id]
        .some((value) => value?.toLocaleLowerCase().includes(query));
    });
  }, [developerAgentInventory, developerAgentSearch, developerUserById]);

  const developerRunRows = useMemo(
    () => developerRunInventory.map((run) => {
      const agent = developerAgentById.get(run.agentId) ?? null;
      const owner = agent ? developerUserById.get(agent.ownerUserId) ?? null : null;
      return { run, agent, owner };
    }),
    [developerAgentById, developerRunInventory, developerUserById],
  );

  const filteredDeveloperRuns = useMemo(() => {
    const query = developerRunSearch.trim().toLocaleLowerCase();
    if (!query) return developerRunRows;
    return developerRunRows.filter(({ run, agent, owner }) =>
      [run.id, run.status, agent?.name, owner?.name]
        .some((value) => value?.toLocaleLowerCase().includes(query)),
    );
  }, [developerRunRows, developerRunSearch]);

  const filteredDeveloperFailures = useMemo(() => {
    const query = developerFailureSearch.trim().toLocaleLowerCase();
    const failures = developerRunRows.filter(({ run }) => run.status === "failed");
    if (!query) return failures;
    return failures.filter(({ run, agent, owner }) =>
      [run.id, run.status, runErrorType(run), run.error, agent?.name, owner?.name]
        .some((value) => value?.toLocaleLowerCase().includes(query)),
    );
  }, [developerFailureSearch, developerRunRows]);

  const refreshDeveloperOverview = useCallback(async () => {
    const result = await api.developerOverview();
    setDeveloperUsers(result.users);
    setDeveloperAgentInventory(result.agents);
    setDeveloperRunInventory(result.runs);
    setSelectedUserId((current) => {
      const next =
        current && result.users.some((user) => user.id === current)
          ? current
          : null;
      writeSessionValue(selectedDeveloperUserSessionKey, next ?? "");
      return next;
    });
  }, []);

  const refreshDeveloperAnalytics = useCallback(async (userId: string) => {
    const result = await api.developerAnalytics(userId);
    if (mountedRef.current) setDeveloperAnalytics(result);
  }, []);

  const refreshAgents = useCallback(async () => {
    if (developerView) {
      await refreshDeveloperOverview();
      return;
    }
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) => {
      const remembered = "";
      const preferred = current || remembered;
      const nextSelected =
        preferred && next.some((agent) => agent.id === preferred)
          ? preferred
          : (next[0]?.id ?? null);
      return nextSelected;
    });
  }, [developerView, refreshDeveloperOverview]);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshRuns = useCallback(async (agentId: string): Promise<AgentRun[]> => {
    const { runs: next } = developerView
      ? await api.developerRuns(agentId)
      : await api.runs(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setRuns(next);
    }
    return next;
  }, [developerView]);

  const refreshTrace = useCallback(async (runId: string, agentId: string) => {
    const result = developerView
      ? await api.developerTrace(runId)
      : await api.trace(runId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setTraces(result.traces);
    }
  }, [developerView]);

  const bootstrap = useCallback(async () => {
    if (developerView) {
      await api.system().then(setSystem);
      return;
    }
    await Promise.all([
      refreshAgents(),
      api.system().then(setSystem),
      api.session().then(({ user }) => setCurrentUser(user)),
    ]);
  }, [developerView, refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required, legacyTokenEnabled: hasLegacyToken }) => {
        if (!mountedRef.current) return;
        setLegacyTokenEnabled(hasLegacyToken);
        if (developerView) {
          setAuthRequired(false);
          await bootstrap();
          return;
        }
        if (!required) {
          setAuthRequired(false);
          await bootstrap();
          return;
        }
        const storedToken = readPersistentValue(userAccessSessionKey);
        if (!storedToken) {
          setAuthRequired(true);
          return;
        }
        setAuthToken(storedToken);
        try {
          await bootstrap();
          setAuthRequired(false);
        } catch {
          writePersistentValue(userAccessSessionKey, "");
          setAuthToken("");
          setAuthRequired(true);
        }
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap, developerView]);

  useEffect(() => {
    if (!developerView) return;
    if (!selectedUserId) {
      setAgents([]);
      setSelectedId(null);
      return;
    }
    const nextAgents = developerAgentInventory.filter(
      (agent) => agent.ownerUserId === selectedUserId,
    );
    setAgents(nextAgents);
    setSelectedId((current) => {
      const next =
        current && nextAgents.some((agent) => agent.id === current)
          ? current
          : null;
      writeSelectedDeveloperAgent(next ?? "");
      return next;
    });
  }, [developerAgentInventory, developerView, selectedUserId]);

  useEffect(() => {
    if (!developerView || !developerAccess || !selectedUserId) {
      setDeveloperAnalytics(null);
      return;
    }
    void refreshDeveloperAnalytics(selectedUserId).catch((reason) =>
      setDeveloperError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [developerAccess, developerView, refreshDeveloperAnalytics, selectedUserId]);

  useEffect(() => {
    if (!developerView || authRequired !== false) return;
    const storedToken = readTraceViewerSession();
    setTraceViewerToken(storedToken);
    void api
      .developerAuth()
      .then(({ configured, authorized }) => {
        if (!mountedRef.current) return;
        setDeveloperConfigured(configured);
        setDeveloperAccess(authorized);
        if (authorized) void refreshDeveloperOverview();
        if (!authorized && storedToken) {
          writeTraceViewerSession("");
          setTraceViewerToken("");
        }
      })
      .catch((reason) =>
        setDeveloperError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [authRequired, developerView, refreshDeveloperOverview]);

  useEffect(() => {
    followLatestRunRef.current = true;
    latestRunIdRef.current = null;
    setActiveRun(null);
    setTraces([]);
    setRuns([]);
    setTraceFilter("all");
    setExpandedTraceIds(new Set());
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    const dataRequest = developerView
      ? refreshRuns(selectedId)
      : Promise.all([refreshMessages(selectedId), refreshRuns(selectedId)]).then(
          ([, nextRuns]) => nextRuns,
        );
    void dataRequest
      .then((nextRuns) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = nextRuns[0] ?? null;
        setActiveRun(latest);
        if (latest && developerView && developerAccess) {
          void refreshTrace(latest.id, selectedId).catch((reason) =>
            setDeveloperError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
        if (!developerView && latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [developerAccess, developerView, refreshMessages, refreshRuns, refreshTrace, selectedId]);

  useEffect(() => {
    if (!developerView || !developerAccess || !selectedId) return;
    let cancelled = false;
    let timer: number | undefined;

    const refreshDeveloperTelemetry = async () => {
      try {
        const nextRuns = await refreshRuns(selectedId);
        if (cancelled || selectedIdRef.current !== selectedId) return;

        const latest = nextRuns[0] ?? null;
        const previousLatestId = latestRunIdRef.current;
        const current = activeRunRef.current;
        const shouldFollowLatest =
          followLatestRunRef.current || !current || current.id === previousLatestId;
        latestRunIdRef.current = latest?.id ?? null;

        let displayedRun = current;
        if (latest && shouldFollowLatest) {
          displayedRun = latest;
          followLatestRunRef.current = true;
          activeRunRef.current = latest;
          setActiveRun(latest);
        } else if (current) {
          const refreshedCurrent = nextRuns.find((run) => run.id === current.id);
          if (refreshedCurrent) {
            displayedRun = refreshedCurrent;
            activeRunRef.current = refreshedCurrent;
            setActiveRun(refreshedCurrent);
          }
        }

        if (displayedRun) {
          await refreshTrace(displayedRun.id, selectedId);
        } else {
          setTraces([]);
        }
        await Promise.all([
          refreshAgents(),
          selectedUserId ? refreshDeveloperAnalytics(selectedUserId) : Promise.resolve(),
        ]);
        setDeveloperError(null);
      } catch (reason) {
        if (!cancelled) {
          setDeveloperError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(() => void refreshDeveloperTelemetry(), 1_000);
        }
      }
    };

    void refreshDeveloperTelemetry();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [developerAccess, developerView, refreshAgents, refreshDeveloperAnalytics, refreshRuns, refreshTrace, selectedId, selectedUserId]);

  useEffect(() => {
    if (!developerView || !developerAccess || developerLevel === "agent") return;
    let cancelled = false;
    let timer: number | undefined;

    const refreshDirectory = async () => {
      try {
        await refreshDeveloperOverview();
        if (!cancelled && selectedUserId) {
          await refreshDeveloperAnalytics(selectedUserId);
        }
        if (!cancelled) setDeveloperError(null);
      } catch (reason) {
        if (!cancelled) {
          setDeveloperError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(() => void refreshDirectory(), 1_500);
        }
      }
    };

    void refreshDirectory();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [developerAccess, developerLevel, developerView, refreshDeveloperAnalytics, refreshDeveloperOverview, selectedUserId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    if (developerView && selectedId) writeSelectedDeveloperAgent(selectedId);
  }, [developerView, selectedId]);

  useEffect(() => {
    if (developerView && selectedUserId) {
      writeSessionValue(selectedDeveloperUserSessionKey, selectedUserId);
    }
  }, [developerView, selectedUserId]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun, traces]);

  useEffect(() => {
    if (!developerView || developerLevel !== "agent" || !selectedId) return;
    const frame = window.requestAnimationFrame(() => {
      developerDetail.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [developerLevel, developerView, selectedId]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) {
          setActiveRun(result.run);
          if (developerView && developerAccess) {
            await refreshTrace(runId, agentId);
          }
        }
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents(), refreshRuns(agentId)]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const selectRun = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    if (!selected) return;
    const run = runs.find((candidate) => candidate.id === event.target.value);
    if (!run) return;
    latestRunIdRef.current = runs[0]?.id ?? null;
    followLatestRunRef.current = run.id === latestRunIdRef.current;
    activeRunRef.current = run;
    setActiveRun(run);
    setTraceFilter("all");
    setExpandedTraceIds(new Set());
    setError(null);
    try {
      await refreshTrace(run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const toggleTraceEvent = (eventId: string) => {
    setExpandedTraceIds((current) => {
      const next = new Set(current);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const exportTrace = () => {
    if (!selected || !activeRun) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      agent: { id: selected.id, name: selected.name },
      run: activeRun,
      trace: traces,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "trace-" + activeRun.id + ".json";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const visibleTraces = useMemo(() => {
    if (traceFilter === "all") return traces;
    return traces.filter((event) => {
      if (traceFilter === "error") return event.status === "error";
      if (traceFilter === "lifecycle") return event.type.startsWith("run.") || event.type === "runtime.started";
      if (traceFilter === "model") return event.type.startsWith("model.");
      if (traceFilter === "tool") return event.type.startsWith("tool.");
      return event.type === "file.changed";
    });
  }, [traceFilter, traces]);

  const firstTraceError = traces.find((event) => event.status === "error");
  const traceDiagnosis = firstTraceError
    ? diagnoseTraceError(firstTraceError.error ?? firstTraceError.summary)
    : null;

  const agentRunMaximum = useMemo(
    () => Math.max(1, ...(developerAnalytics?.agents.map((agent) => agent.runCount) ?? [0])),
    [developerAnalytics],
  );

  const traceWaterfall = useMemo(() => {
    if (traces.length === 0) return [];
    const sortedEvents = [...traces].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    );
    const startFor = (event: TraceEvent): number => {
      const startType =
        event.type === "model.completed"
          ? "model.requested"
          : event.type === "tool.completed" || event.type === "tool.failed"
            ? "tool.started"
            : event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
              ? "run.started"
              : null;
      if (!startType) return Date.parse(event.timestamp);
      const preceding = [...sortedEvents]
        .reverse()
        .find((candidate) => candidate.type === startType && candidate.timestamp <= event.timestamp);
      return preceding ? Date.parse(preceding.timestamp) : Date.parse(event.timestamp);
    };
    const visualEvents = sortedEvents.filter((event) =>
      [
        "model.completed",
        "tool.completed",
        "tool.failed",
        "file.changed",
        "run.completed",
        "run.failed",
        "run.cancelled",
      ].includes(event.type),
    );
    const starts = visualEvents.map(startFor);
    const start = Math.min(...starts, ...sortedEvents.map((event) => Date.parse(event.timestamp)));
    const end = Math.max(
      ...sortedEvents.map((event) => Date.parse(event.timestamp)),
      activeRun?.completedAt ? Date.parse(activeRun.completedAt) : Date.now(),
    );
    const total = Math.max(1, end - start);
    return visualEvents.map((event) => {
      const eventStart = startFor(event);
      const offset = Math.max(0, eventStart - start);
      const duration = Math.max(event.durationMs ?? 0, 80);
      return {
        ...event,
        left: Math.min(96, (offset / total) * 100),
        width: Math.min(100, Math.max(4, (duration / total) * 100)),
      };
    });
  }, [activeRun?.completedAt, traces]);

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      writePersistentValue(userAccessSessionKey, authInput.trim());
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  const authenticateAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result =
        authMode === "register"
          ? await api.register(authName, authPassword)
          : await api.login(authName, authPassword);
      setAuthToken(result.token);
      writePersistentValue(userAccessSessionKey, result.token);
      setCurrentUser(result.user);
      await bootstrap();
      setAuthRequired(false);
      setAuthPassword("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("用户名或密码不正确。");
      } else if (reason instanceof ApiError && reason.status === 409) {
        setError("这个用户名已经被使用，请换一个。");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await api.logout().catch(() => undefined);
    } finally {
      writePersistentValue(userAccessSessionKey, "");
      setAuthToken("");
      setCurrentUser(null);
      setAgents([]);
      setSelectedId(null);
      setMessages([]);
      setRuns([]);
      setTraces([]);
      setAuthRequired(true);
      setBusy(false);
    }
  };

  const unlockDeveloper = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setDeveloperError(null);
    setTraceViewerToken(developerInput);
    try {
      const result = await api.developerAuth();
      setDeveloperConfigured(result.configured);
      if (!result.authorized) {
        throw new Error("The Developer Console token is not valid.");
      }
      writeTraceViewerSession(developerInput.trim());
      setDeveloperAccess(true);
      await refreshDeveloperOverview();
      setDeveloperLevel("users");
      setSelectedUserId(null);
      setSelectedId(null);
      setDeveloperInput("");
    } catch (reason) {
      writeTraceViewerSession("");
      setTraceViewerToken("");
      setDeveloperAccess(false);
      setDeveloperError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const showDeveloperUsers = () => {
    setDeveloperLevel("users");
    setSelectedUserId(null);
    setSelectedId(null);
    setDeveloperAnalytics(null);
    writeSessionValue(selectedDeveloperUserSessionKey, "");
    writeSelectedDeveloperAgent("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const inspectDeveloperUser = (userId: string) => {
    setSelectedUserId(userId);
    setSelectedId(null);
    setDeveloperLevel("user");
    writeSessionValue(selectedDeveloperUserSessionKey, userId);
    writeSelectedDeveloperAgent("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const inspectDeveloperAgent = (agentId: string) => {
    const agent = developerAgentInventory.find((candidate) => candidate.id === agentId);
    if (agent?.ownerUserId) {
      setSelectedUserId(agent.ownerUserId);
      writeSessionValue(selectedDeveloperUserSessionKey, agent.ownerUserId);
    }
    setSelectedId(agentId);
    setDeveloperLevel("agent");
    writeSelectedDeveloperAgent(agentId);
  };

  const toggleDeveloperOverviewPanel = (panel: DeveloperOverviewPanel) => {
    setDeveloperOverviewPanel((current) => (current === panel ? null : panel));
  };

  const toggleDeveloperOverviewOnKey = (
    event: React.KeyboardEvent,
    panel: DeveloperOverviewPanel,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleDeveloperOverviewPanel(panel);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    const accountMode = authMode !== "token";
    return (
      <main className="auth-screen">
        <form
          className="auth-card account-auth-card"
          onSubmit={accountMode ? authenticateAccount : unlock}
        >
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>{authMode === "register" ? "创建你的账号" : "登录 Agent 工作区"}</h1>
          <p>
            {authMode === "register"
              ? "注册后，你创建的 Agent 和运行记录只属于这个账号。"
              : authMode === "token"
                ? "输入管理员预先配置的旧版访问 Token。"
                : "登录后继续使用你自己的 Agent 和工作区。"}
          </p>
          <div className="auth-mode-tabs" role="tablist" aria-label="登录方式">
            <button
              type="button"
              className={authMode === "login" ? "active" : ""}
              onClick={() => { setAuthMode("login"); setError(null); }}
            >
              登录
            </button>
            <button
              type="button"
              className={authMode === "register" ? "active" : ""}
              onClick={() => { setAuthMode("register"); setError(null); }}
            >
              注册
            </button>
          </div>
          {error && <div className="error-banner" role="alert">{error}</div>}
          {accountMode ? (
            <>
              <label>
                用户名
                <input
                  autoFocus
                  value={authName}
                  onChange={(event) => setAuthName(event.target.value)}
                  autoComplete="username"
                  minLength={2}
                  maxLength={80}
                  required
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  value={authPassword}
                  onChange={(event) => setAuthPassword(event.target.value)}
                  autoComplete={authMode === "register" ? "new-password" : "current-password"}
                  minLength={8}
                  maxLength={128}
                  required
                />
                <span className="field-help">至少 8 个字符</span>
              </label>
            </>
          ) : (
            <label>
              旧版访问 Token
              <input
                autoFocus
                type="password"
                value={authInput}
                onChange={(event) => setAuthInput(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
          )}
          <button
            className="button button-primary"
            disabled={
              busy ||
              (accountMode
                ? authName.trim().length < 2 || authPassword.length < 8
                : !authInput.trim())
            }
          >
            {busy ? <Spinner /> : authMode === "register" ? "创建账号并进入" : "进入工作区"}
          </button>
          {legacyTokenEnabled && (
            <button
              type="button"
              className="auth-secondary-action"
              onClick={() => {
                setAuthMode(authMode === "token" ? "login" : "token");
                setError(null);
              }}
            >
              {authMode === "token" ? "返回账号登录" : "使用旧版访问 Token"}
            </button>
          )}
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>{developerView ? "Glass Box Console" : "Agent Launchpad"}</strong>
            <span>{developerView ? "Agent execution observability" : "Agent workspace"}</span>
          </div>
        </div>

        {developerView && (
          <nav className="mode-navigation" aria-label="Developer navigation">
            <a href="/" target="_blank" rel="noreferrer">
              Agent Workspace <span className="ui-chevron" aria-hidden="true">›</span>
            </a>
            <a className="active" href="/developer">
              Developer Console
            </a>
          </nav>
        )}

        {!developerView && (
          <button
            className="button button-primary create-button"
            onClick={() => {
              setForm(emptyForm);
              setShowCreate(true);
            }}
          >
            <span>＋</span> Create Agent
          </button>
        )}

        {developerView && developerAccess && (
          <>
            <button
              type="button"
              className={
                "developer-overview-link " +
                (developerLevel === "users" ? "active" : "")
              }
              onClick={showDeveloperUsers}
            >
              <span>All users</span>
              <strong>{developerUsers.length}</strong>
            </button>
            {selectedDeveloperUser && developerLevel !== "users" && (
              <button
                type="button"
                className={
                  "developer-selected-user " +
                  (developerLevel === "user" ? "active" : "")
                }
                onClick={() => inspectDeveloperUser(selectedDeveloperUser.id)}
              >
                <span>Selected user</span>
                <strong>{selectedDeveloperUser.name}</strong>
                <small>
                  {selectedDeveloperUser.agentCount} Agents · {selectedDeveloperUser.runCount} runs
                </small>
              </button>
            )}
          </>
        )}
        {(!developerView ||
          (developerAccess && developerLevel !== "users" && selectedUserId)) && (
          <>
            <div className="sidebar-label">
              <span>{developerView ? "Agents" : "Your Agents"}</span>
              <span>{agents.length}</span>
            </div>
            <nav className="agent-list">
              {agents.map((agent) => (
                <button
                  className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
                  key={agent.id}
                  onClick={() =>
                    developerView ? inspectDeveloperAgent(agent.id) : setSelectedId(agent.id)
                  }
                >
                  <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
                  <div className="agent-card-copy">
                    <strong>{agent.name}</strong>
                    <span>{agent.description || "Coding Agent"}</span>
                  </div>
                  <span className={"mini-dot mini-" + agent.status} />
                </button>
              ))}
              {agents.length === 0 && (
                <div className="empty-sidebar">
                  <span>◇</span>
                  {developerView
                    ? "This user has no Agents yet."
                    : "Create your first coding Agent."}
                </div>
              )}
            </nav>
          </>
        )}

        <div className="runtime-card">
          {developerView ? (
            <>
              <span className="eyebrow">Runtime</span>
              <strong>{system?.runtime ?? "Checking…"}</strong>
              <span>
                {system?.arkModel ?? "Ark model not configured"}
                {system?.containerEngine ? " · " + system.containerEngine : ""}
              </span>
            </>
          ) : (
            <>
              <span className="eyebrow">Workspace</span>
              <strong>Agent interface</strong>
              <span className="runtime-user">
                {currentUser ? "Signed in as " + currentUser.name : "Tasks, messages, and results"}
              </span>
              <button
                type="button"
                className="runtime-sign-out"
                onClick={() => void signOut()}
                disabled={busy}
              >
                退出登录
              </button>
            </>
          )}
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {developerView && developerAccess && developerLevel === "users" ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>Glass Box Console</h1>
                  <StatusPill status="ready" />
                </div>
                <p>All users, Agents, runs, and failures in one developer view.</p>
              </div>
              <a className="button button-ghost" href="/" target="_blank" rel="noreferrer">
                Open Agent Workspace <span className="ui-chevron" aria-hidden="true">›</span>
              </a>
            </header>
            <section className="playground developer-playground developer-directory">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Developer overview</span>
                  <h2>Users and Agent activity</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" /> Developer access
                </div>
              </div>
              <section className="developer-user-overview" aria-label="All users overview">
                <div className="observability-heading">
                  <div>
                    <span className="eyebrow">All users</span>
                    <h3>{formatNumber(developerTotals.users)} registered users</h3>
                  </div>
                  <span>Updates automatically</span>
                </div>
                <dl className="observability-kpis developer-global-kpis">
                  <div
                    className={
                      "developer-summary-kpi " +
                      (developerOverviewPanel === "users" ? "active" : "")
                    }
                    role="button"
                    tabIndex={0}
                    aria-expanded={developerOverviewPanel === "users"}
                    onClick={() => toggleDeveloperOverviewPanel("users")}
                    onKeyDown={(event) => toggleDeveloperOverviewOnKey(event, "users")}
                  >
                    <dt>Users</dt>
                    <dd>{formatNumber(developerTotals.users)}</dd>
                    <small>
                      Registered accounts · {developerOverviewPanel === "users" ? "Hide details" : "View details"}
                      <span className={"summary-chevron " + (developerOverviewPanel === "users" ? "expanded" : "")} aria-hidden="true">›</span>
                    </small>
                  </div>
                  <div
                    className={
                      "developer-summary-kpi " +
                      (developerOverviewPanel === "agents" ? "active" : "")
                    }
                    role="button"
                    tabIndex={0}
                    aria-expanded={developerOverviewPanel === "agents"}
                    onClick={() => toggleDeveloperOverviewPanel("agents")}
                    onKeyDown={(event) => toggleDeveloperOverviewOnKey(event, "agents")}
                  >
                    <dt>Agents</dt>
                    <dd>{formatNumber(developerTotals.agents)}</dd>
                    <small>
                      Across all users · {developerOverviewPanel === "agents" ? "Hide details" : "View details"}
                      <span className={"summary-chevron " + (developerOverviewPanel === "agents" ? "expanded" : "")} aria-hidden="true">›</span>
                    </small>
                  </div>
                  <div
                    className={
                      "developer-summary-kpi " +
                      (developerOverviewPanel === "runs" ? "active" : "")
                    }
                    role="button"
                    tabIndex={0}
                    aria-expanded={developerOverviewPanel === "runs"}
                    onClick={() => toggleDeveloperOverviewPanel("runs")}
                    onKeyDown={(event) => toggleDeveloperOverviewOnKey(event, "runs")}
                  >
                    <dt>Total runs</dt>
                    <dd>{formatNumber(developerTotals.runs)}</dd>
                    <small>
                      Recorded executions · {developerOverviewPanel === "runs" ? "Hide details" : "View details"}
                      <span className={"summary-chevron " + (developerOverviewPanel === "runs" ? "expanded" : "")} aria-hidden="true">›</span>
                    </small>
                  </div>
                  <div
                    className={
                      "developer-summary-kpi " +
                      (developerOverviewPanel === "failures" ? "active" : "")
                    }
                    role="button"
                    tabIndex={0}
                    aria-expanded={developerOverviewPanel === "failures"}
                    onClick={() => toggleDeveloperOverviewPanel("failures")}
                    onKeyDown={(event) => toggleDeveloperOverviewOnKey(event, "failures")}
                  >
                    <dt>Failed runs</dt>
                    <dd>{formatNumber(developerTotals.failedRuns)}</dd>
                    <small>
                      Need attention · {developerOverviewPanel === "failures" ? "Hide details" : "View details"}
                      <span className={"summary-chevron " + (developerOverviewPanel === "failures" ? "expanded" : "")} aria-hidden="true">›</span>
                    </small>
                  </div>
                </dl>
                {developerError && (
                  <div className="error-banner" role="alert">{developerError}</div>
                )}
                {developerOverviewPanel === "users" && (
                  <section className="developer-overview-detail">
                    <div className="developer-overview-detail-heading">
                      <div>
                        <span className="eyebrow">Users</span>
                        <h4>Registered user accounts</h4>
                      </div>
                      <span>{developerUsers.length} users</span>
                    </div>
                    <label className="developer-user-search">
                      <span>Search users</span>
                      <input
                        type="search"
                        value={developerUserSearch}
                        onChange={(event) => setDeveloperUserSearch(event.target.value)}
                        placeholder="Search by username…"
                      />
                    </label>
                    <div className="developer-user-grid">
                      {filteredDeveloperUsers.map((user) => (
                        <button
                          type="button"
                          className="developer-user-card"
                          key={user.id}
                          onClick={() => inspectDeveloperUser(user.id)}
                        >
                          <span className="developer-user-avatar">
                            {user.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="developer-user-card-copy">
                            <strong>{user.name}</strong>
                            <small>
                              {user.agentCount} Agents · {user.runCount} runs · {user.failedRunCount} failed
                            </small>
                          </span>
                          <span className="ui-chevron" aria-hidden="true">›</span>
                        </button>
                      ))}
                    </div>
                    {filteredDeveloperUsers.length === 0 && (
                      <p className="developer-directory-empty">
                        {developerUsers.length === 0
                          ? "No users have registered yet."
                          : "No username matches this search."}
                      </p>
                    )}
                  </section>
                )}
                {developerOverviewPanel === "agents" && (
                  <section className="developer-overview-detail">
                    <div className="developer-overview-detail-heading">
                      <div>
                        <span className="eyebrow">Agents</span>
                        <h4>All Agent workspaces</h4>
                      </div>
                      <span>{developerAgentInventory.length} Agents</span>
                    </div>
                    <label className="developer-table-search">
                      <span>Search Agents</span>
                      <input
                        type="search"
                        value={developerAgentSearch}
                        onChange={(event) => setDeveloperAgentSearch(event.target.value)}
                        placeholder="Search by Agent name, user, status, or ID…"
                      />
                    </label>
                    <div className="developer-data-table-wrap">
                      <table className="developer-data-table">
                        <thead>
                          <tr>
                            <th>Agent name</th>
                            <th>User</th>
                            <th>Status</th>
                            <th>Runs</th>
                            <th>Last updated</th>
                            <th><span className="visually-hidden">Action</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredDeveloperAgents.map((agent) => {
                            const owner = developerUserById.get(agent.ownerUserId);
                            const runCount = developerRunInventory.filter(
                              (run) => run.agentId === agent.id,
                            ).length;
                            return (
                              <tr
                                key={agent.id}
                                onClick={() => inspectDeveloperAgent(agent.id)}
                              >
                                <td><strong>{agent.name}</strong></td>
                                <td>{owner?.name ?? "Unknown user"}</td>
                                <td>
                                  <span className={"developer-table-status status-" + agent.status}>
                                    {agent.status}
                                  </span>
                                </td>
                                <td>{formatNumber(runCount)}</td>
                                <td>{formatDateTime(agent.updatedAt)}</td>
                                <td className="developer-table-action">
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      inspectDeveloperAgent(agent.id);
                                    }}
                                    aria-label={"View " + agent.name + " details"}
                                  >
                                    View <span className="ui-chevron" aria-hidden="true">›</span>
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {filteredDeveloperAgents.length === 0 && (
                      <p className="developer-directory-empty">No Agents match this search.</p>
                    )}
                  </section>
                )}
                {developerOverviewPanel === "runs" && (
                  <section className="developer-overview-detail">
                    <div className="developer-overview-detail-heading">
                      <div>
                        <span className="eyebrow">Runs</span>
                        <h4>Run activity by user</h4>
                      </div>
                      <span>{developerTotals.runs} total runs</span>
                    </div>
                    <label className="developer-table-search">
                      <span>Search runs</span>
                      <input
                        type="search"
                        value={developerRunSearch}
                        onChange={(event) => setDeveloperRunSearch(event.target.value)}
                        placeholder="Search by user, Agent, status, or Run ID…"
                      />
                    </label>
                    <div className="developer-data-table-wrap">
                      <table className="developer-data-table">
                        <thead>
                          <tr>
                            <th>Run ID</th>
                            <th>Started</th>
                            <th>User</th>
                            <th>Agent</th>
                            <th>Status</th>
                            <th>Duration</th>
                            <th><span className="visually-hidden">Action</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredDeveloperRuns.map(({ run, agent, owner }) => (
                            <tr
                              key={run.id}
                              onClick={() => agent && inspectDeveloperAgent(agent.id)}
                            >
                              <td><code>{shortId(run.id)}</code></td>
                              <td>{formatDateTime(run.startedAt ?? run.createdAt)}</td>
                              <td>{owner?.name ?? "Unknown user"}</td>
                              <td><strong>{agent?.name ?? "Deleted Agent"}</strong></td>
                              <td>
                                <span className={"developer-table-status run-status-" + run.status}>
                                  {run.status}
                                </span>
                              </td>
                              <td>{formatDuration(runDuration(run))}</td>
                              <td className="developer-table-action">
                                {agent && (
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      inspectDeveloperAgent(agent.id);
                                    }}
                                    aria-label={"View " + agent.name + " details"}
                                  >
                                    View <span className="ui-chevron" aria-hidden="true">›</span>
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {filteredDeveloperRuns.length === 0 && (
                      <p className="developer-directory-empty">No runs match this search.</p>
                    )}
                  </section>
                )}
                {developerOverviewPanel === "failures" && (
                  <section className="developer-overview-detail developer-failure-detail">
                    <div className="developer-overview-detail-heading">
                      <div>
                        <span className="eyebrow">Failures</span>
                        <h4>Users with failed runs</h4>
                      </div>
                      <span>{developerTotals.failedRuns} failed runs</span>
                    </div>
                    <label className="developer-table-search">
                      <span>Search failures</span>
                      <input
                        type="search"
                        value={developerFailureSearch}
                        onChange={(event) => setDeveloperFailureSearch(event.target.value)}
                        placeholder="Search by error type, user, Agent, or Run ID…"
                      />
                    </label>
                    <div className="developer-data-table-wrap">
                      <table className="developer-data-table developer-failure-table">
                        <thead>
                          <tr>
                            <th>Run ID</th>
                            <th>Error type</th>
                            <th>User</th>
                            <th>Agent</th>
                            <th>Time</th>
                            <th>Error</th>
                            <th><span className="visually-hidden">Action</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredDeveloperFailures.map(({ run, agent, owner }) => (
                            <tr
                              key={run.id}
                              onClick={() => agent && inspectDeveloperAgent(agent.id)}
                            >
                              <td><code>{shortId(run.id)}</code></td>
                              <td>
                                <span className="developer-error-type">{runErrorType(run)}</span>
                              </td>
                              <td>{owner?.name ?? "Unknown user"}</td>
                              <td><strong>{agent?.name ?? "Deleted Agent"}</strong></td>
                              <td>{formatDateTime(run.completedAt ?? run.createdAt)}</td>
                              <td className="developer-error-message" title={run.error ?? undefined}>
                                {run.error ?? (run.status === "cancelled" ? "Run cancelled" : "No error details")}
                              </td>
                              <td className="developer-table-action">
                                {agent && (
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      inspectDeveloperAgent(agent.id);
                                    }}
                                    aria-label={"View " + agent.name + " failure details"}
                                  >
                                    View <span className="ui-chevron" aria-hidden="true">›</span>
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {filteredDeveloperFailures.length === 0 && (
                      <p className="developer-directory-empty">
                        {developerTotals.failedRuns === 0
                          ? "No failed runs need attention."
                          : "No failures match this search."}
                      </p>
                    )}
                  </section>
                )}
              </section>
            </section>
          </>
        ) : developerView &&
          developerAccess &&
          developerLevel === "user" &&
          selectedDeveloperUser ? (
          <>
            <header className="agent-header">
              <div>
                <button
                  type="button"
                  className="developer-back-link"
                  onClick={showDeveloperUsers}
                >
                  <span className="ui-chevron" aria-hidden="true">‹</span> All users
                </button>
                <div className="header-title-row">
                  <h1>{selectedDeveloperUser.name}</h1>
                  <StatusPill status="ready" />
                </div>
                <p>
                  {selectedDeveloperUser.agentCount} Agents · {selectedDeveloperUser.runCount} runs · {selectedDeveloperUser.failedRunCount} failed
                </p>
              </div>
              <a className="button button-ghost" href="/" target="_blank" rel="noreferrer">
                Open Agent Workspace <span className="ui-chevron" aria-hidden="true">›</span>
              </a>
            </header>
            <section className="playground developer-playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">User overview</span>
                  <h2>{selectedDeveloperUser.name}&apos;s Agents and execution summary</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" /> Developer access
                </div>
              </div>
              {developerAnalytics ? (
                <section className="observability-overview" aria-label="Execution overview">
                  <div className="observability-heading">
                    <div>
                      <span className="eyebrow">Visual overview</span>
                      <h3>{selectedDeveloperUser.name} · execution summary</h3>
                    </div>
                    <span>Updates automatically</span>
                  </div>
                  <dl className="observability-kpis">
                    <div>
                      <dt>Agents</dt>
                      <dd>{formatNumber(selectedDeveloperUser.agentCount)}</dd>
                      <small>Owned by this user</small>
                    </div>
                    <div>
                      <dt>Total runs</dt>
                      <dd>{formatNumber(developerAnalytics.totalRuns)}</dd>
                      <small>{formatNumber(developerAnalytics.completedRunCount)} completed</small>
                    </div>
                    <div>
                      <dt>Success rate</dt>
                      <dd>{formatPercent(developerAnalytics.successRate)}</dd>
                      <small>{formatNumber(developerAnalytics.failedRunCount)} failed</small>
                    </div>
                    <div>
                      <dt>Model tokens</dt>
                      <dd>{formatNumber(developerAnalytics.inputTokens + developerAnalytics.outputTokens)}</dd>
                      <small>{formatNumber(developerAnalytics.cachedInputTokens)} cached</small>
                    </div>
                  </dl>
                  <div className="agent-comparison">
                    <div>
                      <h4>Agents</h4>
                      <p>Select an Agent to open its runs and complete Trace.</p>
                    </div>
                    {developerAnalytics.agents.length === 0 ? (
                      <p className="analytics-empty">No Agent activity for this user yet.</p>
                    ) : (
                      <div className="agent-metric-list">
                        {developerAnalytics.agents.map((agent) => (
                          <button
                            className="agent-metric-row"
                            key={agent.agentId}
                            onClick={() => inspectDeveloperAgent(agent.agentId)}
                            type="button"
                          >
                            <span className="agent-metric-name">{agent.agentName}</span>
                            <span className="agent-metric-track" aria-hidden="true">
                              <span
                                className="agent-metric-fill"
                                style={{ width: (agent.runCount / agentRunMaximum) * 100 + "%" }}
                              />
                            </span>
                            <span className="agent-metric-value">{agent.runCount}</span>
                            <span className="agent-metric-status">
                              {agent.completedRunCount} ok · {agent.failedRunCount} failed
                            </span>
                            <span className="agent-metric-action">
                              View details <span className="ui-chevron" aria-hidden="true">›</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              ) : (
                <div className="developer-overview-loading"><Spinner /> Loading user activity…</div>
              )}
            </section>
          </>
        ) : selected ? (
          <>
            {developerView && <div ref={developerDetail} className="developer-agent-detail-anchor" />}
            <header className="agent-header">
              <div>
                {developerView && selectedDeveloperUser && (
                  <button
                    type="button"
                    className="developer-back-link"
                    onClick={() => inspectDeveloperUser(selectedDeveloperUser.id)}
                  >
                    <span className="ui-chevron" aria-hidden="true">‹</span>{" "}
                    {selectedDeveloperUser.name}&apos;s Agents
                  </button>
                )}
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>
                  {developerView
                    ? "Inspecting " + selected.name +
                      (selectedDeveloperUser ? " for " + selectedDeveloperUser.name : "") +
                      " · model calls, tool use, file changes, and failures"
                    : selected.description || "A Codex coding Agent in an isolated workspace."}
                </p>
              </div>
              <div className="header-actions">
                {developerView ? (
                  <a className="button button-ghost" href="/" target="_blank" rel="noreferrer">
                    Open Agent Workspace <span className="ui-chevron" aria-hidden="true">›</span>
                  </a>
                ) : (
                  <>
                    <button
                      className="button button-ghost"
                      onClick={() => setShowSettings((value) => !value)}
                      disabled={busy || selected.status === "busy"}
                    >
                      Settings
                    </button>
                    <button
                      className="button button-ghost"
                      onClick={toggleAgent}
                      disabled={busy}
                    >
                      {selected.status === "stopped" ? "Start" : "Stop"}
                    </button>
                    <button
                      className="button button-danger"
                      onClick={deleteAgent}
                      disabled={busy || selected.status === "busy"}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </header>

            {!developerView && showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className={"playground " + (developerView ? "developer-playground" : "")}>
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">{developerView ? "Execution observability" : "Playground"}</span>
                  <h2>
                    {developerView
                      ? "Agent traces, diagnostics, and audit records"
                      : "Build something with your Agent"}
                  </h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {developerView
                    ? developerAccess
                      ? "Developer access"
                      : "Console locked"
                    : selected.codexThreadId
                      ? "Session connected"
                      : "New session"}
                </div>
              </div>

              {developerView && !developerAccess && (
                <form className="developer-lock" onSubmit={unlockDeveloper}>
                  <div className="brand-mark">G</div>
                  <span className="eyebrow">Restricted telemetry</span>
                  <h3>Unlock the Developer Console</h3>
                  <p>
                    Trace details, token usage, file paths, and exports are available only
                    to authorized developers and operators.
                  </p>
                  {developerConfigured === false ? (
                    <div className="error-banner" role="alert">
                      TRACE_VIEWER_TOKEN is not configured. Restart the platform with a
                      developer token.
                    </div>
                  ) : (
                    <>
                      {developerError && (
                        <div className="error-banner" role="alert">{developerError}</div>
                      )}
                      <label>
                        Developer Console token
                        <input
                          autoFocus
                          type="password"
                          value={developerInput}
                          onChange={(event) => setDeveloperInput(event.target.value)}
                          autoComplete="off"
                          required
                        />
                      </label>
                      <button
                        className="button button-primary"
                        disabled={busy || !developerInput.trim()}
                      >
                        {busy ? <Spinner /> : "Open Developer Console"}
                      </button>
                    </>
                  )}
                </form>
              )}

              {developerView &&
                developerAccess &&
                developerLevel === "user" &&
                developerAnalytics && (
                <section className="observability-overview" aria-label="Execution overview">
                  <div className="observability-heading">
                    <div>
                      <span className="eyebrow">Visual overview</span>
                      <h3>
                        {selectedDeveloperUser?.name ?? "Selected user"} · execution summary
                      </h3>
                    </div>
                    <span>Updates automatically</span>
                  </div>
                  <dl className="observability-kpis">
                    <div>
                      <dt>Total runs</dt>
                      <dd>{formatNumber(developerAnalytics.totalRuns)}</dd>
                      <small>{formatNumber(developerAnalytics.completedRunCount)} completed</small>
                    </div>
                    <div>
                      <dt>Success rate</dt>
                      <dd>{formatPercent(developerAnalytics.successRate)}</dd>
                      <small>{formatNumber(developerAnalytics.failedRunCount)} failed</small>
                    </div>
                    <div>
                      <dt>Average duration</dt>
                      <dd>{formatDuration(developerAnalytics.averageDurationMs)}</dd>
                      <small>Completed and failed runs</small>
                    </div>
                    <div>
                      <dt>Model tokens</dt>
                      <dd>{formatNumber(developerAnalytics.inputTokens + developerAnalytics.outputTokens)}</dd>
                      <small>{formatNumber(developerAnalytics.cachedInputTokens)} cached</small>
                    </div>
                  </dl>
                  <div className="agent-comparison">
                    <div>
                      <h4>Agent run comparison</h4>
                      <p>Bar length represents the number of runs. Select an Agent in the sidebar to inspect its Trace.</p>
                    </div>
                    {developerAnalytics.agents.length === 0 ? (
                      <p className="analytics-empty">No Agent activity for this user yet.</p>
                    ) : (
                      <div className="agent-metric-list">
                        {developerAnalytics.agents.slice(0, 6).map((agent) => (
                          <button
                            className="agent-metric-row"
                            key={agent.agentId}
                            onClick={() => inspectDeveloperAgent(agent.agentId)}
                            type="button"
                          >
                            <span className="agent-metric-name">{agent.agentName}</span>
                            <span className="agent-metric-track" aria-hidden="true">
                              <span
                                className="agent-metric-fill"
                                style={{ width: (agent.runCount / agentRunMaximum) * 100 + "%" }}
                              />
                            </span>
                            <span className="agent-metric-value">{agent.runCount}</span>
                            <span className="agent-metric-status">
                              {agent.completedRunCount} ok · {agent.failedRunCount} failed
                            </span>
                            <span className="agent-metric-action">
                              View details <span className="ui-chevron" aria-hidden="true">›</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              )}

              {developerView && developerAccess && !activeRun && (
                <div className="developer-empty">
                  <span className="eyebrow">No Runs yet</span>
                  <h3>Run an Agent task to collect telemetry.</h3>
                  <a className="button button-primary" href="/" target="_blank" rel="noreferrer">
                    Open Agent Workspace <span className="ui-chevron" aria-hidden="true">›</span>
                  </a>
                </div>
              )}

              {developerView && developerAccess && activeRun && (
                <section className="trace-panel" aria-label="Run trace">
                  <div className="trace-heading">
                    <div>
                      <span className="eyebrow">Glass Box · Agent detail</span>
                      <h3>{selected.name} · Run trace</h3>
                    </div>
                    <div className="trace-identifiers">
                      <span>{visibleTraces.length} / {traces.length} events</span>
                      <code title={selected.id}>Agent {shortId(selected.id)}</code>
                      <code title={activeRun.id}>Run {shortId(activeRun.id)}</code>
                      {traces[0] && (
                        <code title={traces[0].traceId}>
                          Trace {shortId(traces[0].traceId)}
                        </code>
                      )}
                    </div>
                  </div>
                  <div className="trace-toolbar">
                    <label>
                      Run
                      <select value={activeRun.id} onChange={selectRun}>
                        {runs.map((run) => (
                          <option key={run.id} value={run.id}>
                            {formatTime(run.createdAt)} · {run.status} · {shortId(run.id)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Filter
                      <select
                        value={traceFilter}
                        onChange={(event) => setTraceFilter(event.target.value as TraceFilter)}
                      >
                        <option value="all">All events</option>
                        <option value="lifecycle">Run lifecycle</option>
                        <option value="model">Model</option>
                        <option value="tool">Tools</option>
                        <option value="file">Files</option>
                        <option value="error">Errors only</option>
                      </select>
                    </label>
                    <button
                      className="button button-ghost trace-export"
                      onClick={exportTrace}
                      disabled={traces.length === 0}
                    >
                      Export JSON
                    </button>
                  </div>
                  {activeRun.usage && (
                    <dl className="trace-usage" aria-label="Model token usage">
                      <div>
                        <dt>Input</dt>
                        <dd>{formatNumber(activeRun.usage.inputTokens)} tokens</dd>
                      </div>
                      <div>
                        <dt>Cached</dt>
                        <dd>{formatNumber(activeRun.usage.cachedInputTokens)} tokens</dd>
                      </div>
                      <div>
                        <dt>Output</dt>
                        <dd>{formatNumber(activeRun.usage.outputTokens)} tokens</dd>
                      </div>
                    </dl>
                  )}
                  {traceWaterfall.length > 0 && (
                    <section className="trace-waterfall" aria-label="Trace timeline">
                      <div className="trace-waterfall-heading">
                        <div>
                          <span className="eyebrow">Timing</span>
                          <h4>Trace timeline</h4>
                        </div>
                        <span>Each bar shows when an event occurred and how long it took.</span>
                      </div>
                      <ol>
                        {traceWaterfall.map((event) => (
                          <li key={event.id}>
                            <span>{event.type}</span>
                            <div className="trace-waterfall-track">
                              <span
                                className={
                                  "trace-waterfall-bar trace-waterfall-" +
                                  event.status +
                                  (event.left > 72
                                    ? " trace-waterfall-align-right"
                                    : event.left < 18
                                      ? " trace-waterfall-align-left"
                                      : "")
                                }
                                style={{ marginLeft: event.left + "%", width: event.width + "%" }}
                                tabIndex={0}
                              >
                                <span className="trace-waterfall-duration">
                                  {formatDuration(event.durationMs)}
                                </span>
                                <span className="trace-waterfall-popover" role="tooltip">
                                  <strong>{event.type}</strong>
                                  <span>{event.summary}</span>
                                  <span>
                                    Time: {formatTime(event.timestamp)} · Duration: {formatDuration(event.durationMs)}
                                  </span>
                                  {event.error && <code>{event.error}</code>}
                                </span>
                              </span>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </section>
                  )}
                  {firstTraceError && traceDiagnosis && (
                    <aside className="trace-diagnostic" role="alert">
                      <strong>Failure detected: {firstTraceError.type}</strong>
                      <span>{firstTraceError.error ?? firstTraceError.summary}</span>
                      <div className="trace-diagnosis">
                        <span className="eyebrow">Suggested diagnosis</span>
                        <strong>{traceDiagnosis.title}</strong>
                        <p>{traceDiagnosis.explanation}</p>
                        <p>
                          <b>Next step:</b> {traceDiagnosis.nextStep}
                        </p>
                      </div>
                    </aside>
                  )}
                  {traces.length === 0 ? (
                    <p className="trace-empty">Collecting runtime evidence…</p>
                  ) : visibleTraces.length === 0 ? (
                    <p className="trace-empty">No events match this filter.</p>
                  ) : (
                    <ol className="trace-list">
                      {visibleTraces.map((event) => {
                        const expanded = expandedTraceIds.has(event.id);
                        return (
                          <li
                            className={"trace-item" + (expanded ? " trace-item-expanded" : "")}
                            key={event.id}
                          >
                            <button
                              aria-expanded={expanded}
                              className="trace-item-toggle"
                              onClick={() => toggleTraceEvent(event.id)}
                              type="button"
                            >
                              <span className={"trace-status trace-status-" + event.status} />
                              <span className="trace-item-summary">
                                <span className="trace-meta">
                                  <strong>{event.type}</strong>
                                  <span>{formatTime(event.timestamp)}</span>
                                  <span>{formatDuration(event.durationMs)}</span>
                                </span>
                                <span className="trace-summary-text">{event.summary}</span>
                                <span className="trace-span-ids">
                                  <code title={event.spanId}>Span {shortId(event.spanId)}</code>
                                  {event.parentSpanId && (
                                    <code title={event.parentSpanId}>
                                      Parent {shortId(event.parentSpanId)}
                                    </code>
                                  )}
                                </span>
                                {event.error && <code className="trace-error-preview">{event.error}</code>}
                              </span>
                              <span className="trace-expand-indicator" aria-hidden="true">
                                {expanded ? "−" : "+"}
                              </span>
                            </button>

                            {expanded && (
                              <div className="trace-event-details">
                                <dl>
                                  <div>
                                    <dt>Event type</dt>
                                    <dd>{event.type}</dd>
                                  </div>
                                  <div>
                                    <dt>Status</dt>
                                    <dd>{event.status}</dd>
                                  </div>
                                  <div>
                                    <dt>Exact time</dt>
                                    <dd>{formatDateTime(event.timestamp)}</dd>
                                  </div>
                                  <div>
                                    <dt>Duration</dt>
                                    <dd>{formatDuration(event.durationMs)}</dd>
                                  </div>
                                  <div className="trace-detail-wide">
                                    <dt>Summary</dt>
                                    <dd>{event.summary}</dd>
                                  </div>
                                  <div className="trace-detail-wide">
                                    <dt>Trace ID</dt>
                                    <dd><code>{event.traceId}</code></dd>
                                  </div>
                                  <div className="trace-detail-wide">
                                    <dt>Span ID</dt>
                                    <dd><code>{event.spanId}</code></dd>
                                  </div>
                                  <div className="trace-detail-wide">
                                    <dt>Parent Span ID</dt>
                                    <dd>
                                      {event.parentSpanId ? <code>{event.parentSpanId}</code> : "Root span"}
                                    </dd>
                                  </div>
                                  <div className="trace-detail-wide">
                                    <dt>Run ID</dt>
                                    <dd><code>{event.runId}</code></dd>
                                  </div>
                                  <div className="trace-detail-wide">
                                    <dt>Agent ID</dt>
                                    <dd><code>{event.agentId}</code></dd>
                                  </div>
                                  <div className="trace-detail-wide">
                                    <dt>Event ID</dt>
                                    <dd><code>{event.id}</code></dd>
                                  </div>
                                  {event.error && (
                                    <div className="trace-detail-wide trace-detail-error">
                                      <dt>Error</dt>
                                      <dd><code>{event.error}</code></dd>
                                    </div>
                                  )}
                                </dl>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </section>
              )}

              {!developerView && (
                <>
              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span className="ui-chevron" aria-hidden="true">›</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
                </>
              )}
            </section>
          </>
        ) : (
          <div className="no-agent">
            {developerView && !developerAccess ? (
              <form className="developer-lock" onSubmit={unlockDeveloper}>
                <div className="brand-mark">G</div>
                <span className="eyebrow">Restricted telemetry</span>
                <h3>Unlock the Developer Console</h3>
                <p>
                  Agent traces, token usage, and diagnostics are available only to
                  authorized developers and operators.
                </p>
                {developerConfigured === false ? (
                  <div className="error-banner" role="alert">
                    TRACE_VIEWER_TOKEN is not configured. Restart the platform with a
                    developer token.
                  </div>
                ) : (
                  <>
                    {developerError && (
                      <div className="error-banner" role="alert">{developerError}</div>
                    )}
                    <label>
                      Developer Console token
                      <input
                        autoFocus
                        type="password"
                        value={developerInput}
                        onChange={(event) => setDeveloperInput(event.target.value)}
                        autoComplete="off"
                        required
                      />
                    </label>
                    <button
                      className="button button-primary"
                      disabled={busy || !developerInput.trim()}
                    >
                      {busy ? <Spinner /> : "Open Developer Console"}
                    </button>
                  </>
                )}
              </form>
            ) : (
              <>
                <div className="no-agent-art">A</div>
                <span className="eyebrow">
                  {developerView ? "Glass Box Console" : "Agent Launchpad"}
                </span>
                <h1>
                  {developerView
                    ? "No Agent execution data is available for this user."
                    : "Your runtime is ready for an Agent."}
                </h1>
                <p>
                  {developerView
                    ? "Choose another user or create and run an Agent task first."
                    : "Create a workspace, give Codex a job, and continue the conversation here."}
                </p>
                {developerView ? (
                  <a className="button button-primary" href="/" target="_blank" rel="noreferrer">
                    Open Agent Workspace <span className="ui-chevron" aria-hidden="true">›</span>
                  </a>
                ) : (
                  <button
                    className="button button-primary"
                    onClick={() => {
                      setForm(emptyForm);
                      setShowCreate(true);
                    }}
                  >
                    Create your first Agent
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </main>

      {!developerView && showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
