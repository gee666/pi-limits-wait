import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, getApiProvider, registerApiProvider, streamSimple as piStreamSimple } from "@mariozechner/pi-ai";
import {
  __configureFallbackModelsForTests,
  __readFallbackSettingsForTests,
  __setNonRetryableTuningForTests,
  freezingEnabled,
  getRetryableError,
  isAuthenticationRefreshError,
  isRateLimitError,
  isServerOverloadedError,
  isTransientNetworkError,
  retryAfterHeaderMs,
  sanitiseAnthropicPayloadSystem,
  sanitiseSystemPrompt,
  streamWithLimitsRetry,
  waitForRateLimit,
} from "../index.js";
import { registerWrappedApi } from "../stream.js";

// Keep non-retryable retry backoff tiny so the suite stays fast while still
// exercising the real retry-count behaviour.
__setNonRetryableTuningForTests(3, 2);

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
  ok("removes existing Claude Code identity before re-applying", !sanitiseSystemPrompt("You are Claude Code, Anthropic's official CLI for Claude.\n\nKeep this.").includes("Claude Code"));
  ok("strips host-harness identity clause", !sanitiseSystemPrompt("You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files.").includes("operating inside pi") && sanitiseSystemPrompt("You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files.").includes("You are an expert coding assistant"));
}

section("anthropic payload system sanitisation");
{
  const ccBlock = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } };
  const piPrompt = [
    "You are an expert coding assistant operating inside pi, a coding agent harness.",
    "Keep this useful instruction.",
    "Pi documentation:\n- Main: C:\\pi-coding-agent\\README.md\n- See @mariozechner/pi-coding-agent and badlogic/pi-mono.",
  ].join("\n\n");
  const payload = {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 128000,
    stream: true,
    system: [ccBlock, { type: "text", text: piPrompt, cache_control: { type: "ephemeral" } }],
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "medium" },
  };
  const result = sanitiseAnthropicPayloadSystem(payload) as typeof payload;
  ok("keeps Claude Code identity block", (result.system[0] as { text: string }).text === ccBlock.text);
  ok("keeps non-pi paragraphs in second block", (result.system[1] as { text: string }).text.includes("Keep this useful instruction."));
  ok("removes pi-anchor paragraphs from second block", !(result.system[1] as { text: string }).text.includes("pi-coding-agent") && !(result.system[1] as { text: string }).text.includes("badlogic/pi-mono"));
  ok("preserves unrelated payload fields", result.model === "claude-opus-4-8" && result.thinking.type === "adaptive" && result.output_config.effort === "medium");
  ok("preserves cache_control on second block", (result.system[1] as { cache_control: { type: string } }).cache_control.type === "ephemeral");
}
{
  // Non-OAuth Anthropic payload (no Claude Code identity block) is left untouched.
  const payload = { model: "claude-opus-4-8", system: [{ type: "text", text: "pi-coding-agent docs here" }] };
  ok("leaves non-OAuth Anthropic payload unchanged", sanitiseAnthropicPayloadSystem(payload) === payload);
}
{
  // Non-Anthropic / non-object payloads pass through unchanged.
  ok("leaves non-object payload unchanged", sanitiseAnthropicPayloadSystem(undefined) === undefined);
  {
    const noSystem = { model: "gpt", system: "single string" };
    ok("leaves payload without system array unchanged", sanitiseAnthropicPayloadSystem(noSystem) === noSystem);
  }
}
{
  // A second block that sanitises to empty is dropped entirely.
  const payload = { system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }, { type: "text", text: "@mariozechner/pi-coding-agent only" }] };
  const result = sanitiseAnthropicPayloadSystem(payload) as { system: unknown[] };
  ok("drops system blocks that become empty after sanitisation", result.system.length === 1);
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
  const resetUnixSeconds = Math.ceil((Date.now() + 2_000) / 1_000);
  const waitMs = getRetryableError(`Claude AI usage limit reached|${resetUnixSeconds}`)?.waitMs ?? 0;
  ok("parses Claude subscription pipe reset timestamp", waitMs > 0 && waitMs <= 3_500, `waitMs=${waitMs}`);
}
{
  const headers = new Headers({ "anthropic-ratelimit-requests-reset": new Date(Date.now() + 2_000).toISOString() });
  const waitMs = retryAfterHeaderMs(headers) ?? 0;
  ok("parses Anthropic reset headers without retry-after", waitMs > 0 && waitMs <= 2_500, `waitMs=${waitMs}`);
}

section("transient network / timeout detection");
ok("detects undici headers timeout", isTransientNetworkError("UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error"));
ok("detects undici body timeout", isTransientNetworkError("UND_ERR_BODY_TIMEOUT"));
ok("detects generic fetch failed", isTransientNetworkError("TypeError: fetch failed"));
ok("detects terminated stream", isTransientNetworkError("terminated"));
ok("detects ECONNRESET", isTransientNetworkError("read ECONNRESET socket hang up"));
ok("detects request timed out", isTransientNetworkError("Request timed out."));
ok("detects retry-failed request timed out", isTransientNetworkError("Retry failed after 3 attempts: Request timed out."));
ok("classifies request timed out as retryable network error", getRetryableError("Request timed out.")?.reason === "network");
ok("plain 400 is not a network error", !isTransientNetworkError("HTTP 400 Bad Request"));
ok("classifies headers timeout as retryable network error", getRetryableError("UND_ERR_HEADERS_TIMEOUT")?.reason === "network");
ok("network error uses short default backoff", getRetryableError("fetch failed")?.waitMs === 15_000);
ok("network error honors explicit retry-after", getRetryableError("fetch failed retry-after 0.01")?.waitMs === 10);

section("freezing toggle env var");
{
  const prev = process.env.PI_LIMITS_WAIT_FREEZING_ENABLED;
  delete process.env.PI_LIMITS_WAIT_FREEZING_ENABLED;
  ok("freezing enabled by default", freezingEnabled() === true);
  process.env.PI_LIMITS_WAIT_FREEZING_ENABLED = "false";
  ok("freezing disabled when set to false", freezingEnabled() === false);
  process.env.PI_LIMITS_WAIT_FREEZING_ENABLED = "0";
  ok("freezing disabled when set to 0", freezingEnabled() === false);
  process.env.PI_LIMITS_WAIT_FREEZING_ENABLED = "true";
  ok("freezing enabled when set to true", freezingEnabled() === true);
  if (prev === undefined) delete process.env.PI_LIMITS_WAIT_FREEZING_ENABLED;
  else process.env.PI_LIMITS_WAIT_FREEZING_ENABLED = prev;
}
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
  const prompts: Array<string | undefined> = [];
  const ctx = { modelRegistry: { isUsingOAuth: () => true }, ui: { notify: () => undefined, setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1];
  __configureFallbackModelsForTests([], ctx);
  let calls = 0;
  const delegate = (_model: Model<Api>, context: Context) => {
    prompts.push(context.systemPrompt);
    calls++;
    return calls === 1
      ? streamFrom([startEvent(), errorEvent("HTTP 429 retry-after 0.001")])
      : streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, mockModel("claude", "anthropic"), { systemPrompt: "You are pi, a coding agent.\n\nKeep this.", messages: [] }, {} as SimpleStreamOptions));
  ok("adds Claude Code identity to every retried Anthropic OAuth request", prompts.length === 2 && prompts.every((prompt) => prompt?.startsWith("You are Claude Code")) && prompts.every((prompt) => prompt?.includes("Keep this.") && !prompt.includes("You are pi")) && events.at(-1)?.type === "done", `prompts=${JSON.stringify(prompts)}`);
  __configureFallbackModelsForTests([]);
}
{
  const prompts: Array<string | undefined> = [];
  const ctx = { modelRegistry: { isUsingOAuth: () => true }, ui: { notify: () => undefined, setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1];
  __configureFallbackModelsForTests([], ctx);
  const delegate = (_model: Model<Api>, context: Context) => {
    prompts.push(context.systemPrompt);
    return streamFrom([startEvent(), doneEvent()]);
  };
  await collect(streamWithLimitsRetry(delegate, mockModel("gpt", "openai"), { systemPrompt: "You are pi, a coding agent.", messages: [] }, {} as SimpleStreamOptions));
  ok("does not add Claude Code identity to non-Anthropic providers", prompts[0] === "You are pi, a coding agent.", `prompt=${prompts[0]}`);
  __configureFallbackModelsForTests([]);
}
{
  const prompts: Array<string | undefined> = [];
  const ctx = { modelRegistry: { isUsingOAuth: () => false }, ui: { notify: () => undefined, setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1];
  __configureFallbackModelsForTests([], ctx);
  const delegate = (_model: Model<Api>, context: Context) => {
    prompts.push(context.systemPrompt);
    return streamFrom([startEvent(), doneEvent()]);
  };
  await collect(streamWithLimitsRetry(delegate, mockModel("claude", "anthropic"), { systemPrompt: "You are pi, a coding agent.\n\nKeep this.", messages: [] }, { apiKey: "sk-ant-oat-test" } as SimpleStreamOptions));
  ok("adds Claude Code identity when Anthropic OAuth token is supplied per request", Boolean(prompts[0]?.startsWith("You are Claude Code") && prompts[0]?.includes("Keep this.") && !prompts[0]?.includes("You are pi")), `prompt=${prompts[0]}`);
  __configureFallbackModelsForTests([]);
}
{
  const prompts: Array<string | undefined> = [];
  const ctx = { modelRegistry: { isUsingOAuth: () => true }, ui: { notify: () => undefined, setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1];
  __configureFallbackModelsForTests([], ctx);
  const delegate = (_model: Model<Api>, context: Context) => {
    prompts.push(context.systemPrompt);
    return streamFrom([startEvent(), doneEvent()]);
  };
  await collect(streamWithLimitsRetry(delegate, mockModel("claude", "anthropic"), { systemPrompt: "You are pi, a coding agent.", messages: [] }, { apiKey: "sk-ant-api-test" } as SimpleStreamOptions));
  ok("does not add Claude Code identity to Anthropic API-key requests even if OAuth is configured", prompts[0] === "You are pi, a coding agent.", `prompt=${prompts[0]}`);
  __configureFallbackModelsForTests([]);
}
{
  const prompts: Array<string | undefined> = [];
  const ctx = { modelRegistry: { isUsingOAuth: () => true }, ui: { notify: () => undefined, setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1];
  __configureFallbackModelsForTests([], ctx);
  const delegate = (_model: Model<Api>, context: Context) => {
    prompts.push(context.systemPrompt);
    return streamFrom([startEvent(), doneEvent()]);
  };
  await collect(streamWithLimitsRetry(delegate, mockModel("gpt", "openai"), { systemPrompt: "You are pi, a coding agent.", messages: [] }, { apiKey: "sk-ant-oat-test" } as SimpleStreamOptions));
  ok("does not add Claude Code identity to non-Anthropic requests even with an OAuth-looking token", prompts[0] === "You are pi, a coding agent.", `prompt=${prompts[0]}`);
  __configureFallbackModelsForTests([]);
}
{
  const prompts: Array<string | undefined> = [];
  const primary = mockModel("gpt", "openai");
  const fallback = mockModel("claude", "anthropic");
  __configureFallbackModelsForTests(
    [{ model: fallback }],
    { modelRegistry: { isUsingOAuth: () => false, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-ant-oat-fallback", headers: {} }) }, ui: { notify: () => undefined, setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  const delegate = (model: Model<Api>, context: Context) => {
    prompts.push(context.systemPrompt);
    return model.provider === "openai"
      ? streamFrom([startEvent(), errorEvent("HTTP 429 retry-after 0.01")])
      : streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, primary, { systemPrompt: "You are pi, a coding agent.\n\nKeep this.", messages: [] }, { apiKey: "openai-key" } as SimpleStreamOptions));
  ok("adds Claude Code identity to Anthropic OAuth fallback only", Boolean(prompts[0] === "You are pi, a coding agent.\n\nKeep this." && prompts[1]?.startsWith("You are Claude Code") && prompts[1]?.includes("Keep this.") && events.at(-1)?.type === "done"), `prompts=${JSON.stringify(prompts)}`);
  __configureFallbackModelsForTests([]);
}
{
  const prompts: Array<string | undefined> = [];
  const ctxOAuth = { modelRegistry: { isUsingOAuth: () => true }, ui: { notify: () => undefined, setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1];
  const ctxApiKey = { modelRegistry: { isUsingOAuth: () => false }, ui: { notify: () => undefined, setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1];
  __configureFallbackModelsForTests([], ctxOAuth);
  let calls = 0;
  const delegate = (_model: Model<Api>, context: Context) => {
    prompts.push(context.systemPrompt);
    calls++;
    if (calls === 1) {
      __configureFallbackModelsForTests([], ctxApiKey);
      return streamFrom([startEvent(), errorEvent("HTTP 429 retry-after 0.001")]);
    }
    return streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, mockModel("claude", "anthropic"), { systemPrompt: "You are pi, a coding agent.\n\nKeep this.", messages: [] }, {} as SimpleStreamOptions));
  ok("keeps Anthropic OAuth identity decision stable across retries even if shared context changes", prompts.length === 2 && prompts.every((prompt) => prompt?.startsWith("You are Claude Code")) && events.at(-1)?.type === "done", `prompts=${JSON.stringify(prompts)}`);
  __configureFallbackModelsForTests([]);
}
{
  const api = "limits-wait-test-rewrap" as Api;
  const model = { ...mockModel("claude", "anthropic"), api } as Model<Api>;
  const prompts: Array<string | undefined> = [];
  const pi = {
    registerProvider: (_name: string, config: { api?: Api; streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => ReturnType<typeof streamFrom> }) => {
      if (!config.api || !config.streamSimple) throw new Error("invalid test provider config");
      registerApiProvider({ api: config.api, stream: config.streamSimple as never, streamSimple: config.streamSimple as never }, "limits-wait-test-wrapper");
    },
  } as unknown as Parameters<typeof registerWrappedApi>[0];
  const installProvider = (label: string) => {
    const streamSimple = (_model: Model<Api>, context: Context) => {
      prompts.push(`${label}:${context.systemPrompt ?? ""}`);
      return streamFrom([startEvent(), doneEvent()]);
    };
    registerApiProvider({ api, stream: streamSimple as never, streamSimple: streamSimple as never }, `limits-wait-test-${label}`);
  };

  installProvider("first");
  registerWrappedApi(pi, api);
  const wrappedOnce = getApiProvider(api)?.streamSimple;
  registerWrappedApi(pi, api);
  const wrappedTwice = getApiProvider(api)?.streamSimple;
  await collect(piStreamSimple(model, { systemPrompt: "You are pi, a coding agent.\n\nKeep this.", messages: [] }, { apiKey: "sk-ant-oat-test" } as SimpleStreamOptions));

  installProvider("second");
  registerWrappedApi(pi, api);
  const wrappedAfterOverwrite = getApiProvider(api)?.streamSimple;
  await collect(piStreamSimple(model, { systemPrompt: "You are pi, a coding agent.\n\nKeep this.", messages: [] }, { apiKey: "sk-ant-oat-test" } as SimpleStreamOptions));

  ok("keeps API wrapping idempotent, but re-wraps if another provider overwrites it", Boolean(wrappedOnce && wrappedOnce === wrappedTwice && wrappedAfterOverwrite !== wrappedOnce && prompts.length === 2 && prompts.every((prompt) => prompt?.includes("You are Claude Code")) && prompts[1]?.startsWith("second:")), `prompts=${JSON.stringify(prompts)}`);
}
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
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: (message: string) => notifications.push(message), setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
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
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: () => undefined, setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
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
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: (message: string) => notifications.push(message), setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  const seen: string[] = [];
  const delegate = (model: Model<Api>) => {
    seen.push(model.id);
    return model.id === "primary"
      ? streamFrom([startEvent(), errorEvent("HTTP 400 Bad Request")])
      : streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, primary, {} as Context, {} as SimpleStreamOptions));
  ok("retries then freezes failed model and tries fallback on unclassified non-retryable errors", seen.join(",") === "primary,primary,primary,fallback" && events.at(-1)?.type === "done" && notifications.some((message) => message.includes("HTTP 400 Bad Request") && message.includes("freezing it")), `seen=${seen.join(",")}, last=${events.at(-1)?.type}, notifications=${notifications.join(";")}`);
  __configureFallbackModelsForTests([]);
}
{
  const primary = mockModel("primary");
  const fallback = mockModel("fallback");
  const notifications: string[] = [];
  __configureFallbackModelsForTests(
    [{ model: fallback }],
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: (message: string) => notifications.push(message), setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
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
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: () => undefined, setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  const seen: string[] = [];
  const delegate = (model: Model<Api>) => {
    seen.push(`${model.provider}/${model.id}`);
    return streamFrom([startEvent(), errorEvent("synthetic resume failed")]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, synthetic, {} as Context, {} as SimpleStreamOptions));
  ok("does not fallback/freeze internal synthetic models (still bounded-retries then errors)", seen.every((id) => id === "pi-subagent-resume/synthetic-tool-call") && seen.length === 3 && events.at(-1)?.type === "error", `seen=${seen.join(",")}, last=${events.at(-1)?.type}`);
  __configureFallbackModelsForTests([]);
}
{
  // Network/timeout stalls (undici idle-timeout aborts) must be retried, not
  // treated as a hard failure that freezes the model. This is the regression
  // that caused the silent multi-minute/hour subagent hang.
  let calls = 0;
  const delegate = () => {
    calls++;
    return calls === 1
      ? streamFrom([startEvent(), errorEvent("UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error retry-after 0.01")])
      : streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, mockModel(), {} as Context, {} as SimpleStreamOptions));
  ok("retries undici timeout (network) error then succeeds", calls === 2 && events.at(-1)?.type === "done", `calls=${calls}, last=${events.at(-1)?.type}`);
}
{
  const primary = mockModel("primary");
  const fallback = mockModel("fallback");
  const notifications: string[] = [];
  __configureFallbackModelsForTests(
    [{ model: fallback }],
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: (message: string) => notifications.push(message), setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  const seen: string[] = [];
  const delegate = (model: Model<Api>) => {
    seen.push(model.id);
    return seen.length === 1
      ? streamFrom([startEvent(), errorEvent("TypeError: fetch failed retry-after 0.01")])
      : streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, primary, {} as Context, {} as SimpleStreamOptions));
  ok("network error retries same model instead of switching to fallback", seen.join(",") === "primary,primary" && events.at(-1)?.type === "done", `seen=${seen.join(",")}, last=${events.at(-1)?.type}`);
  ok("network warning is shown", notifications.some((message) => message.includes("network/timeout error") && message.includes("fetch failed")), `notifications=${notifications.join(";")}`);
  __configureFallbackModelsForTests([]);
}
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("rate limited", { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "0.01" } })) as typeof fetch;
  const notifications: string[] = [];
  __configureFallbackModelsForTests(
    [],
    { ui: { notify: (message: string) => notifications.push(message), setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  let calls = 0;
  const delegate = async () => {
    calls++;
    if (calls === 1) {
      await fetch("https://example.invalid/rate-limited");
      return streamFrom([startEvent(), errorEvent("HTTP 429 Too Many Requests")]);
    }
    return streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, mockModel(), {} as Context, {} as SimpleStreamOptions));
  ok("uses observed retry-after when SDK 429 error omits headers", calls === 2 && events.at(-1)?.type === "done", `calls=${calls}, last=${events.at(-1)?.type}`);
  ok("retryable warning is shown immediately without fallback", notifications.some((message) => message.includes("HTTP 429 Too Many Requests") && message.includes("rate limited")), `notifications=${notifications.join(";")}`);
  __configureFallbackModelsForTests([]);
  globalThis.fetch = originalFetch;
}
{
  const primary = mockModel("primary");
  const fallback = mockModel("fallback");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("temporary outage", { status: 503, statusText: "Service Unavailable" })) as typeof fetch;
  const notifications: string[] = [];
  __configureFallbackModelsForTests(
    [{ model: fallback }],
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: (message: string) => notifications.push(message), setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  let calls = 0;
  const delegate = async () => {
    calls++;
    if (calls === 1) {
      await fetch("https://example.invalid/unavailable");
      return streamFrom([startEvent(), errorEvent("TypeError: fetch failed retry-after 0.01")]);
    }
    return streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, primary, {} as Context, {} as SimpleStreamOptions));
  ok("warning includes observed HTTP status together with fetch error", events.at(-1)?.type === "done" && notifications.some((message) => message.includes("HTTP 503 Service Unavailable") && message.includes("fetch failed")), `notifications=${notifications.join(";")}`);
  __configureFallbackModelsForTests([]);
  globalThis.fetch = originalFetch;
}
{
  // An unclassified non-retryable error recovers if a later attempt succeeds,
  // within the bounded retry budget, without any fallback configured.
  const notifications: string[] = [];
  __configureFallbackModelsForTests(
    [],
    { ui: { notify: (message: string) => notifications.push(message), setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  let calls = 0;
  const delegate = () => {
    calls++;
    return calls < 3
      ? streamFrom([startEvent(), errorEvent("HTTP 500 Internal Server Error")])
      : streamFrom([startEvent(), doneEvent()]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, mockModel(), {} as Context, {} as SimpleStreamOptions));
  ok("retries unclassified error up to the limit then succeeds (no fallback)", calls === 3 && events.at(-1)?.type === "done", `calls=${calls}, last=${events.at(-1)?.type}`);
  ok("unclassified retry warning includes provider error immediately", notifications.some((message) => message.includes("retrying after error") && message.includes("HTTP 500 Internal Server Error")), `notifications=${notifications.join(";")}`);
  __configureFallbackModelsForTests([]);
}
{
  // With freezing disabled, a persistently failing model must never enter the
  // long "model-frozen" wait; it tries each configured candidate once (after
  // its retry budget) and then surfaces the error.
  process.env.PI_LIMITS_WAIT_FREEZING_ENABLED = "false";
  const primary = mockModel("primary");
  const fallback = mockModel("fallback");
  const notifications: string[] = [];
  __configureFallbackModelsForTests(
    [{ model: fallback }],
    { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fallback-key", headers: {} }) }, ui: { notify: (message: string) => notifications.push(message), setStatus: () => undefined, setWorkingMessage: () => undefined } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  const seen: string[] = [];
  const delegate = (model: Model<Api>) => {
    seen.push(model.id);
    return streamFrom([startEvent(), errorEvent("HTTP 400 Bad Request")]);
  };
  const events = await collect(streamWithLimitsRetry(delegate, primary, {} as Context, {} as SimpleStreamOptions));
  const last = events.at(-1);
  ok("freezing disabled: tries each candidate without freezing then errors", seen.join(",") === "primary,primary,primary,fallback,fallback,fallback" && last?.type === "error" && !notifications.some((m) => m.includes("freezing it")), `seen=${seen.join(",")}, last=${last?.type}, notifications=${notifications.join(";")}`);
  __configureFallbackModelsForTests([]);
  delete process.env.PI_LIMITS_WAIT_FREEZING_ENABLED;
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
