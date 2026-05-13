import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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

const DEFAULT_RATE_LIMIT_WAIT_MS = 30 * 60 * 1_000; // 30 minutes
const DEFAULT_OVERLOADED_WAIT_MS = 5 * 60 * 1_000; // 5 minutes

/** Key used with ctx.ui.setStatus() for the countdown line. */
const STATUS_KEY = "limits-wait";

type RetryReason = "rate-limit" | "overloaded";

type RetryableError = {
  reason: RetryReason;
  waitMs: number;
};

// ─── Shared UI context ────────────────────────────────────────────────────────

let sharedCtx: ExtensionContext | undefined;
let restoreFetch: (() => void) | undefined;
let ambientStatusCleanup: (() => void) | undefined;
let activeProviderRequests = 0;
const wrappedApis = new Set<Api>();

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
    return { reason: "overloaded", waitMs: DEFAULT_OVERLOADED_WAIT_MS };
  }
  if (isRateLimitError(msg)) {
    return { reason: "rate-limit", waitMs: rateLimitWaitMs(msg) };
  }
  return undefined;
}

// ─── Countdown UI ─────────────────────────────────────────────────────────────

function reasonLabel(reason: RetryReason): string {
  return reason === "overloaded" ? "Server overloaded" : "Rate limited";
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
) => AssistantMessageEventStream;

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

    const flush = (buffer: AssistantMessageEvent[]) => {
      for (const event of buffer) output.push(event);
      committed = true;
    };

    while (true) {
      activeProviderRequests++;
      installFetchRateLimitObserver();
      const buffer: AssistantMessageEvent[] = [];
      let retryable: RetryableError | undefined;

      try {
        try {
          const inner = delegate(model, context, options);
          for await (const event of inner) {
            if (!committed) {
              if (event.type === "error") {
                const errMsg = event.error.errorMessage ?? "";
                retryable = !options?.signal?.aborted ? getRetryableError(errMsg) : undefined;
                if (retryable) break;

                // Non-retryable error: ensure start came first, then forward error.
                if (buffer.length > 0) {
                  flush(buffer);
                } else {
                  output.push({ type: "start", partial: freshMessage(model) });
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
              if (buffer.length > 0) {
                flush(buffer);
              } else {
                output.push({ type: "start", partial: freshMessage(model) });
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
            if (!committed) {
              // Synthetic start+error so the stream protocol stays valid.
              output.push({ type: "start", partial: freshMessage(model) });
              committed = true;
            }
            const error = freshMessage(model);
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
      } finally {
        activeProviderRequests--;
        if (activeProviderRequests === 0) {
          clearAmbientRetryStatus();
          restoreFetch?.();
        }
      }

      if (!retryable) {
        if (!committed) {
          if (buffer.length > 0) {
            flush(buffer);
          } else {
            output.push({ type: "start", partial: freshMessage(model) });
            committed = true;
          }
        }
        const error = freshMessage(model);
        error.stopReason = "error";
        error.errorMessage = "Provider stream ended without a terminal event.";
        output.push({ type: "error", reason: "error", error });
        output.end();
        return;
      }

      const waitResult = await waitForRetry(retryable.reason, retryable.waitMs, options?.signal);
      if (waitResult === "aborted") {
        if (!committed) {
          output.push({ type: "start", partial: freshMessage(model) });
          committed = true;
        }
        const error = freshMessage(model);
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

  wrappedApis.add(api);
  pi.registerProvider(`limits-wait-${api}`, {
    api,
    streamSimple: (model, context, options) =>
      streamWithLimitsRetry(builtinStreamSimple, model, context, options),
  });
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (_event, ctx) => {
    sharedCtx = ctx;

    // Some extensions may register providers after this extension loads. Wrap
    // any APIs that exist by the time an agent starts too.
    for (const model of ctx.modelRegistry.getAll()) {
      registerWrappedApi(pi, model.api);
    }
    if (ctx.model) registerWrappedApi(pi, ctx.model.api);
  });
}
