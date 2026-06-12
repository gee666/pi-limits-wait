import { DEFAULT_OVERLOADED_WAIT_MS, DEFAULT_RATE_LIMIT_WAIT_MS } from "./constants.js";
import type { RetryableError } from "./types.js";

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
