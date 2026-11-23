import type { Api, Model } from "@earendil-works/pi-ai";
import {
  RELEASE_RESERVE_BEFORE_RESET_KEY,
  WEEKLY_BUDGET_UNKNOWN_RESET_RECHECK_MS,
  WEEKLY_LIMIT_RESERVE_KEY,
} from "./constants.js";
import { modelKey } from "./models.js";
import { state } from "./state.js";
import type { FallbackModel, RateLimitMemory, WeeklyUsage } from "./types.js";

export type { WeeklyUsage } from "./types.js";

const WEEK_MINUTES = 7 * 24 * 60;

/** Settings accept only percentages such as "40%"; bare numbers are ambiguous. */
export function parseWeeklyLimitPercent(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*%$/);
  const percent = match?.[1] ? Number(match[1]) : NaN;
  return percent >= 0 && percent < 100 ? percent : undefined;
}

/** Parse one optional fallback-entry setting, reporting present-but-invalid values. */
export function readWeeklyLimitReserve(record: Record<string, unknown>, label: string, warnings: string[]): number | undefined {
  const value = record[WEEKLY_LIMIT_RESERVE_KEY];
  if (value === undefined) return undefined;
  const percent = parseWeeklyLimitPercent(value);
  if (percent === undefined) {
    warnings.push(`${label}: ${WEEKLY_LIMIT_RESERVE_KEY} must be a percentage from 0% to below 100%, e.g. "40%" (got ${JSON.stringify(value)})`);
  }
  return percent;
}

/** Settings accept only hours such as "5h" or "1.5h". */
export function parseHoursMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*h$/i);
  const hours = match?.[1] ? Number(match[1]) : NaN;
  return hours > 0 && hours <= 7 * 24 ? hours * 3_600_000 : undefined;
}

export function readReleaseReserveBeforeReset(
  record: Record<string, unknown>,
  label: string,
  hasReserve: boolean,
  warnings: string[],
): number | undefined {
  const value = record[RELEASE_RESERVE_BEFORE_RESET_KEY];
  if (value === undefined) return undefined;
  const ms = parseHoursMs(value);
  if (ms === undefined) {
    warnings.push(`${label}: ${RELEASE_RESERVE_BEFORE_RESET_KEY} must be hours up to 168h, e.g. "5h" (got ${JSON.stringify(value)})`);
  } else if (!hasReserve) {
    warnings.push(`${label}: ${RELEASE_RESERVE_BEFORE_RESET_KEY} has no effect without ${WEEKLY_LIMIT_RESERVE_KEY}`);
  }
  return ms;
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

function reserveSettings(key: string): FallbackModel | undefined {
  const entry = state.fallbackModels.find((candidate) => modelKey(candidate.model) === key);
  return entry?.weeklyLimitReserve === undefined ? undefined : entry;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

type WeeklyBlock = { deadline: number; detail: string };

/**
 * When the reserve blocks a model, and why; undefined while it may be used.
 * Inside the release window before a known reset the reserve no longer applies.
 */
function weeklyBlock(key: string, usage: WeeklyUsage, now: number): WeeklyBlock | undefined {
  const settings = reserveSettings(key);
  const reserve = settings?.weeklyLimitReserve;
  if (reserve === undefined) return undefined;
  const left = Math.max(0, 100 - usage.usedPercent);
  if (left > reserve) return undefined;

  const reached = `Weekly limit reserve reached on ${key}: ${formatPercent(left)} of the weekly limit left, `
    + `${WEEKLY_LIMIT_RESERVE_KEY} is ${formatPercent(reserve)}.`;
  if (usage.resetAt === undefined || usage.resetAt <= now) {
    // Without a reset time, re-check once per interval: each check spends a request.
    const deadline = now + WEEKLY_BUDGET_UNKNOWN_RESET_RECHECK_MS;
    return { deadline, detail: `${reached} Not using this model until ${formatTime(deadline)} (the provider did not report the weekly reset time).` };
  }

  const releaseMs = settings?.releaseReserveBeforeResetMs;
  if (releaseMs === undefined) {
    return { deadline: usage.resetAt, detail: `${reached} Not using this model until the weekly limit resets at ${formatTime(usage.resetAt)}.` };
  }
  const releaseAt = usage.resetAt - releaseMs;
  if (now >= releaseAt) return undefined;
  return {
    deadline: releaseAt,
    detail: `${reached} Not using this model until ${formatTime(releaseAt)}, ${releaseMs / 3_600_000}h before the weekly limit resets at `
      + `${formatTime(usage.resetAt)} (${RELEASE_RESERVE_BEFORE_RESET_KEY}).`,
  };
}

/**
 * Block a model once its unused weekly share drops to the configured reserve. The
 * request that reported the usage has already been served and continues; only
 * later requests avoid the model until the reserve is released or the window resets.
 */
export function recordWeeklyUsage(model: Model<Api>, usage: WeeklyUsage | undefined, now = Date.now()): void {
  if (!usage) return;
  const key = modelKey(model);
  const block = weeklyBlock(key, usage, now);
  if (!block) return;

  const previous = state.rateLimitMemory.get(key);
  const repeated = previous?.reason === "weekly-budget" && previous.deadline === block.deadline;
  // Always store a new record: success-clearing compares record identity, so
  // fresh evidence must survive the attempt that reported it.
  const record: RateLimitMemory = {
    reason: "weekly-budget",
    limitedAt: now,
    deadline: block.deadline,
    explicitDeadline: true,
    detail: block.detail,
    weeklyUsage: usage,
  };
  state.rateLimitMemory.set(key, record);
  if (repeated) return;
  try { state.sharedCtx?.ui.notify(`⛔ ${block.detail}`, "warning"); } catch { /* UI unavailable */ }
}

/** Re-evaluate weekly blocks against the current settings. */
export function pruneWeeklyBudgetMemory(now = Date.now()): void {
  for (const [key, record] of state.rateLimitMemory) {
    if (record.reason !== "weekly-budget" || !record.weeklyUsage) continue;
    const block = weeklyBlock(key, record.weeklyUsage, now);
    if (!block) state.rateLimitMemory.delete(key);
    // An unknown reset keeps its original re-check time instead of sliding forward.
    else if (record.weeklyUsage.resetAt !== undefined && record.weeklyUsage.resetAt > now) {
      record.deadline = block.deadline;
      record.detail = block.detail;
    }
  }
}
