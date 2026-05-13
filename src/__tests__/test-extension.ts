import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import {
  getRetryableError,
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

function mockModel(): Model<Api> {
  return { provider: "test-provider", id: "test-model", api: "anthropic-messages" } as Model<Api>;
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
ok("does not match unauthorized", !isRateLimitError("HTTP 401 Unauthorized") && !isServerOverloadedError("HTTP 401 Unauthorized"));
ok("classifies overloaded", getRetryableError("server_is_overloaded")?.reason === "overloaded");
{
  const past = new Headers({ "retry-after": new Date(Date.now() - 10_000).toUTCString() });
  ok("past retry-after date parses as zero", retryAfterHeaderMs(past) === 0);
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
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20);
  const events = await collect(streamWithLimitsRetry(delegate, mockModel(), {} as Context, { signal: ctrl.signal } as SimpleStreamOptions));
  ok("overloaded wait can be aborted", calls === 1 && events.at(-1)?.type === "error" && (events.at(-1) as { reason?: string })?.reason === "aborted");
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

console.log(`\n${"═".repeat(64)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
