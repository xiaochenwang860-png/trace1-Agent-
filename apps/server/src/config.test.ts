import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("recovery operator configuration", () => {
  it("keeps destructive recovery credentials separate from viewer credentials", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        TRACE_VIEWER_TOKEN: "shared-token",
        RECOVERY_OPERATOR_TOKEN: "shared-token",
      }),
    ).toThrow(/must not reuse/);
  });

  it("requires a strong recovery credential on a public production listener", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        RECOVERY_OPERATOR_TOKEN: "too-short",
      }),
    ).toThrow(/at least 24 characters/);
  });
});

describe("Git recovery configuration", () => {
  it("uses bounded Git process defaults", () => {
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({
      gitBin: "git",
      gitTimeoutMs: 30_000,
      gitMaxOutputBytes: 33_554_432,
    });
  });

  it("accepts an explicit Git executable and process limits", () => {
    expect(
      loadConfig({
        NODE_ENV: "test",
        GIT_BIN: "/opt/git/bin/git",
        GIT_TIMEOUT_MS: "45000",
        GIT_MAX_OUTPUT_BYTES: "67108864",
      }),
    ).toMatchObject({
      gitBin: "/opt/git/bin/git",
      gitTimeoutMs: 45_000,
      gitMaxOutputBytes: 67_108_864,
    });
  });

  it("rejects empty executable names and unboundedly small limits", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "test", GIT_BIN: "   " }),
    ).toThrow();
    expect(() =>
      loadConfig({ NODE_ENV: "test", GIT_TIMEOUT_MS: "999" }),
    ).toThrow();
    expect(() =>
      loadConfig({ NODE_ENV: "test", GIT_MAX_OUTPUT_BYTES: "1024" }),
    ).toThrow();
  });
});

describe("Ark model configuration", () => {
  it("rejects API key identifiers in ARK_MODEL", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "test", ARK_MODEL: "apikey-20260901-example" }),
    ).toThrow(/looks like an API key/);
    expect(() =>
      loadConfig({ NODE_ENV: "test", ARK_MODEL: "ark-secret-value" }),
    ).toThrow(/looks like an API key/);
  });

  it("accepts endpoint and direct model identifiers", () => {
    expect(loadConfig({ NODE_ENV: "test", ARK_MODEL: "ep-example" }).arkModel).toBe(
      "ep-example",
    );
    expect(
      loadConfig({ NODE_ENV: "test", ARK_MODEL: "doubao-model-example" }).arkModel,
    ).toBe("doubao-model-example");
  });
});
