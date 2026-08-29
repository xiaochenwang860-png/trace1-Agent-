import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { createTextRedactor } from "./redaction.js";

describe("createTextRedactor", () => {
  it("removes configured and common credential formats", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "ark-private-value-123456",
      ARK_MODEL: "ep-test",
      TRACE_VIEWER_TOKEN: "developer-secret-token",
      APP_AUTH_TOKEN: "legacy-secret-token",
      APP_USERS_JSON: JSON.stringify([
        { id: "alice", name: "Alice", token: "alice-session-token" },
      ]),
    });
    const redact = createTextRedactor(config);
    const source = [
      "ARK_API_KEY=ark-private-value-123456",
      "Bearer developer-secret-token",
      "token=alice-session-token",
      "https://example.test/?access_token=legacy-secret-token",
    ].join("; ");

    const result = redact(source);

    expect(result).toContain("[REDACTED]");
    expect(result).toContain("Bearer [REDACTED_TOKEN]");
    expect(result).not.toContain("ark-private-value-123456");
    expect(result).not.toContain("developer-secret-token");
    expect(result).not.toContain("legacy-secret-token");
    expect(result).not.toContain("alice-session-token");
  });
});
