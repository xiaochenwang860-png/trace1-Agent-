import { describe, expect, it } from "vitest";
import { buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";
import type { RunnerTraceEvent } from "./types.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
      turnStartedAt: null as number | null,
      itemStartedAt: {} as Record<string, number>,
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("emits model lifecycle Trace events", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
      turnStartedAt: null as number | null,
      itemStartedAt: {} as Record<string, number>,
    };
    const traces: RunnerTraceEvent[] = [];
    const collect = (event: RunnerTraceEvent) => traces.push(event);

    parseCodexEventLine(JSON.stringify({ type: "turn.started" }), parsed, collect);
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
      collect,
    );

    expect(traces.map((event) => event.type)).toEqual([
      "model.requested",
      "model.completed",
    ]);
    expect(traces[1]).toMatchObject({
      status: "success",
      durationMs: expect.any(Number),
    });
    expect(traces[0]?.operationId).toBeTruthy();
    expect(traces[1]?.operationId).toBe(traces[0]?.operationId);
  });

  it("emits command and file Trace events without storing file contents", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
      turnStartedAt: null as number | null,
      itemStartedAt: {} as Record<string, number>,
    };
    const traces: RunnerTraceEvent[] = [];
    const collect = (event: RunnerTraceEvent) => traces.push(event);

    parseCodexEventLine(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "command-1",
          type: "command_execution",
          command: "printf secret-content > hello.txt",
        },
      }),
      parsed,
      collect,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "command-1",
          type: "command_execution",
          command: "printf secret-content > hello.txt",
          exit_code: 0,
          status: "completed",
        },
      }),
      parsed,
      collect,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "file-1",
          type: "file_change",
          status: "completed",
          changes: [{ path: "/workspace/hello.txt", kind: "add" }],
        },
      }),
      parsed,
      collect,
    );

    expect(traces.map((event) => event.type)).toEqual([
      "tool.started",
      "tool.completed",
      "file.changed",
    ]);
    expect(traces[2]?.summary).toContain("/workspace/hello.txt");
    expect(traces[2]?.summary).not.toContain("secret-content");
    expect(traces[0]?.summary).not.toContain("secret-content");
    expect(traces[0]?.operationId).toBe("command-1");
    expect(traces[1]?.operationId).toBe("command-1");
  });

  it("does not store credentials from command arguments", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
      turnStartedAt: null as number | null,
      itemStartedAt: {} as Record<string, number>,
    };
    const traces: RunnerTraceEvent[] = [];

    parseCodexEventLine(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "command-2",
          type: "command_execution",
          command: "curl -H 'Authorization: Bearer private-token' API_KEY=private-key",
        },
      }),
      parsed,
      (event) => traces.push(event),
    );

    expect(traces[0]?.summary).toBe("Command execution: curl");
    expect(traces[0]?.summary).not.toContain("private-token");
    expect(traces[0]?.summary).not.toContain("private-key");
  });

  it("emits model failures as soon as Codex reports an error", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
      turnStartedAt: null as number | null,
      itemStartedAt: {} as Record<string, number>,
    };
    const traces: RunnerTraceEvent[] = [];

    parseCodexEventLine(
      JSON.stringify({ type: "turn.started" }),
      parsed,
      (event) => traces.push(event),
    );
    parseCodexEventLine(
      JSON.stringify({ type: "error", message: "upstream connection failed" }),
      parsed,
      (event) => traces.push(event),
    );

    expect(traces).toEqual([
      expect.objectContaining({
        type: "model.requested",
      }),
      expect.objectContaining({
        type: "model.failed",
        status: "error",
        error: "upstream connection failed",
      }),
    ]);
    expect(traces[1]?.operationId).toBe(traces[0]?.operationId);
  });
});
