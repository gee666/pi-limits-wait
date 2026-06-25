import { DEFAULT_NETWORK_WAIT_MS, DEFAULT_OVERLOADED_WAIT_MS, DEFAULT_RATE_LIMIT_WAIT_MS } from "./constants.js";
import type { RetryableError } from "./types.js";

function isExplicitRateLimitError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    /(?:^|\D)429(?:\D|$)/.test(msg) ||
    lower.includes("rate_limit") ||
    /rate\s*limit/.test(lower) ||
    lower.includes("too many requests") ||
    lower.includes("quota exceeded") ||
    lower.includes("quota will reset") ||
    lower.includes("usage limit") ||
    lower.includes("limit reached")
  );
}

export function isRateLimitError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    isExplicitRateLimitError(msg) ||
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

export function isTransientNetworkError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("und_err_headers_timeout") ||
    lower.includes("und_err_body_timeout") ||
    lower.includes("und_err_connect_timeout") ||
    lower.includes("und_err_socket") ||
    lower.includes("headers timeout") ||
    lower.includes("body timeout") ||
    lower.includes("connect timeout") ||
    lower.includes("request timed out") ||
    lower.includes("timed out") ||
    lower.includes("timedout") ||
    lower.includes("timeout") ||
    lower.includes("fetch failed") ||
    lower.includes("terminated") ||
    lower.includes("socket hang up") ||
    lower.includes("other side closed") ||
    lower.includes("network_error") ||
    lower.includes("network error") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("etimedout") ||
    lower.includes("enetunreach") ||
    lower.includes("ehostunreach") ||
    lower.includes("eai_again") ||
    lower.includes("enotfound")
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

function msUntilTimestamp(timestampMs: number): number | undefined {
  if (!Number.isFinite(timestampMs)) return undefined;
  return Math.max(0, timestampMs - Date.now());
}

function parseResetValueMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    // Epoch milliseconds / epoch seconds / duration seconds, depending on size.
    if (numeric > 1_000_000_000_000) return msUntilTimestamp(numeric);
    if (numeric > 1_000_000_000) return msUntilTimestamp(numeric * 1_000);
    return numeric * 1_000;
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return msUntilTimestamp(dateMs);
  return undefined;
}

function parseClockTimeResetMs(msg: string): number | undefined {
  const match = msg.match(/(?:reset|resets|retry|try again)[^\n.]*?\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match?.[1]) return undefined;

  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || minutes < 0 || minutes > 59) return undefined;

  if (meridiem) {
    if (hours < 1 || hours > 12) return undefined;
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  } else if (hours > 23) {
    return undefined;
  }

  const target = new Date();
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
  return target.getTime() - Date.now();
}

export function parseRetryDelayMs(msg: string): number | undefined {
  // Claude subscription errors often include a Unix reset timestamp after a pipe,
  // e.g. "Claude AI usage limit reached|1750359600".
  const pipeTimestamp = msg.match(/\|(\d{10,13})(?:\D|$)/);
  if (pipeTimestamp?.[1]) {
    const parsed = parseResetValueMs(pipeTimestamp[1]);
    if (parsed !== undefined) return parsed;
  }

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

  const resetAtIso = msg.match(/(?:reset|resets|retry|try again)[^\n.]*?\bat\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[^\s,;.}]*)/i);
  if (resetAtIso?.[1]) {
    const parsed = parseResetValueMs(resetAtIso[1]);
    if (parsed !== undefined) return parsed;
  }

  return parseClockTimeResetMs(msg);
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
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000;

    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  }

  for (const name of [
    "anthropic-ratelimit-unified-reset",
    "anthropic-ratelimit-unified-5h-reset",
    "anthropic-ratelimit-unified-7d-reset",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
    "x-ratelimit-reset",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "ratelimit-reset",
  ]) {
    const value = headers.get(name);
    if (!value) continue;
    const parsed = parseResetValueMs(value);
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}

export function getRetryableError(msg: string): RetryableError | undefined {
  if (isServerOverloadedError(msg)) {
    return { reason: "overloaded", waitMs: parseRetryDelayMs(msg) ?? DEFAULT_OVERLOADED_WAIT_MS };
  }
  if (isAuthenticationRefreshError(msg)) {
    return { reason: "authentication", waitMs: parseRetryDelayMs(msg) ?? DEFAULT_RATE_LIMIT_WAIT_MS };
  }
  if (isTransientNetworkError(msg) && !isExplicitRateLimitError(msg)) {
    return { reason: "network", waitMs: parseRetryDelayMs(msg) ?? DEFAULT_NETWORK_WAIT_MS };
  }
  if (isRateLimitError(msg)) {
    return { reason: "rate-limit", waitMs: rateLimitWaitMs(msg) };
  }
  if (isTransientNetworkError(msg)) {
    return { reason: "network", waitMs: parseRetryDelayMs(msg) ?? DEFAULT_NETWORK_WAIT_MS };
  }
  return undefined;
}

export function errorMessageWithCauses(err: unknown): string {
  const messages: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();

  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.message) messages.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    messages.push(String(current));
    break;
  }

  return messages.filter(Boolean).join(" Cause: ") || String(err);
}

export function isAbortMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("operation aborted") ||
    lower.includes("request aborted") ||
    lower.includes("aborterror") ||
    /\baborted\b/.test(lower)
  );
}
