import {
  DEFAULT_UNKNOWN_ERROR_MAX_RETRIES,
  DEFAULT_UNKNOWN_ERROR_RETRY_INTERVAL_MS,
  DEFAULT_WAITING_ENV_VAR,
  FREEZING_ENV_VAR,
  MAX_RETRY_ENV_VAR,
  RETRY_INTERVAL_ENV_VAR,
} from "./constants.js";
import { state } from "./state.js";
import type { RetryReason } from "./types.js";

export function formatDuration(ms: number): string {
  const totalSecs = Math.max(0, Math.ceil(ms / 1_000));
  const hours = Math.floor(totalSecs / 3_600);
  const mins = Math.floor((totalSecs % 3_600) / 60);
  const secs = (totalSecs % 60).toString().padStart(2, "0");
  return hours > 0 ? `${hours}h ${mins}m ${secs}s` : `${mins}m ${secs}s`;
}

export function formatErrorDetail(errorMessage: string, maxLength = 500): string {
  const oneLine = errorMessage.replace(/\s+/g, " ").trim();
  if (!oneLine) return "unknown error";
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

export function reasonLabel(reason: RetryReason): string {
  if (reason === "overloaded") return "Server overloaded";
  if (reason === "authentication") return "Authentication refresh pending";
  if (reason === "model-frozen") return "Model frozen after error";
  if (reason === "network") return "Network/timeout error";
  if (reason === "retry") return "Retrying after error";
  return "Rate limited";
}

function envBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const value = raw.trim().toLowerCase();
  return !(value === "false" || value === "0" || value === "no" || value === "off");
}

function envNonNegativeInteger(raw: string | undefined, defaultValue: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return defaultValue;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? Math.min(value, maximum) : defaultValue;
}

export function freezingEnabled(): boolean {
  return envBoolean(process.env[FREEZING_ENV_VAR], true);
}

/** Load unknown-error retry settings once per extension instance/reload. */
export function loadUnknownErrorRetrySettings(): void {
  state.unknownErrorWaitingEnabled = envBoolean(process.env[DEFAULT_WAITING_ENV_VAR], true);
  const maxRetries = envNonNegativeInteger(
    process.env[MAX_RETRY_ENV_VAR],
    DEFAULT_UNKNOWN_ERROR_MAX_RETRIES,
    Number.MAX_SAFE_INTEGER - 1,
  );
  // The first failed request is not itself a retry.
  state.nonRetryableMaxAttempts = maxRetries + 1;

  // PI_LIMITS_WAIT_RETRY_INTERVAL is expressed in seconds; internally waits use ms.
  const intervalSeconds = envNonNegativeInteger(
    process.env[RETRY_INTERVAL_ENV_VAR],
    DEFAULT_UNKNOWN_ERROR_RETRY_INTERVAL_MS / 1_000,
    // Node timers cannot reliably wait longer than this in one timeout.
    Math.floor(2_147_483_647 / 1_000),
  );
  state.nonRetryableRetryDelayMs = intervalSeconds * 1_000;
}

function countdownText(reason: RetryReason, deadline: number, allowSkip: boolean): string {
  const remaining = Math.max(0, deadline - Date.now());
  const totalSecs = Math.ceil(remaining / 1_000);
  const mins = Math.floor(totalSecs / 60);
  const secs = (totalSecs % 60).toString().padStart(2, "0");
  return (
    `⏳ ${reasonLabel(reason)} — next retry in ${mins}m ${secs}s` +
    (allowSkip ? "  (Enter to retry now)" : "")
  );
}

export function showAmbientRetryStatus(reason: RetryReason, waitMs: number): void {
  const ctx = state.sharedCtx;
  if (!ctx) return;

  state.ambientStatusCleanup?.();
  if (waitMs <= 0) return;

  const deadline = Date.now() + waitMs;
  const tick = () => {
    if (Date.now() >= deadline) {
      state.ambientStatusCleanup?.();
      return;
    }
    ctx.ui.setWorkingMessage(countdownText(reason, deadline, false));
  };

  tick();
  const ticker = setInterval(tick, 1_000);
  state.ambientStatusCleanup = () => {
    clearInterval(ticker);
    state.ambientStatusCleanup = undefined;
    ctx.ui.setWorkingMessage();
  };
}

export function clearAmbientRetryStatus(): void {
  state.ambientStatusCleanup?.();
}

export function clearModelStatus(): void {
  state.modelStatusCleanup?.();
}

export function waitForRetry(
  reason: RetryReason,
  waitMs: number,
  signal?: AbortSignal,
): Promise<"waited" | "skipped" | "aborted"> {
  if (waitMs <= 0) return Promise.resolve(signal?.aborted ? "aborted" : "waited");

  return new Promise((resolve) => {
    if (signal?.aborted) { resolve("aborted"); return; }

    const ctx = state.sharedCtx;
    const deadline = Date.now() + waitMs;
    let done = false;
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
      ctx?.ui.setWorkingMessage(countdownText(reason, deadline, Boolean(unsubInput)));
    };

    tick();
    const ticker = setInterval(() => {
      if (Date.now() >= deadline) { cleanup(); resolve("waited"); return; }
      tick();
    }, 1_000);
    const timer = setTimeout(() => { if (!done) { cleanup(); resolve("waited"); } }, Math.max(0, deadline - Date.now()));

    function cleanup() {
      done = true;
      clearInterval(ticker);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unsubInput?.();
      ctx?.ui.setWorkingMessage();
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
