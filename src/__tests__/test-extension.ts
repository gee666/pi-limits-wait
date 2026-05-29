import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import {
  __configureFallbackModelsForTests,
  __readFallbackSettingsForTests,
  getRetryableError,
  isAuthenticationRefreshError,
  isRateLimitError,
  isServerOverloadedError,
  retryAfterHeaderMs,
  sanitiseSystemPrompt,
  streamWithLimitsRetry,
  waitForRateLimit,
} from "../index.js";

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}${detail ? `  →  ${detail}` : ""}`);
    failed++;
  }
}

function section(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

function mockModel(id = "test-model", provider = "test-provider"): Model<Api> {
  return { provider, id, api: "anthropic-messages" } as Model<Api>;
}

function startEvent(): AssistantMessageEvent {
  return { type: "start", partial: { role: "assistant", content: [], api: "anthropic-messages", provider: "test-provider", model: "test-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } } as AssistantMessageEvent;
}

function errorEvent(message: string): AssistantMessageEvent {
  return { type: "error", reason: "error", error: { ...((startEvent() as { partial: unknown }).partial as object), stopReason: "error", errorMessage: message } } as AssistantMessageEvent;
}

function doneEvent(): AssistantMessageEvent {
  return { type: "done", message: (startEvent() as { partial: unknown }).partial } as AssistantMessageEvent;
}

function streamFrom(events: AssistantMessageEvent[]) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) stream.push(event);
    stream.end();
  });
  return stream;
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

section("prompt sanitisation");
{
  const raw = [
    "You are pi, a coding agent.",
    "Keep this useful instruction.",
    "Internal docs mention @mariozechner/pi-coding-agent and should be removed.",
  ].join("\n\n");
  const sanitised = sanitiseSystemPrompt(raw);
  ok("removes Pi identity sentence", !sanitised.includes("You are pi"));
  ok("removes paragraphs with Pi internals", !sanitised.includes("@mariozechner/pi-coding-agent"));
  ok("keeps unrelated instructions", sanitised.includes("Keep this useful instruction."));
}

section("retryable detection");
ok("detects 429", isRateLimitError("HTTP 429 Too Many Requests"));
ok("detects rate_limit", isRateLimitError("rate_limit_error"));
ok("detects server_is_overloaded", isServerOverloadedError("server_is_overloaded"));
ok("detects refreshable authentication errors", isAuthenticationRefreshError('Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}'));
ok("does not retry generic unauthorized", !isRateLimitError("HTTP 401 Unauthorized") && !isServerOverloadedError("HTTP 401 Unauthorized") && !isAuthenticationRefreshError("HTTP 401 Unauthorized"));
ok("classifies overloaded", getRetryableError("server_is_overloaded")?.reason === "overloaded");
ok("uses retry delay on overloaded", getRetryableError("server_is_overloaded retry-after 0.01")?.waitMs === 10);
{
  const past = new Headers({ "retry-after": new Date(Date.now() - 10_000).toUTCString() });
  ok("past retry-after date parses as zero", retryAfterHeaderMs(past) === 0);
}

section("fallback settings files");
{
  const root = mkdtempSync(join(tmpdir(), "limits-wait-"));
  try {
    const home = join(root, "home");
    const agent = join(root, "agent");
    const project = join(root, "project");
    mkdirSync(join(home, ".config", ".pi"), { recursive: true });
    mkdirSync(agent, { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(home, ".config", ".pi", "limits-wait.json"), JSON.stringify({ "fallback-models": [{ provider: "base", modelname: "base" }], keep: "home" }));
    writeFileSync(join(agent, "limits-wait.json"), JSON.stringify({ keep: "agent", agentOnly: true }));
    writeFileSync(join(project, ".limits-wait.json"), JSON.stringify({ keep: "project-root" }));
    writeFileSync(join(project, ".pi", "limits-wait.json"), JSON.stringify({ keep: "project-pi", "fallback-models": [{ provider: "final", modelname: "final" }] }));

    const resolved = __readFallbackSettingsForTests(project, agent, home);
    ok("loads all limits-wait.json locations in precedence order", resolved.loadedPaths.length === 4, `paths=${resolved.loadedPaths.join(",")}`);
    ok("project .pi/limits-wait.json has highest precedence", (resolved.config["fallback-models"] as Array<{ provider: string }>)[0]?.provider === "final" && resolved.config.keep === "project-pi");
    ok("lower-priority keys are preserved", resolved.config.agentOnly === true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

section("waitForRateLimit");
{
  const start = Date.now();
  const result = await waitForRateLimit(0);
  ok("zero wait resolves immediately", result === "waited" && Date.now() - start < 50);
}
{
  const ctrl = new AbortController();
  ctrl.abort();
  const result = await waitForRateLimit(60_000, ctrl.signal);
  ok("pre-aborted signal resolves as aborted", result === "aborted");
}
{
  const ctrl = new AbortController();
  const promise = waitForRateLimit(60_000, ctrl.signal);
  setTimeout(() => ctrl.abort(), 20);
  ok("abort during wait resolves as aborted", (await promise) === "aborted");
}

section("streamWithLimitsRetry");
{
  let calls = 0;
  const delegate = () => {
    calls++;
    return calls === 1
      ? streamFrom([startEvent(), errorEvent("HTTP 429 retry-after 0.01")])
      : streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, mockModel(), {} as Context, {} as SimpleStreamOptions));
  ok("retries rate-limit stream then succeeds", calls === 2 && events.at(-1)?.type === "done", `calls=${calls}, last=${events.at(-1)?.type}`);
}
{
  let calls = 0;
  const delegate = () => {
    calls++;
    return calls === 1
      ? streamFrom([startEvent(), errorEvent("server_is_overloaded retry-after 0.01")])
      : streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, mockModel(), {} as Context, {} as SimpleStreamOptions));
  ok("overloaded retry honors retry-after and succeeds", calls === 2 && events.at(-1)?.type === "done", `calls=${calls}, last=${events.at(-1)?.type}`);
}
{
  let calls = 0;
  const delegate = () => {
    calls++;
    return calls === 1
      ? streamFrom([startEvent(), errorEvent('Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}} retry-after 0.01')])
      : streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, mockModel(), {} as Context, {} as SimpleStreamOptions));
  ok("retries refreshable authentication error then succeeds", calls === 2 && events.at(-1)?.type === "done", `calls=${calls}, last=${events.at(-1)?.type}`);
}
{
  const primary = mockModel("primary");
  const fallback = mockModel("fallback");
  const seen: string[] = [];
  const notifications: string[] = [];
  __configureFallbackModelsForTests(
    [{ model: fallback }],
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: (message: string) => notifications.push(message), setStatus: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  const delegate = (model: Model<Api>) => {
    seen.push(model.id);
    return model.id === "primary"
      ? streamFrom([startEvent(), errorEvent("HTTP 429 retry-after 0.01")])
      : streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, primary, {} as Context, {} as SimpleStreamOptions));
  ok("tries fallback model after classified rate-limit error", seen.join(",") === "primary,fallback" && events.at(-1)?.type === "done", `seen=${seen.join(",")}, last=${events.at(-1)?.type}`);
  ok("rate-limit warning includes provider error detail", notifications.some((message) => message.includes("HTTP 429 retry-after 0.01")), `notifications=${notifications.join(";")}`);
  __configureFallbackModelsForTests([]);
}
{
  const primary = mockModel("primary");
  const fallback = mockModel("fallback");
  __configureFallbackModelsForTests(
    [{ model: fallback }],
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: () => undefined, setStatus: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  const seen: string[] = [];
  const delegate = (model: Model<Api>) => {
    seen.push(model.id);
    if (model.id === "primary") throw new Error("Connection error.", { cause: new Error("HTTP 429 Too Many Requests retry-after 0.01") });
    return streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, primary, {} as Context, {} as SimpleStreamOptions));
  ok("detects retryable 429 in wrapped error cause", seen.join(",") === "primary,fallback" && events.at(-1)?.type === "done", `seen=${seen.join(",")}, last=${events.at(-1)?.type}`);
  __configureFallbackModelsForTests([]);
}
{
  const primary = mockModel("primary");
  const fallback = mockModel("fallback");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response("early rate limit body", { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "0.01" } });
  }) as typeof fetch;
  __configureFallbackModelsForTests(
    [{ model: fallback }],
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: () => undefined, setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  const seen: string[] = [];
  const delegate = async (model: Model<Api>) => {
    seen.push(model.id);
    if (model.id === "primary") await fetch("https://example.invalid/rate-limited");
    return streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, primary, {} as Context, {} as SimpleStreamOptions));
  ok("falls back immediately when fetch observes 429 before provider stream error", seen.join(",") === "primary,fallback" && fetchCalls === 1 && events.at(-1)?.type === "done", `seen=${seen.join(",")}, fetchCalls=${fetchCalls}, last=${events.at(-1)?.type}`);
  __configureFallbackModelsForTests([]);
  globalThis.fetch = originalFetch;
}
{
  const primary = mockModel("primary");
  const fallback = mockModel("fallback");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("early rate limit body", { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "0.01" } })) as typeof fetch;
  __configureFallbackModelsForTests(
    [{ model: fallback }],
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: () => undefined, setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  const seen: string[] = [];
  const delegate = async (model: Model<Api>) => {
    seen.push(model.id);
    if (model.id === "primary") {
      try {
        await fetch("https://example.invalid/rate-limited");
      } catch {
        return streamFrom([startEvent(), errorEvent("Connection error.")]);
      }
    }
    return streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, primary, {} as Context, {} as SimpleStreamOptions));
  ok("uses observed 429 when provider hides it behind connection error event", seen.join(",") === "primary,fallback" && events.at(-1)?.type === "done", `seen=${seen.join(",")}, last=${events.at(-1)?.type}`);
  __configureFallbackModelsForTests([]);
  globalThis.fetch = originalFetch;
}
{
  const primary = mockModel("primary");
  const fallback = mockModel("fallback");
  const notifications: string[] = [];
  __configureFallbackModelsForTests(
    [{ model: fallback }],
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: (message: string) => notifications.push(message), setStatus: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  const seen: string[] = [];
  const delegate = (model: Model<Api>) => {
    seen.push(model.id);
    return model.id === "primary"
      ? streamFrom([startEvent(), errorEvent("HTTP 400 Bad Request")])
      : streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, primary, {} as Context, {} as SimpleStreamOptions));
  ok("freezes failed model and tries fallback on unclassified non-retryable errors", seen.join(",") === "primary,fallback" && events.at(-1)?.type === "done" && notifications.some((message) => message.includes("HTTP 400 Bad Request") && message.includes("freezing it")), `seen=${seen.join(",")}, last=${events.at(-1)?.type}, notifications=${notifications.join(";")}`);
  __configureFallbackModelsForTests([]);
}
{
  const primary = mockModel("primary");
  const fallback = mockModel("fallback");
  const notifications: string[] = [];
  __configureFallbackModelsForTests(
    [{ model: fallback }],
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: (message: string) => notifications.push(message), setStatus: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  const ctrl = new AbortController();
  ctrl.abort();
  const seen: string[] = [];
  const delegate = (model: Model<Api>) => {
    seen.push(model.id);
    return streamFrom([startEvent(), errorEvent("Operation aborted")]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, primary, {} as Context, { signal: ctrl.signal } as SimpleStreamOptions));
  const last = events.at(-1);
  const abortReason = last?.type === "error" ? last.reason : "n/a";
  ok("abort error does not freeze or try fallback", seen.join(",") === "primary" && last?.type === "error" && last.reason === "aborted" && notifications.length === 0, `seen=${seen.join(",")}, reason=${abortReason}, notifications=${notifications.join(";")}`);
  __configureFallbackModelsForTests([]);
}
{
  const synthetic = mockModel("synthetic-tool-call", "pi-subagent-resume");
  const fallback = mockModel("fallback");
  __configureFallbackModelsForTests(
    [{ model: fallback }],
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: () => undefined, setStatus: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  const seen: string[] = [];
  const delegate = (model: Model<Api>) => {
    seen.push(`${model.provider}/${model.id}`);
    return streamFrom([startEvent(), errorEvent("synthetic resume failed")]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, synthetic, {} as Context, {} as SimpleStreamOptions));
  ok("does not fallback/freeze internal synthetic models", seen.join(",") === "pi-subagent-resume/synthetic-tool-call" && events.at(-1)?.type === "error", `seen=${seen.join(",")}, last=${events.at(-1)?.type}`);
  __configureFallbackModelsForTests([]);
}
{
  const delegate = () => streamFrom([errorEvent("HTTP 401 Unauthorized")]);
  const events = await collect(streamWithLimitsRetry(delegate, mockModel(), {} as Context, {} as SimpleStreamOptions));
  ok("non-retryable yielded error is preceded by start", events[0]?.type === "start" && events[1]?.type === "error");
}
{
  const delegate = () => streamFrom([]);
  const events = await collect(streamWithLimitsRetry(delegate, mockModel(), {} as Context, {} as SimpleStreamOptions));
  ok("empty stream gets synthetic start and terminal error", events[0]?.type === "start" && events[1]?.type === "error");
}
{
  const delegate = () => streamFrom([doneEvent()]);
  const events = await collect(streamWithLimitsRetry(delegate, mockModel(), {} as Context, {} as SimpleStreamOptions));
  ok("done-only stream is preceded by synthetic start", events[0]?.type === "start" && events[1]?.type === "done");
}
{
  const delegate = async () => streamFrom([startEvent(), doneEvent()]);
  const events = await collect(streamWithLimitsRetry(delegate, mockModel(), {} as Context, {} as SimpleStreamOptions));
  ok("supports async provider streamSimple", events[0]?.type === "start" && events.at(-1)?.type === "done");
}

console.log(`\n${"═".repeat(64)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
