import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { __configureFallbackModelsForTests, installModelRuntimeInterception } from "../index.js";
import { unavailableCandidatesSummary } from "../models.js";
import { parseConfiguredModels } from "../settings.js";
import { state } from "../state.js";
import {
  parseWeeklyLimitPercent,
  pruneWeeklyBudgetMemory,
  weeklyUsageFromHeaders,
  weeklyUsageFromStreamEvent,
} from "../weekly-limit.js";

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

section("min-weekly-limit-keep parsing");
ok("accepts percentages", parseWeeklyLimitPercent("40%") === 40 && parseWeeklyLimitPercent(" 12.5 % ") === 12.5);
ok("rejects bare numbers and out-of-range values",
  [40, "40", "0.4", "100%", "-5%", "abc%", undefined].every((value) => parseWeeklyLimitPercent(value) === undefined));
{
  const warnings: string[] = [];
  const models = parseConfiguredModels({
    "fallback-models": [
      { provider: "anthropic", modelname: "claude", "min-weekly-limit-keep": "40%" },
      { provider: "openai-codex", modelname: "gpt", "min-weekly-limit-keep": 40 },
      { provider: "other", modelname: "plain" },
    ],
  }, warnings);
  ok("reads the setting per fallback entry",
    models[0]?.minWeeklyLimitKeep === 40 && models[1]?.minWeeklyLimitKeep === undefined && models[2]?.minWeeklyLimitKeep === undefined);
  ok("warns about a non-percentage value", warnings.length === 1 && warnings[0]!.includes("openai-codex/gpt: min-weekly-limit-keep"), warnings.join("; "));
}

section("weekly usage sources");
{
  const now = 1_800_000_000_000;
  const anthropic = weeklyUsageFromHeaders({
    "anthropic-ratelimit-unified-7d-utilization": "0.65",
    "anthropic-ratelimit-unified-7d-reset": String(now / 1_000 + 3_600),
  }, now);
  ok("Anthropic unified 7d utilization is a fraction", anthropic?.usedPercent === 65 && anthropic.resetAt === now + 3_600_000);

  const codex = weeklyUsageFromHeaders({
    "x-codex-primary-used-percent": "90",
    "x-codex-primary-window-minutes": "300",
    "x-codex-secondary-used-percent": "61",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-after-seconds": "120",
  }, now);
  ok("Codex headers use the weekly window, not the 5h one", codex?.usedPercent === 61 && codex.resetAt === now + 120_000);

  const event = weeklyUsageFromStreamEvent({
    type: "codex.rate_limits",
    rate_limits: { primary: { used_percent: 5, window_minutes: 300 }, secondary: { used_percent: 70, window_minutes: 10080, reset_at: now / 1_000 + 60 } },
  }, now);
  ok("Codex WebSocket rate_limits event is parsed", event?.usedPercent === 70 && event.resetAt === now + 60_000);
  ok("unrelated headers and events are ignored",
    weeklyUsageFromHeaders({ "x-ratelimit-remaining": "3" }) === undefined && weeklyUsageFromStreamEvent({ type: "response.created" }) === undefined);
}

section("blocking a model at its weekly reserve");
function message(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
}
function reply(model: Model<Api>, options: ModelsSimpleStreamOptions | undefined, headers: Record<string, string>) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    await options?.onResponse?.({ status: 200, headers }, model);
    stream.push({ type: "start", partial: message(model) });
    stream.push({ type: "text_start", contentIndex: 0, partial: { ...message(model), content: [{ type: "text", text: "" }] } });
    stream.push({ type: "done", reason: "stop", message: message(model) });
    stream.end();
  })();
  return stream;
}
async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

{
  let primaryUsed = 0.65;
  const calls = { primary: 0, backup: 0 };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  for (const provider of ["primary", "backup"] as const) {
    runtime.registerProvider(provider, {
      baseUrl: `https://${provider}.example/v1`,
      apiKey: "key",
      api: "openai-completions",
      models: [{ id: `${provider}-model`, name: provider, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096 }],
      streamSimple(model, _context, options) {
        calls[provider]++;
        return reply(model, options, provider === "primary"
          ? { "anthropic-ratelimit-unified-7d-utilization": String(primaryUsed), "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1_000) + 86_400) }
          : {});
      },
    });
  }
  const primary = runtime.getModel("primary", "primary-model")!;
  const backup = runtime.getModel("backup", "backup-model")!;
  const notices: string[] = [];
  const ctx = { model: primary, ui: { notify: (text: string) => notices.push(text), setStatus: () => undefined } } as unknown as ExtensionContext;
  state.extensionApi = {
    setModel: async (next: Model<Api>) => { (ctx as unknown as { model: Model<Api> }).model = next; return true; },
    setThinkingLevel: () => undefined,
  } as unknown as typeof state.extensionApi;
  __configureFallbackModelsForTests([{ model: primary, minWeeklyLimitKeep: 40 }, { model: backup }], ctx);
  const context: Context = { messages: [] };
  const release = installModelRuntimeInterception();
  try {
    primaryUsed = 0.5;
    await collect(runtime.streamSimple(primary, context));
    ok("a model with more than its reserve left stays in use", calls.primary === 1 && !state.rateLimitMemory.has("primary/primary-model"));

    primaryUsed = 0.65;
    const crossing = await collect(runtime.streamSimple(primary, context));
    ok("the request that reports the crossing still completes on that model", calls.primary === 2 && crossing.at(-1)?.type === "done");
    const record = state.rateLimitMemory.get("primary/primary-model");
    ok("the model is blocked until the reported weekly reset with a distinct reason",
      record?.reason === "weekly-budget" && record.explicitDeadline === true && record.deadline > Date.now() + 86_000_000);
    ok("the user is told why the model stopped being used",
      notices.some((text) => text.includes("Weekly limit reserve reached on primary/primary-model") && text.includes("35% of the weekly limit left") && text.includes("min-weekly-limit-keep is 40%")),
      notices.join(" | "));

    const next = await collect(runtime.streamSimple(primary, context));
    ok("later requests go to the next fallback model", calls.primary === 2 && calls.backup === 1 && next.at(-1)?.type === "done");

    state.waitingEnabled = false;
    __configureFallbackModelsForTests([{ model: primary, minWeeklyLimitKeep: 40 }], ctx);
    state.rateLimitMemory.set("primary/primary-model", record!);
    const exhausted = await collect(runtime.streamSimple(primary, context));
    const terminal = exhausted.at(-1);
    ok("with no usable model the surfaced error explains the weekly reserve",
      terminal?.type === "error" && terminal.error.errorMessage?.includes("Weekly limit reserve reached on primary/primary-model") === true,
      terminal?.type === "error" ? terminal.error.errorMessage : terminal?.type);

    ok("waiting for every reserved model uses the weekly-budget reason", unavailableCandidatesSummary(primary).reason === "weekly-budget");

    state.fallbackModels = [{ model: primary, minWeeklyLimitKeep: 30 }];
    pruneWeeklyBudgetMemory();
    ok("lowering the reserve below the remaining share unblocks the model", !state.rateLimitMemory.has("primary/primary-model"));
  } finally {
    release();
    state.waitingEnabled = true;
    state.extensionApi = undefined;
    __configureFallbackModelsForTests([]);
  }
}

console.log(`\n${"═".repeat(64)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
