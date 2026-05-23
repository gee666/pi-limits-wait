import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  getApiProviders,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";

// ─── Constants ────────────────────────────────────────────────────────────────

const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

const PI_REMOVAL_ANCHORS = [
  "pi-coding-agent",
  "@mariozechner/pi-coding-agent",
  "badlogic/pi-mono",
] as const;

const PI_IDENTITY_SENTENCE_PATTERN =
  /(?:^|\n)\s*You are pi\b[^.!?\n]*(?:[.!?](?=\s|$)|(?=\n|$))/gi;

const DEFAULT_RATE_LIMIT_WAIT_MS = 30 * 60 * 1_000; // 30 minutes
const DEFAULT_OVERLOADED_WAIT_MS = 5 * 60 * 1_000; // 5 minutes
const DEFAULT_NON_RETRYABLE_FREEZE_MS = 60 * 60 * 1_000; // 1 hour
const SETTINGS_KEY = "oira666_pi-limits-wait";

/** Key used with ctx.ui.setStatus() for the countdown line. */
const STATUS_KEY = "limits-wait";
const MODELS_STATUS_KEY = "limits-wait-models";

type RetryReason = "rate-limit" | "overloaded" | "authentication" | "model-frozen";

type RetryableError = {
  reason: RetryReason;
  waitMs: number;
};

type ConfiguredModel = {
  provider: string;
  modelname: string;
  reasoningEffort?: ThinkingLevel;
};

export type FallbackModel = {
  model: Model<Api>;
  reasoningEffort?: ThinkingLevel;
};

type RateLimitMemory = {
  reason: RetryReason;
  limitedAt: number;
  deadline: number;
};

// ─── Shared UI context ────────────────────────────────────────────────────────

let sharedCtx: ExtensionContext | undefined;
let extensionApi: ExtensionAPI | undefined;
let restoreFetch: (() => void) | undefined;
let ambientStatusCleanup: (() => void) | undefined;
let modelStatusCleanup: (() => void) | undefined;
let activeProviderRequests = 0;
const wrappedApis = new Set<Api>();
const builtinStreamSimpleByApi = new Map<Api, StreamSimpleFn>();
let fallbackModels: FallbackModel[] = [];
let primaryModel: Model<Api> | undefined;
let primaryThinkingLevel: ThinkingLevel | undefined;
let suppressNextModelSelect = false;
let settingsSignature: string | undefined;
const rateLimitMemory = new Map<string, RateLimitMemory>();
const nonRetryableFailureMemory = new Map<string, { failedAt: number; deadline: number; errorMessage: string }>();

// ─── Anthropic subscription prompt sanitisation ──────────────────────────────

export function sanitiseSystemPrompt(raw: string): string {
  const paragraphs = raw.split(/\n\n+/);
  const filtered = paragraphs.filter((p) =>
    !PI_REMOVAL_ANCHORS.some((anchor) => p.includes(anchor)),
  );

  return filtered
    .join("\n\n")
    .replace(PI_IDENTITY_SENTENCE_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Returns true if Anthropic OAuth is configured for this session, regardless
 * of which model is currently active. This handles cases where a synthetic or
 * temporary model (e.g. a subagent/resume provider) is active at
 * before_agent_start time, even though the session will ultimately use an
 * Anthropic subscription model.
 */
function isAnthropicOAuthSession(ctx: ExtensionContext): boolean {
  return ctx.modelRegistry.isUsingOAuth(
    { provider: "anthropic" } as Parameters<typeof ctx.modelRegistry.isUsingOAuth>[0],
  );
}

// ─── Optional fallback model settings ────────────────────────────────────────

function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function formatModel(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function isInternalSyntheticModel(model: Pick<Model<Api>, "provider" | "id">): boolean {
  return model.provider.startsWith("pi-") || model.id.startsWith("synthetic-");
}

function isFallbackEligibleModel(model: Model<Api>): boolean {
  if (isInternalSyntheticModel(model)) return false;
  const key = modelKey(model);
  return primaryModel ? key === modelKey(primaryModel) || fallbackModels.some((entry) => modelKey(entry.model) === key) : true;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(value));
}

function parseConfiguredModels(raw: unknown): ConfiguredModel[] {
  const source = raw && typeof raw === "object" && Array.isArray((raw as { try_models?: unknown }).try_models)
    ? (raw as { try_models: unknown[] }).try_models
    : [];

  const models: ConfiguredModel[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const provider = typeof record.provider === "string" ? record.provider.trim() : "";
    const modelname =
      typeof record.modelname === "string" ? record.modelname.trim()
      : typeof record.modelName === "string" ? record.modelName.trim()
      : typeof record.model === "string" ? record.model.trim()
      : "";
    const reasoning = record["reasoning effort"] ?? record.reasoningEffort ?? record.reasoning_effort;
    if (!provider || !modelname) continue;
    models.push({
      provider,
      modelname,
      reasoningEffort: isThinkingLevel(reasoning) ? reasoning : undefined,
    });
  }
  return models;
}

function loadFallbackSettings(ctx: ExtensionContext): void {
  fallbackModels = [];

  try {
    const settingsManager = SettingsManager.create(ctx.cwd);
    const globalSettings = settingsManager.getGlobalSettings() as Record<string, unknown>;
    const projectSettings = settingsManager.getProjectSettings() as Record<string, unknown>;
    const globalConfig = globalSettings[SETTINGS_KEY];
    const projectConfig = projectSettings[SETTINGS_KEY];
    const config = {
      ...(globalConfig && typeof globalConfig === "object" && !Array.isArray(globalConfig) ? globalConfig : {}),
      ...(projectConfig && typeof projectConfig === "object" && !Array.isArray(projectConfig) ? projectConfig : {}),
    };
    const content = JSON.stringify(config);
    const shouldNotify = settingsSignature !== content;
    settingsSignature = content;

    const configured = parseConfiguredModels(config);
    if (configured.length === 0) return;

    const warnings: string[] = [];
    const seen = new Set<string>();

    for (const entry of configured) {
      const model = ctx.modelRegistry.find(entry.provider, entry.modelname);
      if (!model) {
        warnings.push(`missing ${entry.provider}/${entry.modelname}`);
        continue;
      }
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
        warnings.push(`no auth ${entry.provider}/${entry.modelname}`);
        continue;
      }
      const key = modelKey(model);
      if (seen.has(key)) continue;
      seen.add(key);
      fallbackModels.push({ model, reasoningEffort: entry.reasoningEffort });
    }

    const lines = fallbackModels.map((entry, index) =>
      `${index + 1}. ${formatModel(entry.model)}${entry.reasoningEffort ? ` (${entry.reasoningEffort})` : ""}`,
    );
    const message = lines.length > 0
      ? `Loaded ${SETTINGS_KEY}.try_models:\n${lines.join("\n")}`
      : `Loaded ${SETTINGS_KEY}.try_models, but no usable fallback models were found.`;
    if (shouldNotify) {
      ctx.ui.notify(warnings.length > 0 ? `${message}\nSkipped: ${warnings.join(", ")}` : message, warnings.length > 0 ? "warning" : "info");
    }
  } catch (err) {
    ctx.ui.notify(`Could not load ${SETTINGS_KEY}.try_models: ${err instanceof Error ? err.message : String(err)}`, "warning");
  }
}

function fallbackEnabled(): boolean {
  return fallbackModels.length > 0;
}

function getPrimaryModel(current: Model<Api>): Model<Api> {
  return primaryModel ?? current;
}

function candidateOrder(current: Model<Api>): FallbackModel[] {
  const primary = getPrimaryModel(current);
  const order: FallbackModel[] = [{ model: primary, reasoningEffort: primaryThinkingLevel }];
  const seen = new Set([modelKey(primary)]);
  for (const entry of fallbackModels) {
    const key = modelKey(entry.model);
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(entry);
  }
  return order;
}

function activeLimit(model: Model<Api>): RateLimitMemory | undefined {
  const entry = rateLimitMemory.get(modelKey(model));
  if (!entry) return undefined;
  if (Date.now() >= entry.deadline) {
    rateLimitMemory.delete(modelKey(model));
    return undefined;
  }
  return entry;
}

function formatDuration(ms: number): string {
  const totalSecs = Math.max(0, Math.ceil(ms / 1_000));
  const hours = Math.floor(totalSecs / 3_600);
  const mins = Math.floor((totalSecs % 3_600) / 60);
  const secs = (totalSecs % 60).toString().padStart(2, "0");
  return hours > 0 ? `${hours}h ${mins}m ${secs}s` : `${mins}m ${secs}s`;
}

function updateRateLimitedModelsStatus(): void {
  const ctx = sharedCtx;
  if (!ctx) return;
  const now = Date.now();
  const lines: string[] = [];
  for (const [key, entry] of rateLimitMemory) {
    if (now >= entry.deadline) {
      rateLimitMemory.delete(key);
      continue;
    }
    lines.push(`${key}: ${formatDuration(entry.deadline - now)}`);
  }
  for (const [key, entry] of nonRetryableFailureMemory) {
    if (now >= entry.deadline) {
      nonRetryableFailureMemory.delete(key);
      continue;
    }
    lines.push(`${key}: frozen ${formatDuration(entry.deadline - now)}`);
  }
  if (lines.length === 0) {
    modelStatusCleanup?.();
    return;
  }
  ctx.ui.setStatus(MODELS_STATUS_KEY, `🚦 Limited: ${lines.join(" | ")}`);
}

function ensureRateLimitedModelsStatus(): void {
  if (modelStatusCleanup) return;
  updateRateLimitedModelsStatus();
  const ticker = setInterval(updateRateLimitedModelsStatus, 1_000);
  modelStatusCleanup = () => {
    clearInterval(ticker);
    modelStatusCleanup = undefined;
    sharedCtx?.ui.setStatus(MODELS_STATUS_KEY, undefined);
  };
}

function rememberRateLimit(model: Model<Api>, retryable: RetryableError): void {
  const deadline = Date.now() + retryable.waitMs;
  rateLimitMemory.set(modelKey(model), { reason: retryable.reason, limitedAt: Date.now(), deadline });
  sharedCtx?.ui.notify(`${formatModel(model)} ${reasonLabel(retryable.reason).toLowerCase()} for ${formatDuration(retryable.waitMs)}.`, "warning");
  ensureRateLimitedModelsStatus();
}

function activeNonRetryableFailure(model: Model<Api>): { failedAt: number; deadline: number; errorMessage: string } | undefined {
  const entry = nonRetryableFailureMemory.get(modelKey(model));
  if (!entry) return undefined;
  if (Date.now() >= entry.deadline) {
    nonRetryableFailureMemory.delete(modelKey(model));
    return undefined;
  }
  return entry;
}

function hasNonRetryableFailure(model: Model<Api>): boolean {
  return Boolean(activeNonRetryableFailure(model));
}

function nextAvailableCandidate(current: Model<Api>): FallbackModel | undefined {
  return candidateOrder(current).find((entry) => !activeLimit(entry.model) && !hasNonRetryableFailure(entry.model));
}

function rememberNonRetryableFailure(model: Model<Api>, errorMessage: string): void {
  const deadline = Date.now() + DEFAULT_NON_RETRYABLE_FREEZE_MS;
  nonRetryableFailureMemory.set(modelKey(model), { failedAt: Date.now(), deadline, errorMessage });
  sharedCtx?.ui.notify(`${formatModel(model)} failed; freezing it for ${formatDuration(DEFAULT_NON_RETRYABLE_FREEZE_MS)} and trying another configured model if available.`, "warning");
  ensureRateLimitedModelsStatus();
}

function earliestCandidateDeadline(current: Model<Api>): number | undefined {
  const deadlines = candidateOrder(current)
    .map((entry) => activeLimit(entry.model)?.deadline ?? activeNonRetryableFailure(entry.model)?.deadline)
    .filter((deadline): deadline is number => typeof deadline === "number");
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

function initialAttempt(model: Model<Api>): FallbackModel {
  const configured = fallbackModels.find((entry) => modelKey(entry.model) === modelKey(model));
  const current = configured ?? { model, reasoningEffort: primaryThinkingLevel };
  if (!fallbackEnabled() || (!activeLimit(model) && !hasNonRetryableFailure(model))) return current;
  return nextAvailableCandidate(model) ?? current;
}

async function optionsForModel(
  originalModel: Model<Api>,
  target: FallbackModel,
  options?: SimpleStreamOptions,
): Promise<SimpleStreamOptions | undefined> {
  const level = target.reasoningEffort ?? primaryThinkingLevel;
  const reasoning = level && level !== "off" ? level : undefined;
  if (modelKey(originalModel) === modelKey(target.model)) {
    return reasoning ? { ...options, reasoning } : options;
  }
  const auth = await sharedCtx?.modelRegistry.getApiKeyAndHeaders(target.model);
  if (!auth?.ok) throw new Error(auth ? auth.error : "Model registry is unavailable.");
  return {
    ...options,
    ...(reasoning ? { reasoning } : {}),
    apiKey: auth.apiKey,
    headers: auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
  } as SimpleStreamOptions;
}

async function switchPiModel(entry: FallbackModel): Promise<void> {
  const pi = extensionApi;
  if (!pi) return;
  const current = sharedCtx?.model;
  if (current && modelKey(current) === modelKey(entry.model)) return;
  suppressNextModelSelect = true;
  const ok = await pi.setModel(entry.model);
  if (!ok) {
    suppressNextModelSelect = false;
    return;
  }
  const level = entry.reasoningEffort ?? primaryThinkingLevel;
  if (level) pi.setThinkingLevel(level);
  sharedCtx?.ui.notify(`Switched to ${formatModel(entry.model)}${level ? ` (${level})` : ""}.`, "info");
}

// ─── Retryable error detection ────────────────────────────────────────────────

export function isRateLimitError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    /(?:^|\D)429(?:\D|$)/.test(msg) ||
    lower.includes("rate_limit") ||
    /rate\s*limit/.test(lower) ||
    lower.includes("too many requests") ||
    lower.includes("quota exceeded") ||
    lower.includes("quota will reset") ||
    lower.includes("retry delay") ||
    lower.includes("retry-after")
  );
}

export function isServerOverloadedError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("server_is_overloaded") ||
    lower.includes("server is overloaded") ||
    lower.includes("overloaded_error")
  );
}

export function isAuthenticationRefreshError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    /(?:^|\D)401(?:\D|$)/.test(msg) &&
    (
      lower.includes("authentication_error") ||
      lower.includes("invalid authentication credentials") ||
      lower.includes("invalid authentication")
    )
  );
}

export function parseRetryDelayMs(msg: string): number | undefined {
  const retryAfter = msg.match(/retry-after(?:-ms)?[^0-9]*(\d+(?:\.\d+)?)/i);
  if (retryAfter?.[1]) {
    const value = Number(retryAfter[1]);
    if (Number.isFinite(value) && value > 0) {
      return msg.toLowerCase().includes("retry-after-ms") ? value : value * 1_000;
    }
  }

  const requested = msg.match(/requested\s+(\d+(?:\.\d+)?)s\s+retry delay/i);
  if (requested?.[1]) {
    const value = Number(requested[1]);
    if (Number.isFinite(value) && value > 0) return value * 1_000;
  }

  const retryIn = msg.match(/retry\s+in\s+(\d+(?:\.\d+)?)(ms|s|m|h)/i);
  if (retryIn?.[1] && retryIn[2]) {
    const value = Number(retryIn[1]);
    if (Number.isFinite(value) && value > 0) {
      const unit = retryIn[2].toLowerCase();
      if (unit === "ms") return value;
      if (unit === "s") return value * 1_000;
      if (unit === "m") return value * 60_000;
      if (unit === "h") return value * 3_600_000;
    }
  }

  const resetAfter = msg.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
  if (resetAfter) {
    const hours = resetAfter[1] ? Number(resetAfter[1]) : 0;
    const mins = resetAfter[2] ? Number(resetAfter[2]) : 0;
    const secs = Number(resetAfter[3]);
    if ([hours, mins, secs].every(Number.isFinite)) {
      return ((hours * 60 + mins) * 60 + secs) * 1_000;
    }
  }

  return undefined;
}

export function rateLimitWaitMs(msg: string): number {
  return parseRetryDelayMs(msg) ?? DEFAULT_RATE_LIMIT_WAIT_MS;
}

export function retryAfterHeaderMs(headers: Headers): number | undefined {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs) {
    const value = Number(retryAfterMs);
    if (Number.isFinite(value) && value > 0) return value;
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000;

  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

  return undefined;
}

export function getRetryableError(msg: string): RetryableError | undefined {
  if (isServerOverloadedError(msg)) {
    return { reason: "overloaded", waitMs: parseRetryDelayMs(msg) ?? DEFAULT_OVERLOADED_WAIT_MS };
  }
  if (isAuthenticationRefreshError(msg)) {
    return { reason: "authentication", waitMs: parseRetryDelayMs(msg) ?? DEFAULT_RATE_LIMIT_WAIT_MS };
  }
  if (isRateLimitError(msg)) {
    return { reason: "rate-limit", waitMs: rateLimitWaitMs(msg) };
  }
  return undefined;
}

// ─── Countdown UI ─────────────────────────────────────────────────────────────

function reasonLabel(reason: RetryReason): string {
  if (reason === "overloaded") return "Server overloaded";
  if (reason === "authentication") return "Authentication refresh pending";
  if (reason === "model-frozen") return "Model frozen after error";
  return "Rate limited";
}

function statusText(reason: RetryReason, deadline: number, allowSkip: boolean): string {
  const remaining = Math.max(0, deadline - Date.now());
  const totalSecs = Math.ceil(remaining / 1_000);
  const mins = Math.floor(totalSecs / 60);
  const secs = (totalSecs % 60).toString().padStart(2, "0");
  return (
    `⏳ ${reasonLabel(reason)} — next retry in ${mins}m ${secs}s` +
    (allowSkip ? "  (Enter to retry now)" : "")
  );
}

function showAmbientRetryStatus(reason: RetryReason, waitMs: number): void {
  const ctx = sharedCtx;
  if (!ctx) return;

  ambientStatusCleanup?.();

  if (waitMs <= 0) return;

  const deadline = Date.now() + waitMs;
  const tick = () => {
    if (Date.now() >= deadline) {
      ambientStatusCleanup?.();
      return;
    }
    const text = statusText(reason, deadline, false);
    ctx.ui.setStatus(STATUS_KEY, text);
    ctx.ui.setWorkingMessage(text);
  };

  tick();
  const ticker = setInterval(tick, 1_000);
  ambientStatusCleanup = () => {
    clearInterval(ticker);
    ambientStatusCleanup = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWorkingMessage();
  };
}

function clearAmbientRetryStatus(): void {
  ambientStatusCleanup?.();
}

export function waitForRetry(
  reason: RetryReason,
  waitMs: number,
  signal?: AbortSignal,
): Promise<"waited" | "skipped" | "aborted"> {
  if (waitMs <= 0) return Promise.resolve(signal?.aborted ? "aborted" : "waited");

  return new Promise((resolve) => {
    if (signal?.aborted) { resolve("aborted"); return; }

    const ctx = sharedCtx;
    const deadline = Date.now() + waitMs;
    let done = false;

    // Intercept Enter via Pi's terminal input hook — consumes the keypress
    // so Pi's TUI never sees it and doesn't submit an empty message.
    let unsubInput: (() => void) | undefined;
    try {
      unsubInput = ctx?.ui.onTerminalInput((data) => {
        if (done) return undefined;

        if (data === "\r" || data === "\n") {
          cleanup();
          resolve("skipped");
          return { consume: true };
        }

        if (data === "\x1b") {
          cleanup();
          resolve("aborted");
          return { consume: true };
        }

        return undefined;
      });
    } catch { /* UI unavailable */ }

    const onAbort = () => { if (!done) { cleanup(); resolve("aborted"); } };
    signal?.addEventListener("abort", onAbort);

    const tick = () => {
      const text = statusText(reason, deadline, Boolean(unsubInput));
      ctx?.ui.setStatus(STATUS_KEY, text);
      ctx?.ui.setWorkingMessage(text);
    };

    tick();
    const ticker = setInterval(() => {
      if (Date.now() >= deadline) { cleanup(); resolve("waited"); return; }
      tick();
    }, 1_000);

    function cleanup() {
      done = true;
      clearInterval(ticker);
      signal?.removeEventListener("abort", onAbort);
      unsubInput?.();
      ctx?.ui.setStatus(STATUS_KEY, undefined);
      ctx?.ui.setWorkingMessage(); // restore default "Working..."
      clearAmbientRetryStatus();
    }
  });
}

export function waitForRateLimit(
  waitMs: number,
  signal?: AbortSignal,
): Promise<"waited" | "skipped" | "aborted"> {
  return waitForRetry("rate-limit", waitMs, signal);
}

// ─── Early 429 observer ──────────────────────────────────────────────────────

function installFetchRateLimitObserver(): void {
  if (restoreFetch || typeof globalThis.fetch !== "function") return;

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);

    if (activeProviderRequests > 0) {
      if (response.status === 429) {
        const waitMs = retryAfterHeaderMs(response.headers) ?? DEFAULT_RATE_LIMIT_WAIT_MS;
        showAmbientRetryStatus("rate-limit", waitMs);
      } else if (ambientStatusCleanup && response.ok) {
        clearAmbientRetryStatus();
      }
    }

    return response;
  }) as typeof fetch;

  restoreFetch = () => {
    globalThis.fetch = originalFetch as typeof fetch;
    restoreFetch = undefined;
  };
}

// ─── Retrying streamSimple wrapper ───────────────────────────────────────────

type StreamSimpleFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export function __configureFallbackModelsForTests(
  models: FallbackModel[],
  ctx?: ExtensionContext,
): void {
  fallbackModels = models;
  sharedCtx = ctx;
  primaryModel = undefined;
  primaryThinkingLevel = undefined;
  rateLimitMemory.clear();
  nonRetryableFailureMemory.clear();
  ambientStatusCleanup?.();
  modelStatusCleanup?.();
}

function freshMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * Wrap a streamSimple with an indefinite retry loop for rate limits and
 * server_is_overloaded errors.
 *
 * Important: we forward the built-in provider's events unchanged once an
 * attempt is known to be non-retryable. That preserves tool-call streaming
 * exactly. Potential retryable attempts are buffered and discarded, so Pi
 * never sees them.
 */
export function streamWithLimitsRetry(
  delegate: StreamSimpleFn,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();

  void (async () => {
    let committed = false;
    const allowFallback = fallbackEnabled() && isFallbackEligibleModel(model);
    let attempt: FallbackModel = allowFallback ? initialAttempt(model) : { model, reasoningEffort: primaryThinkingLevel };

    const flush = (buffer: AssistantMessageEvent[]) => {
      for (const event of buffer) output.push(event);
      committed = true;
    };

    while (true) {
      activeProviderRequests++;
      installFetchRateLimitObserver();
      const buffer: AssistantMessageEvent[] = [];
      let retryable: RetryableError | undefined;
      let nonRetryableError: { message: string; event?: AssistantMessageEvent } | undefined;

      try {
        try {
          const attemptOptions = allowFallback
            ? await optionsForModel(model, attempt, options)
            : options;
          const attemptDelegate = attempt.model.api === model.api
            ? delegate
            : builtinStreamSimpleByApi.get(attempt.model.api)
              ?? getApiProviders().find((provider) => provider.api === attempt.model.api)?.streamSimple;
          if (!attemptDelegate) throw new Error(`No stream handler registered for API ${attempt.model.api}.`);
          const inner = await attemptDelegate(attempt.model, context, attemptOptions);
          for await (const event of inner) {
            if (!committed) {
              if (event.type === "error") {
                const errMsg = event.error.errorMessage ?? "";
                retryable = !options?.signal?.aborted ? getRetryableError(errMsg) : undefined;
                if (retryable) break;

                if (allowFallback) {
                  nonRetryableError = { message: errMsg, event };
                  break;
                }

                // Non-retryable error without fallbacks: ensure start came first, then forward error.
                if (buffer.length > 0) {
                  flush(buffer);
                } else {
                  output.push({ type: "start", partial: freshMessage(attempt.model) });
                  committed = true;
                }
                output.push(event);
                output.end();
                return;
              }

              if (event.type === "start") {
                buffer.push(event);
                continue;
              }

              // First non-start, non-error event means this attempt is real.
              if (allowFallback) await switchPiModel(attempt);
              if (buffer.length > 0) {
                flush(buffer);
              } else {
                output.push({ type: "start", partial: freshMessage(attempt.model) });
                committed = true;
              }
              output.push(event);
              if (event.type === "done") {
                output.end();
                return;
              }
              continue;
            }

            // Once committed, forward everything unchanged.
            output.push(event);
            if (event.type === "done" || event.type === "error") {
              output.end();
              return;
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          retryable = !options?.signal?.aborted ? getRetryableError(errMsg) : undefined;
          if (!retryable) {
            if (allowFallback && !options?.signal?.aborted) {
              nonRetryableError = { message: errMsg };
            } else {
            if (!committed) {
              // Synthetic start+error so the stream protocol stays valid.
              output.push({ type: "start", partial: freshMessage(attempt.model) });
              committed = true;
            }
            const error = freshMessage(attempt.model);
            error.stopReason = options?.signal?.aborted ? "aborted" : "error";
            error.errorMessage = errMsg;
            output.push({
              type: "error",
              reason: error.stopReason as "error" | "aborted",
              error,
            });
            output.end();
            return;
            }
          }
        }
      } finally {
        activeProviderRequests--;
        if (activeProviderRequests === 0) {
          clearAmbientRetryStatus();
          restoreFetch?.();
        }
      }

      if (nonRetryableError) {
        if (allowFallback && !committed) {
          rememberNonRetryableFailure(attempt.model, nonRetryableError.message);
          const next = nextAvailableCandidate(attempt.model);
          if (next) {
            attempt = next;
            continue;
          }

          const deadline = earliestCandidateDeadline(attempt.model);
          if (deadline) {
            const waitResult = await waitForRetry("model-frozen", Math.max(0, deadline - Date.now()), options?.signal);
            if (waitResult !== "aborted") {
              attempt = nextAvailableCandidate(attempt.model) ?? { model: getPrimaryModel(attempt.model), reasoningEffort: primaryThinkingLevel };
              continue;
            }
          }
        }

        if (!committed) {
          if (buffer.length > 0) {
            flush(buffer);
          } else {
            output.push({ type: "start", partial: freshMessage(attempt.model) });
            committed = true;
          }
        }
        if (nonRetryableError.event) {
          output.push(nonRetryableError.event);
        } else {
          const error = freshMessage(attempt.model);
          error.stopReason = "error";
          error.errorMessage = nonRetryableError.message;
          output.push({ type: "error", reason: "error", error });
        }
        output.end();
        return;
      }

      if (!retryable) {
        if (!committed) {
          if (buffer.length > 0) {
            flush(buffer);
          } else {
            output.push({ type: "start", partial: freshMessage(attempt.model) });
            committed = true;
          }
        }
        const error = freshMessage(attempt.model);
        error.stopReason = "error";
        error.errorMessage = "Provider stream ended without a terminal event.";
        output.push({ type: "error", reason: "error", error });
        output.end();
        return;
      }

      if (allowFallback) {
        rememberRateLimit(attempt.model, retryable);
        const next = nextAvailableCandidate(attempt.model);
        if (next) {
          attempt = next;
          continue;
        }

        const deadline = earliestCandidateDeadline(attempt.model);
        const waitMs = deadline ? Math.max(0, deadline - Date.now()) : retryable.waitMs;
        const waitResult = await waitForRetry(retryable.reason, waitMs, options?.signal);
        if (waitResult === "aborted") {
          if (!committed) {
            output.push({ type: "start", partial: freshMessage(attempt.model) });
            committed = true;
          }
          const error = freshMessage(attempt.model);
          error.stopReason = "aborted";
          error.errorMessage = `Request aborted during ${reasonLabel(retryable.reason).toLowerCase()} wait.`;
          output.push({ type: "error", reason: "aborted", error });
          output.end();
          return;
        }
        attempt = nextAvailableCandidate(attempt.model) ?? { model: getPrimaryModel(attempt.model), reasoningEffort: primaryThinkingLevel };
        continue;
      }

      const waitResult = await waitForRetry(retryable.reason, retryable.waitMs, options?.signal);
      if (waitResult === "aborted") {
        if (!committed) {
          output.push({ type: "start", partial: freshMessage(attempt.model) });
          committed = true;
        }
        const error = freshMessage(attempt.model);
        error.stopReason = "aborted";
        error.errorMessage = `Request aborted during ${reasonLabel(retryable.reason).toLowerCase()} wait.`;
        output.push({ type: "error", reason: "aborted", error });
        output.end();
        return;
      }
      // waited/skipped -> retry. For server_is_overloaded this means Pi gets
      // another full provider attempt (including the provider's normal retries).
    }
  })();

  return output;
}

export const streamWithRateLimitRetry = streamWithLimitsRetry;

function registerWrappedApi(pi: ExtensionAPI, api: Api): void {
  if (wrappedApis.has(api)) return;

  const builtinStreamSimple = getApiProviders().find((provider) => provider.api === api)?.streamSimple;
  if (!builtinStreamSimple) return;

  builtinStreamSimpleByApi.set(api, builtinStreamSimple);
  wrappedApis.add(api);
  pi.registerProvider(`limits-wait-${api}`, {
    api,
    streamSimple: (model, context, options) =>
      streamWithLimitsRetry(builtinStreamSimple, model, context, options),
  });
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  extensionApi = pi;

  pi.on("model_select", (event) => {
    if (suppressNextModelSelect) {
      suppressNextModelSelect = false;
      return;
    }
    if (isInternalSyntheticModel(event.model)) return;
    primaryModel = event.model;
    primaryThinkingLevel = pi.getThinkingLevel();
  });

  pi.on("before_agent_start", (event, ctx) => {
    sharedCtx = ctx;
    if (!primaryModel && ctx.model && !isInternalSyntheticModel(ctx.model)) primaryModel = ctx.model;
    primaryThinkingLevel ??= pi.getThinkingLevel();
    loadFallbackSettings(ctx);

    // Some extensions may register providers after this extension loads. Wrap
    // any APIs that exist by the time an agent starts too.
    for (const model of ctx.modelRegistry.getAll()) {
      if (!isInternalSyntheticModel(model)) registerWrappedApi(pi, model.api);
    }
    if (ctx.model && !isInternalSyntheticModel(ctx.model)) registerWrappedApi(pi, ctx.model.api);

    // Anthropic subscription/OAuth requests identify as Claude Code, not Pi.
    // Check the session-wide Anthropic OAuth configuration rather than only the
    // current model: resumed/subagent sessions can temporarily expose a
    // synthetic active model during before_agent_start.
    if (!isAnthropicOAuthSession(ctx)) return;

    const sanitised = sanitiseSystemPrompt(event.systemPrompt);
    return {
      systemPrompt: sanitised
        ? `${CLAUDE_CODE_IDENTITY}\n\n${sanitised}`
        : CLAUDE_CODE_IDENTITY,
    };
  });
}
