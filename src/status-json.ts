import {
  CONTROL_FILE_ENV_VAR,
  LIVELINESS_JSON_STATUS_KEY,
  LIVELINESS_JSON_VERSION,
  EXTENSION_VERSION,
  STATUS_JSON_ENV_VAR,
} from "./constants.js";
import { state } from "./state.js";
import type { LimitsWaitModel, LimitsWaitWaitOutcome } from "./telemetry.js";
import type { RetryReason } from "./types.js";
import { allWaitingDisabled, envBoolean, formatErrorDetail, isNonInteractiveHost } from "./ui.js";

export type LimitsWaitStatusEvent = "wait" | "wait_end" | "give_up";

/**
 * Machine-readable sibling of the human liveliness notice. Serialised as one
 * minified JSON line under LIVELINESS_JSON_STATUS_KEY. Field order matches the
 * documented wire shape; consumers must parse, not pattern-match.
 */
export type LimitsWaitStatusPayload = {
  v: typeof LIVELINESS_JSON_VERSION;
  ext: string;
  event: LimitsWaitStatusEvent;
  waitId: string | null;
  periodId?: string;
  reason: RetryReason | null;
  message: string;
  error: string | null;
  model?: LimitsWaitModel;
  plannedDurationMs: number | null;
  plannedDeadline: number | null;
  startedAt: number | null;
  remainingMs: number | null;
  attempt: number | null;
  maxAttempts: number | null;
  livelinessIntervalMs: number;
  controlFile: string | null;
  outcome?: LimitsWaitWaitOutcome;
  actualElapsedMs?: number;
};

/** Everything about a wait that does not change between publishes. */
export type LimitsWaitStatusContext = Omit<
  LimitsWaitStatusPayload,
  "v" | "ext" | "event" | "message" | "remainingMs" | "outcome" | "actualElapsedMs"
>;

/** The structured channel is opt-out; the master kill switch always wins. */
export function statusJsonEnabled(): boolean {
  if (allWaitingDisabled()) return false;
  return envBoolean(process.env[STATUS_JSON_ENV_VAR], true);
}

/** Absolute path of the out-of-band control file, or undefined when disabled. */
export function controlFilePath(): string | undefined {
  if (allWaitingDisabled()) return undefined;
  return process.env[CONTROL_FILE_ENV_VAR]?.trim() || undefined;
}

export function statusPayload(
  context: LimitsWaitStatusContext,
  event: LimitsWaitStatusEvent,
  message: string,
  remainingMs: number | null,
  extra?: { outcome?: LimitsWaitWaitOutcome; actualElapsedMs?: number },
): LimitsWaitStatusPayload {
  return {
    v: LIVELINESS_JSON_VERSION,
    ext: EXTENSION_VERSION,
    event,
    waitId: context.waitId,
    ...(context.periodId ? { periodId: context.periodId } : {}),
    reason: context.reason,
    message: formatErrorDetail(message),
    error: context.error,
    ...(context.model ? { model: context.model } : {}),
    plannedDurationMs: context.plannedDurationMs,
    plannedDeadline: context.plannedDeadline,
    startedAt: context.startedAt,
    remainingMs,
    attempt: context.attempt,
    maxAttempts: context.maxAttempts,
    livelinessIntervalMs: context.livelinessIntervalMs,
    controlFile: context.controlFile,
    ...(extra?.outcome ? { outcome: extra.outcome } : {}),
    ...(extra?.actualElapsedMs === undefined ? {} : { actualElapsedMs: extra.actualElapsedMs }),
  };
}

/** No-op unless the host is non-interactive and the channel is enabled. */
export function publishStatusJson(payload: LimitsWaitStatusPayload): void {
  const ctx = state.sharedCtx;
  if (!ctx || !isNonInteractiveHost() || !statusJsonEnabled()) return;
  try { ctx.ui.setStatus(LIVELINESS_JSON_STATUS_KEY, JSON.stringify(payload)); } catch { /* UI unavailable */ }
}

/** A blank status under the JSON key is the end-of-window marker. */
export function clearStatusJson(): void {
  const ctx = state.sharedCtx;
  if (!ctx || !isNonInteractiveHost() || !statusJsonEnabled()) return;
  try { ctx.ui.setStatus(LIVELINESS_JSON_STATUS_KEY, undefined); } catch { /* UI unavailable */ }
}

/**
 * Accept an out-of-band skip token only for the wait it was issued for.
 * Three independent guards keep a leftover token from skipping a later wait:
 * waitId equality (or the explicit "*" wildcard), issuedAt >= this wait's
 * startedAt, and unlinking the file when it is consumed.
 */
export function isSkipToken(token: unknown, waitId: string, startedAt: number): boolean {
  if (!token || typeof token !== "object") return false;
  const candidate = token as { action?: unknown; waitId?: unknown; issuedAt?: unknown };
  if (candidate.action !== "skip") return false;
  if (candidate.waitId !== waitId && candidate.waitId !== "*") return false;
  return typeof candidate.issuedAt === "number" && candidate.issuedAt >= startedAt;
}
