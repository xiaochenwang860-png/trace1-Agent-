import type { AppConfig } from "./config.js";

export type TextRedactor = (value: string) => string;

/** Removes configured and recognisable credentials before data is persisted or returned. */
export function createTextRedactor(
  config: Pick<
    AppConfig,
    "arkApiKey" | "traceViewerToken" | "authToken" | "userAccounts"
  >,
): TextRedactor {
  const configuredSecrets = [
    [config.arkApiKey, "[REDACTED_API_KEY]"],
    [config.traceViewerToken, "[REDACTED_TOKEN]"],
    [config.authToken, "[REDACTED_TOKEN]"],
    ...config.userAccounts.map(
      (account) => [account.token, "[REDACTED_TOKEN]"] as const,
    ),
  ]
    .filter(([value]) => value.length > 0)
    .sort(([left], [right]) => right.length - left.length);

  return (value: string): string => {
    let redacted = value;
    for (const [secret, replacement] of configuredSecrets) {
      redacted = redacted.split(secret).join(replacement);
    }
    return redacted
      .replace(/\bark-[A-Za-z0-9._~-]{8,}\b/gi, "[REDACTED_API_KEY]")
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED_TOKEN]")
      .replace(
        /((?:ARK_API_KEY|API[_ -]?KEY|TRACE_VIEWER_TOKEN|APP_AUTH_TOKEN|ACCESS_TOKEN|TOKEN|PASSWORD|PASSPHRASE)\s*[=:]\s*)[^\s,;]+/gi,
        "$1[REDACTED]",
      )
      .replace(
        /([?&](?:api[_-]?key|access_token|token|password)=)[^&#\s]+/gi,
        "$1[REDACTED]",
      );
  };
}

export function redactNullable(
  redact: TextRedactor,
  value: string | null,
): string | null {
  return value === null ? null : redact(value);
}
