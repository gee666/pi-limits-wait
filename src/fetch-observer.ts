import { DEFAULT_RATE_LIMIT_WAIT_MS } from "./constants.js";
import { retryAfterHeaderMs } from "./retry-errors.js";
import { state } from "./state.js";
import { formatErrorDetail, showAmbientRetryStatus, clearAmbientRetryStatus } from "./ui.js";

async function responseErrorMessage(response: Response): Promise<string> {
  const retryAfterMs = retryAfterHeaderMs(response.headers);
  const retryAfter = retryAfterMs !== undefined ? ` retry-after-ms ${retryAfterMs}` : "";
  let body = "";
  try {
    body = await response.clone().text();
  } catch {
    // Ignore body read failures; status and retry headers are enough.
  }
  const detail = body.trim() ? ` ${formatErrorDetail(body)}` : "";
  return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${retryAfter}${detail}`;
}

export function installFetchRateLimitObserver(): void {
  if (state.restoreFetch || typeof globalThis.fetch !== "function") return;

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);

    if (state.activeProviderRequests > 0) {
      if (!response.ok) {
        const message = await responseErrorMessage(response);
        state.lastObservedHttpError = { at: Date.now(), message };
        if (response.status === 429) {
          const waitMs = retryAfterHeaderMs(response.headers) ?? DEFAULT_RATE_LIMIT_WAIT_MS;
          showAmbientRetryStatus("rate-limit", waitMs);
          if (state.activeFallbackProviderRequests > 0) {
            throw new Error(message);
          }
        }
      } else if (state.ambientStatusCleanup && response.ok) {
        clearAmbientRetryStatus();
      }
    }

    return response;
  }) as typeof fetch;

  state.restoreFetch = () => {
    globalThis.fetch = originalFetch as typeof fetch;
    state.restoreFetch = undefined;
  };
}
