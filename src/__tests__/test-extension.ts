import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  __configureFallbackModelsForTests,
  __readFallbackSettingsForTests,
  __setNonRetryableTuningForTests,
  freezingEnabled,
  getRetryableError,
  installModelRuntimeInterception,
  isAuthenticationRefreshError,
  isRateLimitError,
  isServerOverloadedError,
  isTransientNetworkError,
  loadUnknownErrorRetrySettings,
  retryAfterHeaderMs,
  sanitiseAnthropicPayloadSystem,
  sanitiseSystemPrompt,
  streamWithLimitsRetry,
  waitForRateLimit,
} from "../index.js";
import { withAttemptResponseObserver } from "../response-observer.js";
import { consumeExpectedModelSelection, expectModelSelection, state } from "../state.js";

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}${detail ? `  →  ${detail}` : ""}`);
    failed++;
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

function message(model: Model<Api>) {
  return {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}
function startEvent(model: Model<Api>): AssistantMessageEvent {
  return { type: "start", partial: message(model) };
}
function errorEvent(model: Model<Api>, text: string): AssistantMessageEvent {
  return { type: "error", reason: "error", error: { ...message(model), stopReason: "error", errorMessage: text } };
}
function doneEvent(model: Model<Api>): AssistantMessageEvent {
  return { type: "done", reason: "stop", message: message(model) };
}
function textEvent(model: Model<Api>): AssistantMessageEvent {
  return { type: "text_start", contentIndex: 0, partial: { ...message(model), content: [{ type: "text", text: "" }] } };
}
function streamFrom(events: AssistantMessageEvent[]) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) stream.push(event);
    stream.end();
  });
  return stream;
}
async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function endsAborted(events: AssistantMessageEvent[]): boolean {
  const last = events.at(-1);
  return last?.type === "error" && last.reason === "aborted";
}

section("prompt sanitisation");
{
  const raw = [
    "You are pi, a coding agent.",
    "Keep this useful instruction.",
    "Internal docs mention @earendil-works/pi-coding-agent and should be removed.",
  ].join("\n\n");
  const sanitised = sanitiseSystemPrompt(raw);
  ok("removes Pi identity and internal paths", !sanitised.includes("You are pi") && !sanitised.includes("pi-coding-agent"));
  ok("keeps unrelated instructions", sanitised.includes("Keep this useful instruction."));
}
{
  const identity = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } };
  const payload = { model: "claude", system: [identity, { type: "text", text: "You are pi, a coding agent.\n\nKeep this.", cache_control: { type: "ephemeral" } }] };
  const result = sanitiseAnthropicPayloadSystem(payload) as typeof payload;
  ok("recognises the current Pi OAuth first identity block", result !== payload && result.system[0] === identity);
  ok("sanitises only following host blocks", !result.system[1]!.text.includes("You are pi") && result.system[1]!.text.includes("Keep this"));
  const laterIdentity = { system: [{ type: "text", text: "ordinary" }, identity] };
  ok("does not use a later identity mention as OAuth proof", sanitiseAnthropicPayloadSystem(laterIdentity) === laterIdentity);
  const approximate = { system: [{ type: "text", text: `${identity.text} Extra user text` }, { type: "text", text: "You are pi" }] };
  ok("requires the exact Pi-generated identity block", sanitiseAnthropicPayloadSystem(approximate) === approximate);
  const apiKeyShape = { system: [{ type: "text", text: "pi-coding-agent docs" }] };
  ok("leaves API-key/non-OAuth payload shape untouched", sanitiseAnthropicPayloadSystem(apiKeyShape) === apiKeyShape);
}

section("retry classification");
ok("detects 429", isRateLimitError("HTTP 429 Too Many Requests"));
ok("detects overload", isServerOverloadedError("server_is_overloaded"));
ok("detects refresh-style 401", isAuthenticationRefreshError('401 {"type":"authentication_error","message":"Invalid authentication credentials"}'));
ok("detects network timeout", isTransientNetworkError("UND_ERR_HEADERS_TIMEOUT"));
ok("classifies explicit network retry", getRetryableError("fetch failed retry-after 0.01")?.reason === "network");
{
  const headers = new Headers({ "retry-after": "0.01" });
  ok("reads retry-after response header", retryAfterHeaderMs(headers) === 10);
}

section("settings and waits");
{
  const previous = process.env.PI_LIMITS_WAIT_FREEZING_ENABLED;
  process.env.PI_LIMITS_WAIT_FREEZING_ENABLED = "false";
  ok("freezing environment switch works", !freezingEnabled());
  if (previous === undefined) delete process.env.PI_LIMITS_WAIT_FREEZING_ENABLED;
  else process.env.PI_LIMITS_WAIT_FREEZING_ENABLED = previous;
}
{
  const previous = {
    waiting: process.env.PI_LIMITS_WAIT_DEFAULT_WAITING,
    maxRetry: process.env.PI_LIMITS_WAIT_MAX_RETRY,
    interval: process.env.PI_LIMITS_WAIT_RETRY_INTERVAL,
  };
  process.env.PI_LIMITS_WAIT_DEFAULT_WAITING = "false";
  process.env.PI_LIMITS_WAIT_MAX_RETRY = "7";
  process.env.PI_LIMITS_WAIT_RETRY_INTERVAL = "2";
  loadUnknownErrorRetrySettings();
  ok("unknown-error retry environment settings work", !state.unknownErrorWaitingEnabled && state.nonRetryableMaxAttempts === 8 && state.nonRetryableRetryDelayMs === 2_000);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key === "waiting" ? "PI_LIMITS_WAIT_DEFAULT_WAITING" : key === "maxRetry" ? "PI_LIMITS_WAIT_MAX_RETRY" : "PI_LIMITS_WAIT_RETRY_INTERVAL"];
    else process.env[key === "waiting" ? "PI_LIMITS_WAIT_DEFAULT_WAITING" : key === "maxRetry" ? "PI_LIMITS_WAIT_MAX_RETRY" : "PI_LIMITS_WAIT_RETRY_INTERVAL"] = value;
  }
  loadUnknownErrorRetrySettings();
}
{
  const controller = new AbortController();
  controller.abort();
  ok("pre-aborted wait resolves immediately", await waitForRateLimit(60_000, controller.signal) === "aborted");
}
{
  const root = mkdtempSync(join(tmpdir(), "limits-wait-"));
  try {
    const home = join(root, "home");
    const agent = join(root, "agent");
    const project = join(root, "project");
    mkdirSync(join(home, ".config", ".pi"), { recursive: true });
    mkdirSync(agent, { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(home, ".config", ".pi", "limits-wait.json"), JSON.stringify({ keep: "home" }));
    writeFileSync(join(agent, "limits-wait.json"), JSON.stringify({ keep: "agent" }));
    writeFileSync(join(project, ".limits-wait.json"), JSON.stringify({ keep: "root" }));
    writeFileSync(join(project, ".pi", "limits-wait.json"), JSON.stringify({ keep: "project" }));
    const resolved = __readFallbackSettingsForTests(project, agent, home);
    ok("loads settings in documented precedence", resolved.loadedPaths.length === 4 && resolved.config.keep === "project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
{
  const root = mkdtempSync(join(tmpdir(), "limits-wait-refresh-"));
  try {
    const settingsDir = join(root, ".pi");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "limits-wait.json");
    const primary = { provider: "refresh", id: "primary", api: "openai-completions" } as Model<Api>;
    const first = { provider: "refresh", id: "first", api: "openai-completions" } as Model<Api>;
    const second = { provider: "refresh", id: "second", api: "openai-completions" } as Model<Api>;
    const models = new Map([[first.id, first], [second.id, second]]);
    const ctx = {
      cwd: root,
      modelRegistry: {
        find: (provider: string, id: string) => provider === "refresh" ? models.get(id) : undefined,
        hasConfiguredAuth: () => true,
      },
      ui: { notify: () => undefined },
    } as unknown as ExtensionContext;
    const seen: string[] = [];
    const delegate = ((_model: Model<Api>) => {
      seen.push(state.fallbackModels[0]?.model.id ?? "none");
      return streamFrom([doneEvent(primary)]);
    }) as Parameters<typeof streamWithLimitsRetry>[1];
    const requestContext: Context = { systemPrompt: "", messages: [] };

    state.sharedCtx = ctx;
    state.primaryModel = primary;
    writeFileSync(settingsPath, JSON.stringify({ "fallback-models": [{ provider: "refresh", modelname: "first" }] }));
    await collect(streamWithLimitsRetry({} as ModelRuntime, delegate, primary, requestContext));
    writeFileSync(settingsPath, JSON.stringify({ "fallback-models": [{ provider: "refresh", modelname: "second" }] }));
    await collect(streamWithLimitsRetry({} as ModelRuntime, delegate, primary, requestContext));

    ok("reloads fallback settings before every LLM call", seen.join(",") === "first,second", `seen=${seen.join(",")}`);
  } finally {
    __configureFallbackModelsForTests([]);
    rmSync(root, { recursive: true, force: true });
  }
}

const context: Context = { systemPrompt: "You are pi, a coding agent.\n\nKeep this.", messages: [] };
function mockSelectionModel(id: string): Model<Api> {
  return { provider: "selection", id } as Model<Api>;
}
type ProviderCall = { model: Model<Api>; options?: ModelsSimpleStreamOptions };

async function createRuntime(
  handlers: Record<string, (model: Model<Api>, options?: ModelsSimpleStreamOptions) => ReturnType<typeof streamFrom>>,
  calls: Record<string, ProviderCall[]>,
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  for (const [provider, handler] of Object.entries(handlers)) {
    runtime.registerProvider(provider, {
      baseUrl: `https://${provider}.example/v1`,
      apiKey: `${provider}-configured-key`,
      headers: { [`x-${provider}`]: "configured" },
      api: "openai-completions",
      models: [{
        id: `${provider}-model`,
        name: `${provider} model`,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      }],
      streamSimple(model, _requestContext, options) {
        (calls[provider] ??= []).push({ model, options });
        return handler(model, options);
      },
    });
  }
  return runtime;
}

section("unknown-error retry integration");
{
  const calls: Record<string, ProviderCall[]> = {};
  let attempts = 0;
  const runtime = await createRuntime({
    unknown(model) {
      attempts++;
      return attempts === 1
        ? streamFrom([startEvent(model), errorEvent(model, "Internal server error")])
        : streamFrom([startEvent(model), doneEvent(model)]);
    },
  }, calls);
  const model = runtime.getModel("unknown", "unknown-model")!;
  state.unknownErrorWaitingEnabled = true;
  __setNonRetryableTuningForTests(2, 0);
  const release = installModelRuntimeInterception();
  const events = await collect(runtime.streamSimple(model, context));
  ok("unknown errors wait and retry by default", attempts === 2 && events.at(-1)?.type === "done");
  release();
  __setNonRetryableTuningForTests(1_000_000, 5_000);
}
{
  const calls: Record<string, ProviderCall[]> = {};
  const runtime = await createRuntime({
    unknown(model) { return streamFrom([startEvent(model), errorEvent(model, "Internal server error")]); },
  }, calls);
  const model = runtime.getModel("unknown", "unknown-model")!;
  state.unknownErrorWaitingEnabled = false;
  const release = installModelRuntimeInterception();
  const events = await collect(runtime.streamSimple(model, context));
  ok("disabled unknown-error waiting surfaces the first failure", calls.unknown?.length === 1 && events.at(-1)?.type === "error");
  release();
  state.unknownErrorWaitingEnabled = true;
}

section("real ModelRuntime retry integration");
{
  const calls: Record<string, ProviderCall[]> = {};
  let attempts = 0;
  let formalResponses = 0;
  const runtime = await createRuntime({
    primary(model, options) {
      attempts++;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        try {
          await options?.onResponse?.({ status: attempts === 1 ? 429 : 200, headers: attempts === 1 ? { "retry-after": "0.001" } : {} }, model);
          stream.push(startEvent(model));
          stream.push(doneEvent(model));
        } catch (error) {
          stream.push(startEvent(model));
          stream.push(errorEvent(model, error instanceof Error ? error.message : String(error)));
        }
        stream.end();
      });
      return stream;
    },
  }, calls);
  const model = runtime.getModel("primary", "primary-model")!;
  const getAuth = runtime.getAuth.bind(runtime);
  let authResolutions = 0;
  runtime.getAuth = ((...args: Parameters<ModelRuntime["getAuth"]>) => {
    authResolutions++;
    return getAuth(...args as [Model<Api>, object]);
  }) as ModelRuntime["getAuth"];
  const release = installModelRuntimeInterception();
  const returned = runtime.streamSimple(model, context, { onResponse: () => { formalResponses++; } });
  ok("streamSimple remains synchronous", typeof (returned as { then?: unknown }).then !== "function");
  const events = await collect(returned);
  ok("429 response retries through current ModelRuntime", attempts === 2 && events.at(-1)?.type === "done", `attempts=${attempts}`);
  ok("auth is resolved afresh on every attempt", authResolutions === 2, `authResolutions=${authResolutions}`);
  ok("composes the existing onResponse callback before retry", formalResponses === 2, `responses=${formalResponses}`);
  release();
}

section("exact-model configured reasoning");
for (const configured of ["off", "high"] as const) {
  const calls: Record<string, ProviderCall[]> = {};
  let attempts = 0;
  const runtime = await createRuntime({
    reasoning(model) {
      attempts++;
      return attempts === 1
        ? streamFrom([startEvent(model), errorEvent(model, "fetch failed retry-after 0.001")])
        : streamFrom([startEvent(model), doneEvent(model)]);
    },
  }, calls);
  const model = runtime.getModel("reasoning", "reasoning-model")!;
  __configureFallbackModelsForTests([{ model, reasoningEffort: configured }]);
  const release = installModelRuntimeInterception();
  const events = await collect(runtime.streamSimple(model, context, { reasoning: configured === "off" ? "high" : "low" }));
  const levels = calls.reasoning?.map((call) => call.options?.reasoning);
  ok(
    configured === "off" ? "configured reasoning off removes incoming reasoning on primary and retry" : "configured reasoning overrides incoming reasoning on primary and retry",
    attempts === 2 && levels?.every((level) => level === (configured === "off" ? undefined : configured)) === true && events.at(-1)?.type === "done",
    `levels=${levels?.join(",")}`,
  );
  release();
  __configureFallbackModelsForTests([]);
}
{
  const calls: Record<string, ProviderCall[]> = {};
  let primaryCalls = 0;
  const runtime = await createRuntime({
    cyclePrimary(model) {
      primaryCalls++;
      return primaryCalls === 1
        ? streamFrom([startEvent(model), errorEvent(model, "HTTP 429 retry-after 0.01")])
        : streamFrom([startEvent(model), doneEvent(model)]);
    },
    cycleFallback(model) {
      return streamFrom([startEvent(model), errorEvent(model, "HTTP 429 retry-after 0.01")]);
    },
  }, calls);
  const primary = runtime.getModel("cyclePrimary", "cyclePrimary-model")!;
  const fallback = runtime.getModel("cycleFallback", "cycleFallback-model")!;
  __configureFallbackModelsForTests([{ model: primary, reasoningEffort: "off" }, { model: fallback }]);
  const release = installModelRuntimeInterception();
  const events = await collect(runtime.streamSimple(primary, context, { reasoning: "high", signal: AbortSignal.timeout(2_000) }));
  const primaryLevels = calls.cyclePrimary?.map((call) => call.options?.reasoning);
  ok("configured exact-model reasoning survives rate-limit fallback cycling", primaryCalls === 2 && primaryLevels?.every((level) => level === undefined) === true && events.at(-1)?.type === "done", `levels=${primaryLevels?.join(",")}`);
  release();
  __configureFallbackModelsForTests([]);
}

section("authentication and network retry semantics");
{
  const calls: Record<string, ProviderCall[]> = {};
  let attempts = 0;
  const runtime = await createRuntime({
    auth(model) {
      attempts++;
      return attempts === 1
        ? streamFrom([startEvent(model), errorEvent(model, '401 {"type":"authentication_error","message":"Invalid authentication credentials"} retry-after 0.001')])
        : streamFrom([startEvent(model), doneEvent(model)]);
    },
  }, calls);
  const model = runtime.getModel("auth", "auth-model")!;
  const getAuth = runtime.getAuth.bind(runtime);
  let authResolutions = 0;
  runtime.getAuth = ((...args: Parameters<ModelRuntime["getAuth"]>) => {
    authResolutions++;
    return getAuth(...args as [Model<Api>, object]);
  }) as ModelRuntime["getAuth"];
  const release = installModelRuntimeInterception();
  const events = await collect(runtime.streamSimple(model, context));
  ok("authentication refresh errors re-enter runtime auth", attempts === 2 && authResolutions === 2 && events.at(-1)?.type === "done");
  release();
}
{
  const calls: Record<string, ProviderCall[]> = {};
  let attempts = 0;
  const runtime = await createRuntime({
    network(model) {
      attempts++;
      return attempts === 1
        ? streamFrom([startEvent(model), errorEvent(model, "fetch failed retry-after 0.001")])
        : streamFrom([startEvent(model), doneEvent(model)]);
    },
    fallback(model) { return streamFrom([startEvent(model), doneEvent(model)]); },
  }, calls);
  const primary = runtime.getModel("network", "network-model")!;
  const fallback = runtime.getModel("fallback", "fallback-model")!;
  __configureFallbackModelsForTests([{ model: fallback }]);
  const release = installModelRuntimeInterception();
  const events = await collect(runtime.streamSimple(primary, context));
  ok("network errors retry the same runtime model", calls.network?.length === 2 && !calls.fallback && events.at(-1)?.type === "done");
  release();
  __configureFallbackModelsForTests([]);
}

section("installed OpenAI provider HTTP integration");
{
  let requests = 0;
  let providerStatuses = [429, 500, 200];
  const server = createServer((request, response) => {
    if (request.url === "/unrelated") {
      response.writeHead(503, { "content-type": "text/plain", "retry-after": "120" });
      response.end("unrelated extension fetch");
      return;
    }
    requests++;
    const status = providerStatuses[requests - 1] ?? 200;
    if (status >= 400) {
      response.writeHead(status, { "content-type": "application/json", "retry-after": "0.001" });
      response.end(JSON.stringify({ error: { message: status === 429 ? "limited" : "overloaded", type: status === 429 ? "rate_limit_error" : "server_error" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: "http-model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: "http-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    runtime.registerProvider("http-openai", {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "local-test-key",
      api: "openai-completions",
      models: [{
        id: "http-model", name: "HTTP model", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096,
      }],
    });
    const model = runtime.getModel("http-openai", "http-model")!;
    const release = installModelRuntimeInterception();
    const started = Date.now();
    const formalResponses: number[] = [];
    const events = await collect(runtime.streamSimple(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }, {
      maxRetries: 2,
      signal: AbortSignal.timeout(2_000),
      onPayload: async () => {
        // This failed nested fetch shares the attempt's async chain but is not
        // a provider URL and must not overwrite provider response metadata.
        await fetch(`http://127.0.0.1:${address.port}/unrelated`);
        return undefined;
      },
      onResponse: (response) => { formalResponses.push(response.status); },
    }));
    ok("real installed provider preserves Retry-After from SDK-hidden failures", requests === 3 && events.at(-1)?.type === "done" && Date.now() - started < 2_000, `requests=${requests}, elapsed=${Date.now() - started}`);
    ok("observer delivers mixed failed and successful formal responses exactly once", formalResponses.join(",") === "429,500,200", `responses=${formalResponses.join(",")}`);

    requests = 0;
    providerStatuses = [429, 429, 200];
    const repeatedResponses: number[] = [];
    const repeatedEvents = await collect(runtime.streamSimple(model, { messages: [{ role: "user", content: "hello again", timestamp: Date.now() }] }, {
      maxRetries: 2,
      signal: AbortSignal.timeout(2_000),
      onResponse: (response) => { repeatedResponses.push(response.status); },
    }));
    ok("observer preserves repeated hidden statuses without deduplicating distinct responses", repeatedEvents.at(-1)?.type === "done" && repeatedResponses.join(",") === "429,429,200", `responses=${repeatedResponses.join(",")}`);

    requests = 0;
    providerStatuses = [429, 200];
    const overrideRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    overrideRuntime.registerProvider("runtime-override", {
      baseUrl: "https://pre-prepare.invalid/v1",
      apiKey: "override-key",
      api: "openai-completions",
      models: [{
        id: "override-model", name: "Override model", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096,
      }],
    });
    const overrideModel = overrideRuntime.getModel("runtime-override", "override-model")!;
    const originalGetAuth = overrideRuntime.getAuth.bind(overrideRuntime);
    overrideRuntime.getAuth = (async (...args: Parameters<ModelRuntime["getAuth"]>) => {
      const resolution = await originalGetAuth(...args as [Model<Api>, object]);
      return resolution ? {
        ...resolution,
        auth: { ...resolution.auth, baseUrl: `http://127.0.0.1:${address.port}/v1` },
      } : resolution;
    }) as ModelRuntime["getAuth"];
    const overrideResponses: number[] = [];
    const overrideEvents = await collect(overrideRuntime.streamSimple(overrideModel, { messages: [{ role: "user", content: "override", timestamp: Date.now() }] }, {
      maxRetries: 1,
      signal: AbortSignal.timeout(2_000),
      onResponse: (response) => { overrideResponses.push(response.status); },
    }));
    ok("observer follows the runtime/credential-overridden effective endpoint", overrideModel.baseUrl.includes("pre-prepare.invalid") && requests === 2 && overrideEvents.at(-1)?.type === "done" && overrideResponses.join(",") === "429,200", `requests=${requests}, responses=${overrideResponses.join(",")}`);
    release();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
{
  const installed = globalThis.fetch;
  const laterOwner = (async (...args: Parameters<typeof fetch>) => installed(...args)) as typeof fetch;
  globalThis.fetch = laterOwner;
  const result = await withAttemptResponseObserver(() => undefined, async () => "pass-through");
  ok("observer does not stack over or overwrite a later fetch owner", result === "pass-through" && globalThis.fetch === laterOwner);
  globalThis.fetch = installed;
}

section("real ModelRuntime fallback and option isolation");
{
  const calls: Record<string, ProviderCall[]> = {};
  const payloadModels: string[] = [];
  const runtime = await createRuntime({
    primary(model, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        try {
          await options?.onResponse?.({ status: 429, headers: { "retry-after": "60" } }, model);
        } catch (error) {
          stream.push(errorEvent(model, error instanceof Error ? error.message : String(error)));
        }
        stream.end();
      });
      return stream;
    },
    fallback(model, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        await options?.onPayload?.({ model: model.id }, model);
        await options?.onResponse?.({ status: 200, headers: {} }, model);
        stream.push(startEvent(model));
        stream.push(doneEvent(model));
        stream.end();
      });
      return stream;
    },
  }, calls);
  const primary = runtime.getModel("primary", "primary-model")!;
  const fallback = runtime.getModel("fallback", "fallback-model")!;
  __configureFallbackModelsForTests([{ model: fallback }]);
  const release = installModelRuntimeInterception();
  const events = await collect(runtime.streamSimple(primary, context, {
    apiKey: "primary-explicit-secret",
    headers: { authorization: "Bearer primary-secret", "x-primary-only": "yes" },
    env: { PRIMARY_SECRET: "yes" },
    transformHeaders: (headers) => ({ ...headers, "x-transformed-primary": "yes" }),
    onPayload: (_payload, currentModel) => { payloadModels.push(currentModel.provider); },
  }));
  const fallbackOptions = calls.fallback?.[0]?.options;
  ok("fallback delegates through the target provider runtime", calls.primary?.length === 1 && calls.fallback?.length === 1 && events.at(-1)?.type === "done", `primary=${calls.primary?.length}, fallback=${calls.fallback?.length}, last=${events.at(-1)?.type}`);
  ok("target runtime composes fallback auth and configured headers", fallbackOptions?.apiKey === "fallback-configured-key" && fallbackOptions.headers?.["x-fallback"] === "configured");
  ok("does not leak primary auth/header/env transforms across providers", !fallbackOptions?.headers?.authorization && !("PRIMARY_SECRET" in (fallbackOptions?.env ?? {})) && !("x-primary-only" in (fallbackOptions?.headers ?? {})) && !("x-transformed-primary" in (fallbackOptions?.headers ?? {})));
  ok("preserves formal onPayload flow for fallback", payloadModels.join(",") === "fallback", `payloadModels=${payloadModels}`);
  release();
  __configureFallbackModelsForTests([]);
}
{
  const calls: Record<string, ProviderCall[]> = {};
  const runtime = await createRuntime({
    same(model) {
      return model.id === "same-model"
        ? streamFrom([startEvent(model), errorEvent(model, "HTTP 429 retry-after 60")])
        : streamFrom([startEvent(model), doneEvent(model)]);
    },
  }, calls);
  const primary = runtime.getModel("same", "same-model")!;
  const fallback = { ...primary, id: "same-fallback", name: "same fallback" };
  __configureFallbackModelsForTests([{ model: fallback, reasoningEffort: "off" }]);
  const release = installModelRuntimeInterception();
  const events = await collect(runtime.streamSimple(primary, context, {
    reasoning: "high",
    apiKey: "same-source-secret",
    headers: { authorization: "Bearer same-source", "x-source-only": "yes" },
    env: { SAME_SOURCE_SECRET: "yes" },
    transformHeaders: (headers) => ({ ...headers, "x-source-transform": "yes" }),
    sourceProviderOption: "must-not-leak",
  } as ModelsSimpleStreamOptions));
  const fallbackOptions = calls.same?.[1]?.options as (ModelsSimpleStreamOptions & { sourceProviderOption?: string }) | undefined;
  ok("same-provider fallback honours explicit reasoning off", fallbackOptions?.reasoning === undefined && events.at(-1)?.type === "done", `calls=${calls.same?.length}, reasoning=${fallbackOptions?.reasoning}, last=${events.at(-1)?.type}`);
  ok("same-provider fallback re-resolves canonical target auth/headers", fallbackOptions?.apiKey === "same-configured-key" && fallbackOptions.headers?.["x-same"] === "configured");
  ok("same-provider fallback isolates source credentials and provider options", !fallbackOptions?.headers?.authorization && !("SAME_SOURCE_SECRET" in (fallbackOptions?.env ?? {})) && !fallbackOptions?.headers?.["x-source-only"] && !fallbackOptions?.headers?.["x-source-transform"] && fallbackOptions?.sourceProviderOption === undefined);
  release();
  __configureFallbackModelsForTests([]);
}

section("concurrent model selection tracking");
{
  const first = mockSelectionModel("first");
  const second = mockSelectionModel("second");
  const unrelated = mockSelectionModel("unrelated");
  const cancelFirst = expectModelSelection(first);
  const cancelSecond = expectModelSelection(second);
  const consumedOutOfOrder = consumeExpectedModelSelection(second)
    && !consumeExpectedModelSelection(unrelated)
    && consumeExpectedModelSelection(first);
  ok("tracks concurrent expected selections by model despite out-of-order events", consumedOutOfOrder && state.expectedModelSelections.size === 0);
  cancelFirst();
  cancelSecond();
}

section("reload ownership and pass-through");
{
  const calls: Record<string, ProviderCall[]> = {};
  let attempts = 0;
  const runtime = await createRuntime({
    owner(model) {
      attempts++;
      return attempts === 1
        ? streamFrom([startEvent(model), errorEvent(model, "HTTP 429 retry-after 0.001")])
        : streamFrom([startEvent(model), doneEvent(model)]);
    },
  }, calls);
  const model = runtime.getModel("owner", "owner-model")!;
  const oldRelease = installModelRuntimeInterception();
  const newRelease = installModelRuntimeInterception();
  ok("old reload owner cannot clear the newer owner", oldRelease() === false);
  await collect(runtime.streamSimple(model, context));
  ok("new reload owner remains active", attempts === 2, `attempts=${attempts}`);
  ok("active owner cleanup succeeds", newRelease() === true);
  attempts = 0;
  const passThrough = await collect(runtime.streamSimple(model, context));
  ok("inert trampoline transparently delegates with no owner", attempts === 1 && passThrough.at(-1)?.type === "error");
}
{
  const calls: Record<string, ProviderCall[]> = {};
  const runtime = await createRuntime({
    takeover(model) { return streamFrom([startEvent(model), errorEvent(model, "HTTP 429 retry-after 60")]); },
  }, calls);
  const model = runtime.getModel("takeover", "takeover-model")!;
  const oldRelease = installModelRuntimeInterception();
  const oldRequest = collect(runtime.streamSimple(model, context));
  while (!calls.takeover?.length) await new Promise((resolve) => setTimeout(resolve, 1));
  const newRelease = installModelRuntimeInterception();
  const oldEvents = await oldRequest;
  ok("ownership takeover aborts the previous owner's in-flight waits", endsAborted(oldEvents) && oldRelease() === false);
  newRelease();
}
{
  const calls: Record<string, ProviderCall[]> = {};
  let modelMutations = 0;
  let staleResponses = 0;
  const notifications: string[] = [];
  const runtime = await createRuntime({
    insensitive(model, options) {
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        void (async () => {
          await options?.onResponse?.({ status: 200, headers: {} }, model);
          stream.push(startEvent(model));
          stream.push(doneEvent(model));
          stream.end();
        })();
      }, 20);
      return stream;
    },
    insensitiveFallback(model) { return streamFrom([startEvent(model), doneEvent(model)]); },
  }, calls);
  const primary = runtime.getModel("insensitive", "insensitive-model")!;
  const fallback = runtime.getModel("insensitiveFallback", "insensitiveFallback-model")!;
  __configureFallbackModelsForTests(
    [{ model: fallback }],
    { ui: { notify: (text: string) => notifications.push(text) } } as unknown as Parameters<typeof __configureFallbackModelsForTests>[1],
  );
  state.extensionApi = {
    setModel: async () => { modelMutations++; return true; },
    setThinkingLevel: () => undefined,
  } as unknown as typeof state.extensionApi;
  const oldRelease = installModelRuntimeInterception();
  const oldRequest = collect(runtime.streamSimple(primary, context, { onResponse: () => { staleResponses++; } }));
  while (!calls.insensitive?.length) await new Promise((resolve) => setTimeout(resolve, 1));
  const newRelease = installModelRuntimeInterception();
  const oldEvents = await oldRequest;
  ok("abort-insensitive provider output after takeover cannot mutate model/UI or stale callbacks", endsAborted(oldEvents) && modelMutations === 0 && notifications.length === 0 && staleResponses === 0, `mutations=${modelMutations}, notifications=${notifications.length}, responses=${staleResponses}`);
  oldRelease();
  newRelease();
  state.extensionApi = undefined;
  __configureFallbackModelsForTests([]);
}

section("abort and commitment semantics");
{
  const calls: Record<string, ProviderCall[]> = {};
  const runtime = await createRuntime({ pre(model) { return streamFrom([startEvent(model), doneEvent(model)]); } }, calls);
  const model = runtime.getModel("pre", "pre-model")!;
  const release = installModelRuntimeInterception();
  const controller = new AbortController();
  controller.abort();
  const events = await collect(runtime.streamSimple(model, context, { signal: controller.signal }));
  ok("pre-abort never enters the provider", !calls.pre && endsAborted(events));
  release();
}
{
  const calls: Record<string, ProviderCall[]> = {};
  const controller = new AbortController();
  const runtime = await createRuntime({
    wait(model) {
      queueMicrotask(() => controller.abort());
      return streamFrom([startEvent(model), errorEvent(model, "HTTP 429 retry-after 60")]);
    },
  }, calls);
  const model = runtime.getModel("wait", "wait-model")!;
  const release = installModelRuntimeInterception();
  const events = await collect(runtime.streamSimple(model, context, { signal: controller.signal }));
  ok("abort during retry wait is terminal and does not retry", calls.wait?.length === 1 && endsAborted(events));
  release();
}
{
  const calls: Record<string, ProviderCall[]> = {};
  const runtime = await createRuntime({
    committed(model) { return streamFrom([startEvent(model), textEvent(model), errorEvent(model, "HTTP 429 retry-after 0.001")]); },
    unused(model) { return streamFrom([startEvent(model), doneEvent(model)]); },
  }, calls);
  const primary = runtime.getModel("committed", "committed-model")!;
  const fallback = runtime.getModel("unused", "unused-model")!;
  __configureFallbackModelsForTests([{ model: fallback }]);
  const release = installModelRuntimeInterception();
  const events = await collect(runtime.streamSimple(primary, context));
  ok("never retries/falls back after substantive output", calls.committed?.length === 1 && !calls.unused && events.at(-1)?.type === "error");
  release();
  __configureFallbackModelsForTests([]);
}
{
  __setNonRetryableTuningForTests(1, 0);
  const calls: Record<string, ProviderCall[]> = {};
  const controller = new AbortController();
  let providerCalls = 0;
  const fail = (model: Model<Api>) => {
    providerCalls++;
    if (providerCalls === 2) setTimeout(() => controller.abort(), 5);
    return streamFrom([startEvent(model), errorEvent(model, "HTTP 400 persistent")]);
  };
  const runtime = await createRuntime({ frozenA: fail, frozenB: fail }, calls);
  const primary = runtime.getModel("frozenA", "frozenA-model")!;
  const fallback = runtime.getModel("frozenB", "frozenB-model")!;
  __configureFallbackModelsForTests([{ model: fallback }]);
  const release = installModelRuntimeInterception();
  const events = await collect(runtime.streamSimple(primary, context, { signal: controller.signal }));
  ok("abort while all candidates are frozen emits aborted", providerCalls === 2 && endsAborted(events), `calls=${providerCalls}`);
  release();
  __configureFallbackModelsForTests([]);
  __setNonRetryableTuningForTests(3, 2);
}

console.log(`\n${"═".repeat(64)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
