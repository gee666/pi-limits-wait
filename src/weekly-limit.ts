import type { Api, Model } from "@earendil-works/pi-ai";
import { MIN_WEEKLY_LIMIT_KEEP_KEY, WEEKLY_BUDGET_UNKNOWN_RESET_RECHECK_MS } from "./constants.js";
import { formatModel, modelKey } from "./models.js";
import { state } from "./state.js";
import type { RateLimitMemory } from "./types.js";

export type WeeklyUsage = {
  usedPercent: number;
  /** Epoch ms of the weekly window reset, when the provider reports it. */
  resetAt?: number;
};

const WEEK_MINUTES = 7 * 24 * 60;

/** Settings accept only percentages such as "40%"; bare numbers are ambiguous. */
export function parseWeeklyLimitPercent(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*%$/);
  const percent = match?.[1] ? Number(match[1]) : NaN;
  return percent >= 0 && percent < 100 ? percent : undefined;
}

/** Parse one optional fallback-entry setting, reporting present-but-invalid values. */
export function readWeeklyLimitKeep(record: Record<string, unknown>, label: string, warnings: string[]): number | undefined {
  const value = record[MIN_WEEKLY_LIMIT_KEEP_KEY];
  if (value === undefined) return undefined;
  const percent = parseWeeklyLimitPercent(value);
  if (percent === undefined) {
    warnings.push(`${label}: ${MIN_WEEKLY_LIMIT_KEEP_KEY} must be a percentage from 0% to below 100%, e.g. "40%" (got ${JSON.stringify(value)})`);
  }
  return percent;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

function epochSecondsToMs(value: unknown): number | undefined {
  const seconds = finiteNumber(value);
  return seconds !== undefined && seconds > 0 ? seconds * 1_000 : undefined;
}

type UsageWindow = { usedPercent?: number; windowMinutes?: number; resetAt?: number };

/**
 * Codex reports a short primary and a weekly secondary window. Pick by window
 * length when reported; otherwise the secondary window is the weekly one.
 */
function weeklyWindow(primary: UsageWindow, secondary: UsageWindow): WeeklyUsage | undefined {
  const windows = [primary, secondary].filter((window) => window.usedPercent !== undefined);
  const weekly = windows.find((window) => (window.windowMinutes ?? 0) >= WEEK_MINUTES)
    ?? (windows.every((window) => window.windowMinutes === undefined) && secondary.usedPercent !== undefined ? secondary : undefined);
  if (weekly?.usedPercent === undefined) return undefined;
  return { usedPercent: weekly.usedPercent, ...(weekly.resetAt ? { resetAt: weekly.resetAt } : {}) };
}

/** Weekly usage from Anthropic unified or OpenAI Codex response headers. */
export function weeklyUsageFromHeaders(record: Record<string, string>, now = Date.now()): WeeklyUsage | undefined {
  const headers = new Headers(record);
  // Anthropic reports utilization as a 0..1 fraction.
  const utilization = finiteNumber(headers.get("anthropic-ratelimit-unified-7d-utilization"));
  if (utilization !== undefined) {
    const resetAt = epochSecondsToMs(headers.get("anthropic-ratelimit-unified-7d-reset"));
    return { usedPercent: utilization * 100, ...(resetAt ? { resetAt } : {}) };
  }

  const codexWindow = (name: "primary" | "secondary"): UsageWindow => {
    const resetAfter = finiteNumber(headers.get(`x-codex-${name}-reset-after-seconds`));
    return {
      usedPercent: finiteNumber(headers.get(`x-codex-${name}-used-percent`)),
      windowMinutes: finiteNumber(headers.get(`x-codex-${name}-window-minutes`)),
      resetAt: epochSecondsToMs(headers.get(`x-codex-${name}-reset-at`))
        ?? (resetAfter !== undefined && resetAfter >= 0 ? now + resetAfter * 1_000 : undefined),
    };
  };
  return weeklyWindow(codexWindow("primary"), codexWindow("secondary"));
}

/** Weekly usage from a Codex WebSocket `codex.rate_limits` event (no HTTP headers there). */
export function weeklyUsageFromStreamEvent(data: unknown, now = Date.now()): WeeklyUsage | undefined {
  if (!data || typeof data !== "object") return undefined;
  const event = data as { type?: unknown; rate_limits?: unknown };
  if (event.type !== "codex.rate_limits" || !event.rate_limits || typeof event.rate_limits !== "object") return undefined;
  const limits = event.rate_limits as Record<string, unknown>;
  const codexWindow = (name: "primary" | "secondary"): UsageWindow => {
    const raw = limits[name];
    if (!raw || typeof raw !== "object") return {};
    const window = raw as Record<string, unknown>;
    const resetAfter = finiteNumber(window.reset_after_seconds);
    return {
      usedPercent: finiteNumber(window.used_percent),
      windowMinutes: finiteNumber(window.window_minutes),
      resetAt: epochSecondsToMs(window.reset_at)
        ?? (resetAfter !== undefined && resetAfter >= 0 ? now + resetAfter * 1_000 : undefined),
    };
  };
  return weeklyWindow(codexWindow("primary"), codexWindow("secondary"));
}

/** Percentage of the weekly limit a configured model must keep unused. */
export function weeklyLimitKeep(model: Pick<Model<Api>, "provider" | "id">): number | undefined {
  return keepForKey(modelKey(model));
}

function keepForKey(key: string): number | undefined {
  return state.fallbackModels.find((candidate) => modelKey(candidate.model) === key)?.minWeeklyLimitKeep;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

/**
 * Block a model once its unused weekly share drops to the configured reserve. The
 * request that reported the usage has already been served and continues; only
 * later requests avoid the model until the weekly window resets.
 */
export function recordWeeklyUsage(model: Model<Api>, usage: WeeklyUsage | undefined, now = Date.now()): void {
  if (!usage) return;
  const keep = weeklyLimitKeep(model);
  if (keep === undefined || 100 - usage.usedPercent > keep) return;

  const resetKnown = usage.resetAt !== undefined && usage.resetAt > now;
  // Without a reset time, re-check once per interval: each check spends a request.
  const deadline = resetKnown ? usage.resetAt! : now + WEEKLY_BUDGET_UNKNOWN_RESET_RECHECK_MS;
  const until = resetKnown
    ? `the weekly limit resets at ${new Date(deadline).toLocaleString()}`
    : `${new Date(deadline).toLocaleString()} (the provider did not report the weekly reset time)`;
  const left = Math.max(0, 100 - usage.usedPercent);
  const detail = `Weekly limit reserve reached on ${formatModel(model)}: ${formatPercent(left)} of the weekly limit left, `
    + `${MIN_WEEKLY_LIMIT_KEEP_KEY} is ${formatPercent(keep)}. Not using this model until ${until}.`;

  const key = modelKey(model);
  const previous = state.rateLimitMemory.get(key);
  const repeated = previous?.reason === "weekly-budget" && previous.deadline === deadline;
  // Always store a new record: success-clearing compares record identity, so
  // fresh evidence must survive the attempt that reported it.
  const record: RateLimitMemory = {
    reason: "weekly-budget",
    limitedAt: now,
    deadline,
    explicitDeadline: true,
    detail,
    weeklyUsedPercent: usage.usedPercent,
  };
  state.rateLimitMemory.set(key, record);
  if (repeated) return;
  try { state.sharedCtx?.ui.notify(`⛔ ${detail}`, "warning"); } catch { /* UI unavailable */ }
}

/** Drop weekly blocks that the current settings no longer justify. */
export function pruneWeeklyBudgetMemory(): void {
  for (const [key, record] of state.rateLimitMemory) {
    if (record.reason !== "weekly-budget") continue;
    const keep = keepForKey(key);
    if (keep === undefined || 100 - (record.weeklyUsedPercent ?? 0) > keep) state.rateLimitMemory.delete(key);
  }
}
