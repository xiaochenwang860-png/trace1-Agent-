import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSafeBaseUrl,
  assertSystemReady,
  applyCrossRunChecks,
  collectTraceStream,
  expandMatrix,
  runPool,
  validateTrace,
} from "./run-demo-matrix.mjs";

function event(id, sequence, type, spanId, parentSpanId) {
  return {
    id,
    traceId: "run-1",
    spanId,
    parentSpanId,
    sequence,
    runId: "run-1",
    agentId: "agent-1",
    type,
    status: type.endsWith("failed") ? "error" : "info",
    timestamp: new Date(sequence).toISOString(),
    durationMs: null,
    summary: type,
    error: null,
  };
}

const validTrace = [
  event("event-1", 1, "run.started", "run-span", null),
  event("event-2", 2, "runtime.started", "runtime-span", "run-span"),
  event("event-3", 3, "model.requested", "model-span", "runtime-span"),
  event("event-4", 4, "tool.started", "tool-span", "model-span"),
  event("event-5", 5, "tool.completed", "tool-span", "model-span"),
  event("event-6", 6, "model.completed", "model-span", "runtime-span"),
  event("event-7", 7, "run.completed", "terminal-span", "run-span"),
];

test("expandMatrix expands copies and rejects unknown selections", () => {
  const matrix = {
    version: 1,
    defaults: { timeoutMs: 20_000 },
    cases: [
      {
        id: "sample",
        name: "Sample",
        copies: 2,
        prompt: "Run a sample",
        expected: { statuses: ["completed"], requiredEvents: ["run.completed"] },
      },
    ],
  };
  assert.deepEqual(
    expandMatrix(matrix).map((job) => [job.id, job.copy, job.timeoutMs]),
    [
      ["sample", 1, 20_000],
      ["sample", 2, 20_000],
    ],
  );
  assert.throws(() => expandMatrix(matrix, ["missing"]), /Unknown --case ID/);
});

test("the checked-in default matrix is valid", async () => {
  const matrixPath = fileURLToPath(new URL("./demo-matrix.json", import.meta.url));
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  assert.equal(expandMatrix(matrix).length, 6);
});

test("assertSystemReady fails fast when model or Runtime prerequisites are missing", () => {
  const ready = {
    arkConfigured: true,
    codexAvailable: true,
    runtimeProvider: "container",
  };
  assert.equal(assertSystemReady(ready), ready);
  assert.throws(
    () => assertSystemReady({ ...ready, arkConfigured: false }),
    /Ark model configuration/,
  );
  assert.throws(
    () => assertSystemReady({ ...ready, codexAvailable: false }),
    /Codex Runtime/,
  );
});

test("assertSafeBaseUrl blocks credentials over non-loopback HTTP", () => {
  assert.equal(assertSafeBaseUrl("http://127.0.0.1:3000").hostname, "127.0.0.1");
  assert.equal(assertSafeBaseUrl("http://localhost:3000").hostname, "localhost");
  assert.equal(assertSafeBaseUrl("https://demo.example.com").protocol, "https:");
  assert.throws(
    () => assertSafeBaseUrl("http://demo.example.com"),
    /Refusing to send demo credentials/,
  );
});

test("validateTrace accepts correlated and ordered lifecycle events", () => {
  const validation = validateTrace(
    validTrace,
    { id: "run-1", status: "completed" },
    {
      statuses: ["completed"],
      requiredEvents: ["run.started", "tool.started", "tool.completed", "run.completed"],
    },
  );
  assert.equal(validation.passed, true);
});

test("validateTrace detects duplicate delivery and sequence gaps", () => {
  const traceWithGap = validTrace.map((item) => ({ ...item }));
  traceWithGap[4].sequence = 8;
  const validation = validateTrace(
    traceWithGap,
    { id: "run-1", status: "completed" },
    { statuses: ["completed"], requiredEvents: ["run.completed"] },
    {
      events: [...validTrace, validTrace[3]],
      liveEventIds: [],
    },
  );
  assert.equal(validation.passed, false);
  assert.deepEqual(
    validation.checks.filter((check) => !check.passed).map((check) => check.name),
    ["no-stream-duplicates", "stream-sequence", "continuous-sequence"],
  );
});

test("validateTrace rejects orphan, duplicate, and unclosed Span lifecycles", () => {
  const run = {
    id: "run-1",
    status: "completed",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(10).toISOString(),
  };
  const expected = { statuses: ["completed"], requiredEvents: ["run.completed"] };
  const cases = [
    [
      ...validTrace.filter((item) => item.type !== "tool.completed"),
    ],
    [
      ...validTrace.filter((item) => item.type !== "tool.started"),
    ],
    [
      ...validTrace,
      { ...validTrace[4], id: "event-8", sequence: 8, type: "tool.failed" },
    ],
  ];
  for (const trace of cases) {
    const ordered = trace
      .map((item, index) => ({ ...item, sequence: index + 1 }))
      .sort((left, right) => left.sequence - right.sequence);
    const validation = validateTrace(ordered, run, expected);
    assert.equal(validation.passed, false);
    assert.ok(
      validation.checks.some((check) => check.name === "stable-tool-span" && !check.passed),
    );
  }
});

test("validateTrace requires configured events to arrive on the live stream", () => {
  const validation = validateTrace(
    validTrace,
    {
      id: "run-1",
      status: "completed",
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(10).toISOString(),
    },
    {
      statuses: ["completed"],
      requiredEvents: ["run.completed"],
      requiredLiveEvents: ["tool.completed"],
    },
    { events: validTrace, liveEventIds: [] },
  );
  assert.equal(validation.passed, false);
  assert.equal(
    validation.checks.find((check) => check.name === "required-live-events")?.passed,
    false,
  );
});

test("validateTrace rejects incomplete or cross-Run stream delivery", () => {
  const streamed = validTrace
    .filter((item) => item.type !== "runtime.started")
    .map((item) => ({ ...item }));
  streamed[2] = { ...streamed[2], runId: "another-run", traceId: "another-run" };
  const validation = validateTrace(
    validTrace,
    { id: "run-1", status: "completed" },
    { statuses: ["completed"], requiredEvents: ["run.completed"] },
    { events: streamed, liveEventIds: [] },
  );
  assert.equal(validation.passed, false);
  assert.equal(
    validation.checks.find((check) => check.name === "stream-isolation")?.passed,
    false,
  );
  assert.equal(
    validation.checks.find((check) => check.name === "stream-completeness")?.passed,
    false,
  );
});

test("validateTrace requires one matching terminal event at the end", () => {
  const mismatched = validTrace.map((item) =>
    item.type === "run.completed" ? { ...item, type: "run.failed" } : item,
  );
  const validation = validateTrace(
    mismatched,
    { id: "run-1", status: "completed" },
    { statuses: ["completed"], requiredEvents: ["run.failed"] },
  );
  assert.equal(validation.passed, false);
  assert.equal(
    validation.checks.find((check) => check.name === "terminal-event")?.passed,
    false,
  );
});

test("runPool respects the configured concurrency and preserves result order", async () => {
  let active = 0;
  let maximumActive = 0;
  const results = await runPool([30, 5, 20, 10], 2, async (delay, index) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return `job-${index}`;
  });
  assert.equal(maximumActive, 2);
  assert.deepEqual(results, ["job-0", "job-1", "job-2", "job-3"]);
});

test("applyCrossRunChecks rejects Run and event IDs reused by separate jobs", () => {
  const results = [0, 1].map((index) => ({
    runId: "run-shared",
    trace: [{ id: "event-shared" }],
    validation: { passed: true, checks: [] },
    index,
  }));
  applyCrossRunChecks(results);
  assert.ok(results.every((result) => result.validation.passed === false));
  assert.ok(
    results.every((result) =>
      result.validation.checks
        .filter((check) => check.name.includes("across-matrix"))
        .every((check) => check.passed === false),
    ),
  );
});

test("collectTraceStream retains evidence received before a stream error", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    response.write(JSON.stringify({ type: "snapshot", traces: [validTrace[0]] }) + "\n");
    response.end("{invalid-json}\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await collectTraceStream(
      `http://127.0.0.1:${address.port}`,
      "run-1",
      "trace-token",
      1_000,
    );
    assert.deepEqual(result.received.map(({ event }) => event.id), ["event-1"]);
    assert.match(result.error, /JSON/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the executable completes an HTTP matrix run and writes a report", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "demo-matrix-test-"));
  const matrixPath = path.join(root, "matrix.json");
  const reportPath = path.join(root, "report.json");
  const now = new Date().toISOString();
  const run = {
    id: "00000000-0000-4000-8000-000000000002",
    agentId: "00000000-0000-4000-8000-000000000001",
    status: "completed",
    startedAt: now,
    completedAt: now,
  };
  const traces = [
    event("event-1", 1, "run.started", "run-span", null),
    event("event-2", 2, "runtime.started", "runtime-span", "run-span"),
    event("event-3", 3, "model.requested", "model-span", "runtime-span"),
    event("event-4", 4, "model.completed", "model-span", "runtime-span"),
    event("event-5", 5, "run.completed", "terminal-span", "run-span"),
  ].map((item) => ({ ...item, runId: run.id, traceId: run.id, agentId: run.agentId }));
  await writeFile(
    matrixPath,
    JSON.stringify({
      version: 1,
      cases: [
        {
          id: "mock-success",
          name: "Mock success",
          timeoutMs: 20_000,
          prompt: "Run the mock task",
          expected: {
            statuses: ["completed"],
            requiredEvents: ["run.started", "model.completed", "run.completed"],
            requiredLiveEvents: ["model.completed"],
          },
        },
      ],
    }),
    "utf8",
  );

  const server = http.createServer((request, response) => {
    request.resume();
    const send = (status, body, contentType = "application/json") => {
      response.writeHead(status, { "Content-Type": contentType });
      response.end(contentType === "application/json" ? JSON.stringify(body) : body);
    };
    if (request.url === "/api/health") return send(200, { ok: true });
    if (request.url === "/api/system") {
      return send(200, {
        arkConfigured: true,
        codexAvailable: true,
        runtimeProvider: "container",
        containerEngine: "mock",
        arkModel: "mock-model",
      });
    }
    if (request.url === "/api/session") return send(200, { user: { id: "user-1" } });
    if (request.url === "/api/developer/auth") return send(200, { authorized: true });
    if (request.method === "POST" && request.url === "/api/agents") {
      return send(201, { agent: { id: run.agentId } });
    }
    if (request.method === "POST" && request.url === `/api/agents/${run.agentId}/messages`) {
      return send(202, { run });
    }
    if (request.url === `/api/developer/runs/${run.id}/stream`) {
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const snapshotLine = JSON.stringify({ type: "snapshot", traces: traces.slice(0, 2) }) + "\n";
      response.write(snapshotLine.slice(0, 13));
      response.write(snapshotLine.slice(13));
      for (const trace of traces.slice(2)) {
        const line = JSON.stringify({ type: "trace", event: trace }) + "\n";
        response.write(line.slice(0, Math.floor(line.length / 2)));
        response.write(line.slice(Math.floor(line.length / 2)));
      }
      return response.end();
    }
    if (request.url === `/api/runs/${run.id}`) return send(200, { run });
    if (request.url === `/api/developer/runs/${run.id}/trace`) return send(200, { traces });
    return send(404, { error: "not found" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const scriptPath = fileURLToPath(new URL("./run-demo-matrix.mjs", import.meta.url));
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        "--base-url",
        `http://127.0.0.1:${address.port}`,
        "--matrix",
        matrixPath,
        "--report",
        reportPath,
        "--concurrency",
        "1",
      ],
      {
        env: {
          ...process.env,
          DEMO_USER_TOKEN: "user-token",
          DEMO_TRACE_TOKEN: "trace-token",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(exitCode, 0, output);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.summary, { jobs: 1, passed: 1, failed: 0 });
    assert.match(output, /Mock success|mock-success/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
