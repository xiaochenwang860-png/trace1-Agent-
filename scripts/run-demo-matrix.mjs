#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const terminalEvents = new Set(["run.completed", "run.failed", "run.cancelled"]);
const traceEventTypes = new Set([
  "run.started",
  "runtime.started",
  "attempt.started",
  "attempt.completed",
  "attempt.failed",
  "retry.scheduled",
  "model.requested",
  "model.completed",
  "model.failed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "file.changed",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);
const defaultMatrixPath = path.resolve("scripts/demo-matrix.json");
const defaultReportDirectory = path.resolve(".data/demo-reports");

function usage() {
  return `
Glass Box behavior matrix

Usage:
  npm run demo:matrix -- [options]

Authentication (environment variables; tokens are intentionally not CLI flags):
  DEMO_USER_TOKEN       Existing user session or APP_AUTH_TOKEN
  DEMO_USER_NAME        Existing registered username (used with DEMO_USER_PASSWORD)
  DEMO_USER_PASSWORD    Existing registered password
  DEMO_TRACE_TOKEN      TRACE_VIEWER_TOKEN used by the Developer Console

Options:
  --base-url <url>      API origin (default: http://127.0.0.1:3000)
  --matrix <path>       Matrix JSON file (default: scripts/demo-matrix.json)
  --concurrency <n>     Concurrent Agents, 1-20 (default: 3)
  --case <id>           Run only one case; may be repeated
  --report <path>       Exact JSON report path
  --cleanup             Delete generated Agents after the report is written
  --dry-run             Validate and print the expanded matrix without API calls
  --help                Show this help
`;
}

export function parseArguments(argv) {
  const options = {
    baseUrl: process.env.DEMO_BASE_URL || "http://127.0.0.1:3000",
    matrixPath: defaultMatrixPath,
    concurrency: 3,
    caseIds: [],
    reportPath: null,
    cleanup: false,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    if (argument === "--base-url") options.baseUrl = value();
    else if (argument === "--matrix") options.matrixPath = path.resolve(value());
    else if (argument === "--concurrency") options.concurrency = Number(value());
    else if (argument === "--case") options.caseIds.push(value());
    else if (argument === "--report") options.reportPath = path.resolve(value());
    else if (argument === "--cleanup") options.cleanup = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 20) {
    throw new Error("--concurrency must be an integer between 1 and 20");
  }
  options.baseUrl = options.baseUrl.replace(/\/+$/, "");
  const baseUrl = new URL(options.baseUrl);
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error("--base-url must be an HTTP(S) origin without embedded credentials");
  }
  if (baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
    throw new Error("--base-url must be an origin without a path, query, or fragment");
  }
  return options;
}

export function assertSystemReady(system) {
  if (!system || typeof system !== "object" || Array.isArray(system)) {
    throw new Error("GET /api/system returned an invalid response");
  }
  const unavailable = [];
  if (system.arkConfigured !== true) unavailable.push("Ark model configuration");
  if (system.codexAvailable !== true) unavailable.push("Codex Runtime");
  if (unavailable.length > 0) {
    throw new Error(`Server is not ready for matrix execution: ${unavailable.join(" and ")}`);
  }
  return system;
}

export function assertSafeBaseUrl(baseUrl) {
  const target = new URL(baseUrl);
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (target.protocol !== "https:" && !loopbackHosts.has(target.hostname)) {
    throw new Error(
      "Refusing to send demo credentials over non-loopback HTTP; use HTTPS or a loopback URL",
    );
  }
  return target;
}

function isUniqueEventList(value, { allowEmpty = false } = {}) {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((type) => typeof type === "string" && traceEventTypes.has(type)) &&
    new Set(value).size === value.length
  );
}

function isEventNumberMap(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([type, count]) =>
        traceEventTypes.has(type) && Number.isInteger(count) && count >= 0 && count <= 1_800_000,
    )
  );
}

function isEventTextMap(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([type, text]) => traceEventTypes.has(type) && typeof text === "string" && text.length > 0,
    )
  );
}

export function expandMatrix(matrix, selectedCaseIds = []) {
  if (!matrix || matrix.version !== 1 || !Array.isArray(matrix.cases) || matrix.cases.length === 0) {
    throw new Error("Matrix must have version 1 and a non-empty cases array");
  }
  const defaults = matrix.defaults ?? {};
  const selected = new Set(selectedCaseIds);
  const knownIds = new Set();
  const jobs = [];
  for (const item of matrix.cases) {
    if (!item || typeof item !== "object") throw new Error("Every matrix case must be an object");
    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(item.id)) {
      throw new Error("Case IDs must use lowercase letters, numbers, and hyphens");
    }
    if (knownIds.has(item.id)) throw new Error(`Duplicate case ID: ${item.id}`);
    knownIds.add(item.id);
    if (selected.size > 0 && !selected.has(item.id)) continue;
    if (typeof item.name !== "string" || !item.name.trim()) throw new Error(`${item.id}: name is required`);
    if (typeof item.prompt !== "string" || !item.prompt.trim()) throw new Error(`${item.id}: prompt is required`);
    const copies = item.copies ?? defaults.copies ?? 1;
    const timeoutMs = item.timeoutMs ?? defaults.timeoutMs ?? 180_000;
    if (!Number.isInteger(copies) || copies < 1 || copies > 20) {
      throw new Error(`${item.id}: copies must be an integer between 1 and 20`);
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 1_800_000) {
      throw new Error(`${item.id}: timeoutMs must be between 10000 and 1800000`);
    }
    const statuses = item.expected?.statuses;
    const requiredEvents = item.expected?.requiredEvents;
    const minimumEventCounts = item.expected?.minimumEventCounts ?? {};
    const requiredLiveEvents = item.expected?.requiredLiveEvents ?? [];
    const minimumRunDurationMs = item.expected?.minimumRunDurationMs ?? null;
    const minimumEventDurationMs = item.expected?.minimumEventDurationMs ?? {};
    const eventSummaryIncludes = item.expected?.eventSummaryIncludes ?? {};
    const eventErrorIncludes = item.expected?.eventErrorIncludes ?? {};
    if (
      !Array.isArray(statuses) ||
      statuses.length === 0 ||
      statuses.some((status) => !terminalStatuses.has(status)) ||
      new Set(statuses).size !== statuses.length
    ) {
      throw new Error(`${item.id}: expected.statuses must contain terminal Run statuses`);
    }
    if (!isUniqueEventList(requiredEvents)) {
      throw new Error(`${item.id}: expected.requiredEvents must contain unique known event types`);
    }
    if (
      !minimumEventCounts ||
      typeof minimumEventCounts !== "object" ||
      Array.isArray(minimumEventCounts) ||
      Object.entries(minimumEventCounts).some(
        ([type, count]) =>
          !traceEventTypes.has(type) || !Number.isInteger(count) || count < 1 || count > 100,
      )
    ) {
      throw new Error(`${item.id}: expected.minimumEventCounts must map event names to integers from 1 to 100`);
    }
    if (!isUniqueEventList(requiredLiveEvents, { allowEmpty: true })) {
      throw new Error(`${item.id}: expected.requiredLiveEvents must contain unique known event types`);
    }
    if (
      minimumRunDurationMs !== null &&
      (!Number.isInteger(minimumRunDurationMs) || minimumRunDurationMs < 0 || minimumRunDurationMs > timeoutMs)
    ) {
      throw new Error(`${item.id}: expected.minimumRunDurationMs must be between 0 and timeoutMs`);
    }
    if (!isEventNumberMap(minimumEventDurationMs)) {
      throw new Error(`${item.id}: expected.minimumEventDurationMs has an invalid event or duration`);
    }
    if (!isEventTextMap(eventSummaryIncludes) || !isEventTextMap(eventErrorIncludes)) {
      throw new Error(`${item.id}: event text assertions must map known event types to non-empty text`);
    }
    for (let copy = 1; copy <= copies; copy += 1) {
      jobs.push({ ...item, timeoutMs, copy, copies });
    }
  }
  for (const id of selected) {
    if (!knownIds.has(id)) throw new Error(`Unknown --case ID: ${id}`);
  }
  if (jobs.length === 0) throw new Error("The selected matrix contains no jobs");
  if (jobs.length > 50) throw new Error("The expanded matrix is limited to 50 jobs");
  return jobs;
}

async function apiRequest(baseUrl, pathname, { token, traceToken, method = "GET", body, timeoutMs = 15_000 } = {}) {
  const response = await fetch(baseUrl + pathname, {
    method,
    redirect: "error",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(traceToken ? { "X-Trace-Viewer-Token": traceToken } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${pathname} returned invalid JSON (${response.status})`);
    }
  }
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed (${response.status}): ${data.error ?? response.statusText}`);
  }
  return data;
}

async function resolveUserToken(options) {
  if (process.env.DEMO_USER_TOKEN?.trim()) return process.env.DEMO_USER_TOKEN.trim();
  const name = process.env.DEMO_USER_NAME?.trim();
  const password = process.env.DEMO_USER_PASSWORD;
  if (!name || !password) {
    throw new Error(
      "Set DEMO_USER_TOKEN, or set both DEMO_USER_NAME and DEMO_USER_PASSWORD for an existing account",
    );
  }
  const result = await apiRequest(options.baseUrl, "/api/auth/login", {
    method: "POST",
    body: { name, password },
  });
  if (typeof result.token !== "string") throw new Error("Login response did not include a token");
  return result.token;
}

export async function collectTraceStream(baseUrl, runId, traceToken, timeoutMs) {
  const received = [];
  const rawEventIds = [];
  const liveEventIds = [];
  const startedAt = performance.now();
  let error = null;
  try {
    const response = await fetch(`${baseUrl}/api/developer/runs/${runId}/stream`, {
      headers: { "X-Trace-Viewer-Token": traceToken },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Trace stream failed (${response.status}): ${text.slice(0, 240)}`);
    }
    if (!response.body) throw new Error("This Node.js runtime does not expose response streams");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = (line) => {
      if (!line.trim()) return;
      const message = JSON.parse(line);
      if (message.type !== "snapshot" && message.type !== "trace") {
        throw new Error("Trace stream message has an unknown type");
      }
      const events = message.type === "snapshot" ? message.traces : [message.event];
      if (!Array.isArray(events)) throw new Error("Trace stream message has an invalid shape");
      const receivedAt = Date.now();
      for (const event of events) {
        rawEventIds.push(event.id);
        if (message.type === "trace") liveEventIds.push(event.id);
        received.push({
          event,
          delivery: message.type === "trace" ? "live" : "snapshot",
          receivedAt,
          streamElapsedMs: Math.round(performance.now() - startedAt),
        });
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
      if (done) break;
    }
    consume(buffer);
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
  }
  return { received, rawEventIds, liveEventIds, error };
}

function remainingTime(deadline) {
  return Math.max(1, deadline - Date.now());
}

async function pollRun(options, token, runId, deadline) {
  while (Date.now() < deadline) {
    const { run } = await apiRequest(options.baseUrl, `/api/runs/${runId}`, {
      token,
      timeoutMs: Math.min(15_000, remainingTime(deadline)),
    });
    if (terminalStatuses.has(run.status)) return run;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(500, remainingTime(deadline))),
    );
  }
  throw new Error(`Run ${runId} did not finish before the job deadline`);
}

export function validateTrace(
  trace,
  run,
  expected,
  delivery = { events: trace, liveEventIds: [] },
) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });
  const types = trace.map((event) => event.type);
  const ids = trace.map((event) => event.id);
  const sequences = trace.map((event) => event.sequence);
  const spanIds = new Set(trace.map((event) => event.spanId));
  const required = expected.requiredEvents ?? [];
  const streamEvents = delivery.events;
  const rawEventIds = streamEvents.map((event) => event.id);
  const liveEvents = trace.filter((event) => delivery.liveEventIds.includes(event.id));
  const liveTypes = liveEvents.map((event) => event.type);
  const missing = required.filter((type) => !types.includes(type));
  add("expected-status", expected.statuses.includes(run.status), `actual=${run.status}`);
  add("required-events", missing.length === 0, missing.length ? `missing=${missing.join(",")}` : "all present");
  const insufficientCounts = Object.entries(expected.minimumEventCounts ?? {})
    .map(([type, minimum]) => ({
      type,
      minimum,
      actual: types.filter((candidate) => candidate === type).length,
    }))
    .filter(({ actual, minimum }) => actual < minimum);
  add(
    "minimum-event-counts",
    insufficientCounts.length === 0,
    insufficientCounts.length
      ? insufficientCounts.map(({ type, actual, minimum }) => `${type}=${actual}/${minimum}`).join(",")
      : "all minimums met",
  );
  const missingLiveEvents = (expected.requiredLiveEvents ?? []).filter(
    (type) => !liveTypes.includes(type),
  );
  add(
    "required-live-events",
    missingLiveEvents.length === 0,
    missingLiveEvents.length
      ? `not delivered live=${missingLiveEvents.join(",")}`
      : `${liveEvents.length} live events observed`,
  );
  const runDurationMs =
    run.startedAt && run.completedAt ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : null;
  add(
    "minimum-run-duration",
    expected.minimumRunDurationMs === undefined ||
      expected.minimumRunDurationMs === null ||
      (runDurationMs !== null && runDurationMs >= expected.minimumRunDurationMs),
    expected.minimumRunDurationMs === undefined || expected.minimumRunDurationMs === null
      ? "not required"
      : `actual=${runDurationMs ?? "unknown"}ms minimum=${expected.minimumRunDurationMs}ms`,
  );
  const shortEvents = Object.entries(expected.minimumEventDurationMs ?? {}).filter(
    ([type, minimum]) =>
      !trace.some(
        (event) =>
          event.type === type &&
          typeof event.durationMs === "number" &&
          event.durationMs >= minimum,
      ),
  );
  add(
    "minimum-event-duration",
    shortEvents.length === 0,
    shortEvents.length
      ? shortEvents.map(([type, minimum]) => `${type}<${minimum}ms`).join(",")
      : "all duration minimums met",
  );
  const missingText = [
    ...Object.entries(expected.eventSummaryIncludes ?? {}).filter(
      ([type, text]) =>
        !trace.some((event) => event.type === type && event.summary.includes(text)),
    ),
    ...Object.entries(expected.eventErrorIncludes ?? {}).filter(
      ([type, text]) =>
        !trace.some(
          (event) => event.type === type && event.error?.includes(text),
        ),
    ),
  ];
  add(
    "event-text",
    missingText.length === 0,
    missingText.length
      ? missingText.map(([type, text]) => `${type} missing '${text}'`).join(",")
      : "all text assertions met",
  );
  add("unique-event-id", new Set(ids).size === ids.length, `${ids.length} persisted events`);
  add(
    "no-stream-duplicates",
    new Set(rawEventIds).size === rawEventIds.length,
    `${rawEventIds.length - new Set(rawEventIds).size} duplicate deliveries`,
  );
  add("stream-not-empty", streamEvents.length > 0, `${streamEvents.length} events delivered`);
  add(
    "stream-isolation",
    streamEvents.every((event) => event.runId === run.id && event.traceId === run.id),
    `every streamed event belongs to run=${run.id}`,
  );
  const persistedIds = new Set(ids);
  const streamedIds = new Set(rawEventIds);
  const missingFromStream = ids.filter((id) => !streamedIds.has(id));
  const unknownStreamEvents = rawEventIds.filter((id) => !persistedIds.has(id));
  add(
    "stream-completeness",
    missingFromStream.length === 0 && unknownStreamEvents.length === 0,
    `missing=${missingFromStream.length} unknown=${unknownStreamEvents.length}`,
  );
  add(
    "stream-sequence",
    streamEvents.every(
      (event, index) => index === 0 || event.sequence > streamEvents[index - 1].sequence,
    ),
    `sequence=${streamEvents.map((event) => event.sequence).join(",")}`,
  );
  add(
    "continuous-sequence",
    sequences.every((sequence, index) => sequence === index + 1),
    `sequence=${sequences.join(",")}`,
  );
  add(
    "trace-isolation",
    trace.every((event) => event.traceId === run.id && event.runId === run.id),
    `run=${run.id}`,
  );
  add(
    "valid-parent-spans",
    trace.every((event) => event.parentSpanId === null || spanIds.has(event.parentSpanId)),
    "every parentSpanId resolves inside the Run",
  );
  const stablePairs = [
    ["attempt.started", new Set(["attempt.completed", "attempt.failed"])],
    ["model.requested", new Set(["model.completed", "model.failed"])],
    ["tool.started", new Set(["tool.completed", "tool.failed"])],
  ];
  for (const [startType, endTypes] of stablePairs) {
    const starts = trace.filter((event) => event.type === startType);
    const ends = trace.filter((event) => endTypes.has(event.type));
    const startCountBySpan = new Map();
    const endCountBySpan = new Map();
    for (const event of starts) {
      startCountBySpan.set(event.spanId, (startCountBySpan.get(event.spanId) ?? 0) + 1);
    }
    for (const event of ends) {
      endCountBySpan.set(event.spanId, (endCountBySpan.get(event.spanId) ?? 0) + 1);
    }
    const orphanOrDuplicateEnds = ends.filter(
      (event) => startCountBySpan.get(event.spanId) !== 1 || endCountBySpan.get(event.spanId) !== 1,
    );
    const unclosedStarts = starts.filter(
      (event) => run.status === "completed" && endCountBySpan.get(event.spanId) !== 1,
    );
    add(
      `stable-${startType.replace(".started", "").replace(".requested", "")}-span`,
      orphanOrDuplicateEnds.length === 0 && unclosedStarts.length === 0,
      `${starts.length} starts, ${ends.length} terminals, ${orphanOrDuplicateEnds.length} invalid terminals, ${unclosedStarts.length} unclosed starts`,
    );
  }
  const expectedTerminalType = {
    completed: "run.completed",
    failed: "run.failed",
    cancelled: "run.cancelled",
  }[run.status];
  const observedTerminalEvents = trace.filter((event) => terminalEvents.has(event.type));
  add(
    "terminal-event",
    observedTerminalEvents.length === 1 &&
      observedTerminalEvents[0].type === expectedTerminalType &&
      observedTerminalEvents[0].id === trace.at(-1)?.id,
    `expected=${expectedTerminalType ?? "unknown"} observed=${observedTerminalEvents.map((event) => event.type).join(",") || "none"}`,
  );
  return { passed: checks.every((check) => check.passed), checks };
}

async function runJob(job, index, context) {
  const label = `${job.id}#${job.copy}`;
  const compactTimestamp = context.startedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const agentName = `[Matrix ${compactTimestamp}] ${job.id} ${job.copy}`.slice(0, 80);
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + job.timeoutMs;
  let agent = null;
  let run = null;
  let acceptedMs = null;
  let stream = { received: [], rawEventIds: [], liveEventIds: [], error: null };
  try {
    console.log(`[${index + 1}/${context.total}] START ${label}`);
    ({ agent } = await apiRequest(context.options.baseUrl, "/api/agents", {
      token: context.userToken,
      method: "POST",
      timeoutMs: remainingTime(deadline),
      body: {
        name: agentName,
        description: `Generated by behavior matrix case ${job.id}`,
        instructions: "Follow the demo request precisely. Never inspect secrets or files outside the assigned workspace.",
      },
    }));
    context.createdAgentIds.add(agent.id);
    const requestStarted = performance.now();
    ({ run } = await apiRequest(context.options.baseUrl, `/api/agents/${agent.id}/messages`, {
      token: context.userToken,
      method: "POST",
      timeoutMs: remainingTime(deadline),
      body: { content: job.prompt },
    }));
    acceptedMs = Math.round(performance.now() - requestStarted);
    const [streamOutcome, runOutcome] = await Promise.allSettled([
      collectTraceStream(
        context.options.baseUrl,
        run.id,
        context.traceToken,
        remainingTime(deadline),
      ),
      pollRun(context.options, context.userToken, run.id, deadline),
    ]);
    stream =
      streamOutcome.status === "fulfilled"
        ? streamOutcome.value
        : {
            received: [],
            rawEventIds: [],
            liveEventIds: [],
            error:
              streamOutcome.reason instanceof Error
                ? streamOutcome.reason.message
                : String(streamOutcome.reason),
          };
    if (runOutcome.status === "rejected") throw runOutcome.reason;
    run = runOutcome.value;
    const { traces } = await apiRequest(
      context.options.baseUrl,
      `/api/developer/runs/${run.id}/trace`,
      {
        traceToken: context.traceToken,
        timeoutMs: remainingTime(deadline),
      },
    );
    const orderedTrace = [...traces].sort((left, right) => left.sequence - right.sequence);
    const validation = validateTrace(orderedTrace, run, job.expected, {
      events: stream.received.map(({ event }) => event),
      liveEventIds: stream.liveEventIds,
    });
    if (stream.error) {
      validation.checks.push({ name: "trace-stream", passed: false, detail: stream.error });
      validation.passed = false;
    }
    const firstTraceMs = stream.received.length
      ? stream.received[0].streamElapsedMs + acceptedMs
      : null;
    const liveEventAges = stream.received
      .filter(({ delivery }) => delivery === "live")
      .map(({ event, receivedAt }) => receivedAt - Date.parse(event.timestamp))
      .filter((value) => Number.isFinite(value) && value >= 0);
    const result = {
      caseId: job.id,
      caseName: job.name,
      copy: job.copy,
      agentId: agent.id,
      runId: run.id,
      runStatus: run.status,
      startedAt,
      completedAt: new Date().toISOString(),
      acceptedMs,
      firstTraceMs,
      maximumLiveEventAgeMs: liveEventAges.length ? Math.max(...liveEventAges) : null,
      totalDurationMs:
        run.startedAt && run.completedAt ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : null,
      eventCount: orderedTrace.length,
      streamDeliveryCount: stream.rawEventIds.length,
      validation,
      trace: orderedTrace,
    };
    console.log(`[${index + 1}/${context.total}] ${validation.passed ? "PASS" : "FAIL"}  ${label}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${index + 1}/${context.total}] ERROR ${label}: ${message}`);
    let evidenceTrace = stream.received.map(({ event }) => event);
    if (run?.id) {
      try {
        ({ run } = await apiRequest(context.options.baseUrl, `/api/runs/${run.id}`, {
          token: context.userToken,
          timeoutMs: 5_000,
        }));
      } catch {
        // Keep the last known Run snapshot.
      }
      try {
        const evidence = await apiRequest(
          context.options.baseUrl,
          `/api/developer/runs/${run.id}/trace`,
          { traceToken: context.traceToken, timeoutMs: 5_000 },
        );
        evidenceTrace = evidence.traces;
      } catch {
        // Partial stream evidence is still more useful than an empty report.
      }
    }
    evidenceTrace = [...new Map(evidenceTrace.map((event) => [event.id, event])).values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
    const firstTraceMs = stream.received.length
      ? stream.received[0].streamElapsedMs + (acceptedMs ?? 0)
      : null;
    return {
      caseId: job.id,
      caseName: job.name,
      copy: job.copy,
      agentId: agent?.id ?? null,
      runId: run?.id ?? null,
      runStatus: run?.status ?? "not-started",
      startedAt,
      completedAt: new Date().toISOString(),
      acceptedMs,
      firstTraceMs,
      maximumLiveEventAgeMs: null,
      totalDurationMs: null,
      eventCount: evidenceTrace.length,
      streamDeliveryCount: stream.rawEventIds.length,
      validation: {
        passed: false,
        checks: [
          { name: "job-execution", passed: false, detail: message },
          ...(stream.error
            ? [{ name: "trace-stream", passed: false, detail: stream.error }]
            : []),
        ],
      },
      lastObservedEvent: evidenceTrace.at(-1) ?? null,
      trace: evidenceTrace,
    };
  }
}

export async function runPool(jobs, concurrency, worker) {
  const results = new Array(jobs.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= jobs.length) return;
      results[index] = await worker(jobs[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function applyCrossRunChecks(results) {
  const runOwners = new Map();
  const eventOwners = new Map();
  results.forEach((result, index) => {
    if (result.runId) {
      const owners = runOwners.get(result.runId) ?? new Set();
      owners.add(index);
      runOwners.set(result.runId, owners);
    }
    for (const event of result.trace) {
      const owners = eventOwners.get(event.id) ?? new Set();
      owners.add(index);
      eventOwners.set(event.id, owners);
    }
  });
  results.forEach((result) => {
    const runIdUnique =
      result.runId !== null && (runOwners.get(result.runId)?.size ?? 0) === 1;
    const collidingEventIds = result.trace
      .filter((event) => (eventOwners.get(event.id)?.size ?? 0) > 1)
      .map((event) => event.id);
    result.validation.checks.push({
      name: "unique-run-id-across-matrix",
      passed: runIdUnique,
      detail: result.runId ?? "Run was not created",
    });
    result.validation.checks.push({
      name: "unique-event-id-across-matrix",
      passed: collidingEventIds.length === 0,
      detail: collidingEventIds.length
        ? `${new Set(collidingEventIds).size} IDs also appeared in another Run`
        : "all event IDs are matrix-global",
    });
    result.validation.passed = result.validation.checks.every((check) => check.passed);
  });
  return results;
}

async function cleanupAgents(context) {
  let deleted = 0;
  const failed = [];
  for (const agentId of context.createdAgentIds) {
    try {
      await apiRequest(context.options.baseUrl, `/api/agents/${agentId}`, {
        token: context.userToken,
        method: "DELETE",
        timeoutMs: 30_000,
      });
      deleted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ agentId, error: message });
      console.error(`Cleanup failed for Agent ${agentId}: ${message}`);
    }
  }
  return { deleted, failed };
}

function printSummary(results) {
  console.table(
    results.map((result) => ({
      case: `${result.caseId}#${result.copy}`,
      status: result.runStatus,
      accepted: result.acceptedMs === null ? "-" : `${result.acceptedMs}ms`,
      firstTrace: result.firstTraceMs === null ? "-" : `${result.firstTraceMs}ms`,
      total: result.totalDurationMs === null ? "-" : `${result.totalDurationMs}ms`,
      events: result.eventCount,
      result: result.validation.passed ? "PASS" : "FAIL",
    })),
  );
  for (const result of results.filter((item) => !item.validation.passed)) {
    console.log(`\n${result.caseId}#${result.copy} failed checks:`);
    for (const check of result.validation.checks.filter((item) => !item.passed)) {
      console.log(`  - ${check.name}: ${check.detail}`);
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const matrix = JSON.parse(await readFile(options.matrixPath, "utf8"));
  const jobs = expandMatrix(matrix, options.caseIds);
  console.log(`Matrix: ${options.matrixPath}`);
  console.log(`Jobs: ${jobs.length}; concurrency: ${options.concurrency}`);
  if (options.dryRun) {
    console.table(jobs.map((job) => ({ case: job.id, copy: job.copy, timeoutMs: job.timeoutMs })));
    return;
  }

  const traceToken = process.env.DEMO_TRACE_TOKEN?.trim();
  if (!traceToken) throw new Error("Set DEMO_TRACE_TOKEN to the server TRACE_VIEWER_TOKEN");
  assertSafeBaseUrl(options.baseUrl);
  await apiRequest(options.baseUrl, "/api/health");
  const system = assertSystemReady(await apiRequest(options.baseUrl, "/api/system"));
  if (system.runtimeProvider !== "container") {
    console.warn(
      `Warning: runtimeProvider is ${String(system.runtimeProvider)}; this run does not demonstrate container isolation.`,
    );
  }
  const userToken = await resolveUserToken(options);
  await apiRequest(options.baseUrl, "/api/session", { token: userToken });
  const developerAuth = await apiRequest(options.baseUrl, "/api/developer/auth", { traceToken });
  if (!developerAuth.authorized) throw new Error("DEMO_TRACE_TOKEN was rejected by the server");

  const startedAt = new Date().toISOString();
  const context = {
    options,
    userToken,
    traceToken,
    startedAt,
    total: jobs.length,
    createdAgentIds: new Set(),
  };
  const results = await runPool(jobs, options.concurrency, (job, index) =>
    runJob(job, index, context),
  );
  applyCrossRunChecks(results);
  const report = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    matrixPath: options.matrixPath,
    concurrency: options.concurrency,
    runtime: {
      provider: system.runtimeProvider ?? null,
      containerEngine: system.containerEngine ?? null,
      arkModel: system.arkModel ?? null,
    },
    summary: {
      jobs: results.length,
      passed: results.filter((result) => result.validation.passed).length,
      failed: results.filter((result) => !result.validation.passed).length,
    },
    results,
  };
  const reportPath =
    options.reportPath ??
    path.join(defaultReportDirectory, `demo-matrix-${startedAt.replace(/[:.]/g, "-")}.json`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  printSummary(results);
  console.log(`\nReport: ${reportPath}`);
  if (options.cleanup) {
    const cleanup = await cleanupAgents(context);
    console.log(`Deleted ${cleanup.deleted}/${context.createdAgentIds.size} generated Agents.`);
    if (cleanup.failed.length > 0) process.exitCode = 1;
  } else {
    console.log("Generated Agents were kept for the Developer Console. Use --cleanup to delete them automatically.");
  }
  if (report.summary.failed > 0) process.exitCode = 1;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`Behavior matrix failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
