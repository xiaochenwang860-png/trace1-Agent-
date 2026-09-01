import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  GIT_BIN: z.string().trim().min(1).default("git"),
  GIT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
  GIT_MAX_OUTPUT_BYTES: z.coerce
    .number()
    .int()
    .min(65_536)
    .default(33_554_432),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  TRACE_VIEWER_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(
      /^[A-Za-z0-9._~-]*$/,
      "TRACE_VIEWER_TOKEN must use URL-safe characters",
    )
    .optional(),
  RECOVERY_OPERATOR_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(
      /^[A-Za-z0-9._~-]*$/,
      "RECOVERY_OPERATOR_TOKEN must use URL-safe characters",
    )
    .optional(),
  RECOVERY_OPERATOR_ID: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/, "RECOVERY_OPERATOR_ID must use URL-safe characters")
    .default("local-recovery-operator"),
  APP_USERS_JSON: z.string().optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

const userAccountsSchema = z
  .array(
    z.object({
      id: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9_.-]+$/, "User IDs must use URL-safe characters"),
      name: z.string().trim().min(1).max(80),
      token: z
        .string()
        .trim()
        .min(1)
        .max(128)
        .refine(
          (value) => !/[\r\n]/.test(value),
          "User tokens cannot contain line breaks",
        ),
    }),
  )
  .min(1)
  .superRefine((accounts, context) => {
    const ids = new Set<string>();
    const tokens = new Set<string>();
    accounts.forEach((account, index) => {
      if (ids.has(account.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "User IDs must be unique",
        });
      }
      if (tokens.has(account.token)) {
        context.addIssue({
          code: "custom",
          path: [index, "token"],
          message: "User tokens must be unique",
        });
      }
      ids.add(account.id);
      tokens.add(account.token);
    });
  });

function parseUserAccounts(raw: string | undefined, legacyToken: string) {
  if (raw?.trim()) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("APP_USERS_JSON must be valid JSON");
    }
    return userAccountsSchema.parse(value);
  }
  return [
    {
      id: "local-user",
      name: "Local User",
      token: legacyToken,
    },
  ];
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const traceViewerToken = env.TRACE_VIEWER_TOKEN?.trim() ?? "";
  const recoveryOperatorToken = env.RECOVERY_OPERATOR_TOKEN?.trim() ?? "";
  const arkModel = env.ARK_MODEL?.trim() ?? "";
  if (/^(?:ark|apikey)-/i.test(arkModel)) {
    throw new Error(
      "ARK_MODEL looks like an API key; use an Ark endpoint/model ID such as ep-xxxxxxxx",
    );
  }
  const userAccounts = parseUserAccounts(env.APP_USERS_JSON, authToken);
  if (
    recoveryOperatorToken.length > 0 &&
    (recoveryOperatorToken === traceViewerToken ||
      userAccounts.some((account) => account.token === recoveryOperatorToken))
  ) {
    throw new Error(
      "RECOVERY_OPERATOR_TOKEN must not reuse a Trace viewer or user access token",
    );
  }
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (
      userAccounts.some(
        (account) =>
          account.token.length > 0 &&
          (account.token.length < 24 || account.token.startsWith("replace-")),
      )
    ) {
      throw new Error(
        "Every user access token must contain at least 24 characters for a non-loopback production server",
      );
    }
    if (
      recoveryOperatorToken.length > 0 &&
      (recoveryOperatorToken.length < 24 ||
        recoveryOperatorToken.startsWith("replace-"))
    ) {
      throw new Error(
        "RECOVERY_OPERATOR_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    gitBin: env.GIT_BIN,
    gitTimeoutMs: env.GIT_TIMEOUT_MS,
    gitMaxOutputBytes: env.GIT_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    userAccounts,
    userAuthRequired: userAccounts.some((account) => account.token.length > 0),
    traceViewerToken,
    recoveryOperatorToken,
    recoveryOperatorId: env.RECOVERY_OPERATOR_ID,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel,
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
