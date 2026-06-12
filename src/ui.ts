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
    ctx.ui.setWorkingMessage(statusText(reason, deadline, false));
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
      ctx?.ui.setWorkingMessage(statusText(reason, deadline, Boolean(unsubInput)));
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
