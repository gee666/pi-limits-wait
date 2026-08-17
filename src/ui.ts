import { randomUUID } from "node:crypto";
import { readFile, rename, unlink } from "node:fs/promises";
import {
  DEFAULT_LIVELINESS_INTERVAL_MS,
  DEFAULT_UNKNOWN_ERROR_MAX_RETRIES,
  DEFAULT_UNKNOWN_ERROR_RETRY_INTERVAL_MS,
  DEFAULT_WAITING_ENV_VAR,
  DISABLE_ALL_WAITING_ENV_VAR,
  FREEZING_ENV_VAR,
  LIVELINESS_INTERVAL_ENV_VAR,
  LIVELINESS_STATUS_KEY,
  MAX_RETRY_ENV_VAR,
  RETRY_INTERVAL_ENV_VAR,
} from "./constants.js";
import { state } from "./state.js";
import {
  clearStatusJson,
  controlFilePath,
  isSkipToken,
  publishStatusJson,
  statusPayload,
  type LimitsWaitStatusContext,
} from "./status-json.js";
import {
  createWaitId,
  emitWaitTelemetry,
  waitModel,
  type LimitsWaitModel,
  type LimitsWaitWaitEndPayload,
  type LimitsWaitWaitOutcome,
  type LimitsWaitWaitStartPayload,
  type WaitTelemetryOptions,
} from "./telemetry.js";
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

export function envBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const value = raw.trim().toLowerCase();
  return !(value === "false" || value === "0" || value === "no" || value === "off");
}

function envNonNegativeInteger(raw: string | undefined, defaultValue: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return defaultValue;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? Math.min(value, maximum) : defaultValue;
}

export function allWaitingDisabled(): boolean {
  return envBoolean(process.env[DISABLE_ALL_WAITING_ENV_VAR], false);
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

/**
 * True when the host cannot render the TUI countdown (RPC/JSON clients).
 * Such hosts learn about progress only from notifications and status updates,
 * so a retry must never be announced as an error there.
 */
export function isNonInteractiveHost(): boolean {
  const mode = state.sharedCtx?.mode;
  return mode === "rpc" || mode === "json";
}

function livelinessIntervalMs(): number {
  const seconds = envNonNegativeInteger(
    process.env[LIVELINESS_INTERVAL_ENV_VAR],
    DEFAULT_LIVELINESS_INTERVAL_MS / 1_000,
    Math.floor(2_147_483_647 / 1_000),
  );
  return Math.max(1_000, seconds * 1_000);
}

function describeModel(model: Pick<LimitsWaitModel, "provider" | "id"> | undefined): string {
  return model ? `${model.provider}/${model.id}` : "model";
}

/**
 * Progress notice for a retry the extension still intends to perform. It is
 * informational for non-interactive hosts: only a final give-up is an error.
 */
export function notifyLiveliness(message: string): void {
  const ctx = state.sharedCtx;
  if (!ctx) return;
  const nonInteractive = isNonInteractiveHost();
  try { ctx.ui.notify(message, nonInteractive ? "info" : "warning"); } catch { /* UI unavailable */ }
  if (!nonInteractive) return;
  try { ctx.ui.setStatus(LIVELINESS_STATUS_KEY, message); } catch { /* UI unavailable */ }
}

/** Clear any liveliness status entry left behind by a retry wait. */
export function clearLivelinessStatus(): void {
  const ctx = state.sharedCtx;
  if (!ctx || !isNonInteractiveHost()) return;
  try { ctx.ui.setStatus(LIVELINESS_STATUS_KEY, undefined); } catch { /* UI unavailable */ }
  clearStatusJson();
}

/** Structured-channel context for an event that happens outside a wait. */
function standaloneStatusContext(error?: string): LimitsWaitStatusContext {
  return {
    waitId: null,
    reason: null,
    error: error ? formatErrorDetail(error) : null,
    plannedDurationMs: null,
    plannedDeadline: null,
    startedAt: null,
    attempt: null,
    maxAttempts: null,
    livelinessIntervalMs: livelinessIntervalMs(),
    controlFile: controlFilePath() ?? null,
  };
}

/**
 * Terminal failure notice: the extension has stopped retrying. This is the only
 * place where an error-level notification is emitted.
 */
export function notifyFinalFailure(message: string, error?: string): void {
  const ctx = state.sharedCtx;
  if (!ctx) return;
  clearLivelinessStatus();
  if (!isNonInteractiveHost()) return;
  // In TUI the terminal error event is already rendered in the transcript.
  try { ctx.ui.notify(message, "error"); } catch { /* UI unavailable */ }
  publishStatusJson(statusPayload(standaloneStatusContext(error ?? message), "give_up", message, null));
  clearStatusJson();
}

function livelinessText(
  reason: RetryReason,
  remainingMs: number,
  model?: Pick<LimitsWaitModel, "provider" | "id">,
  error?: string,
): string {
  const why = error ? ` Why: ${formatErrorDetail(error)}` : "";
  return (
    `⏳ pi-limits-wait: ${reasonLabel(reason).toLowerCase()} on ${describeModel(model)}; ` +
    `still alive, waiting ${formatDuration(remainingMs)} before the next retry.${why}`
  );
}

/**
 * Publish periodic liveliness notices for hosts without the TUI countdown.
 * Returns a cleanup function.
 */
function startLivelinessReporting(
  context: LimitsWaitStatusContext,
  reason: RetryReason,
  deadline: number,
  model?: Pick<LimitsWaitModel, "provider" | "id">,
  error?: string,
): (clearStatus?: boolean) => void {
  if (!isNonInteractiveHost()) return () => undefined;

  const report = () => {
    const remaining = Math.max(0, deadline - Date.now());
    const message = livelinessText(reason, remaining, model, error);
    notifyLiveliness(message);
    publishStatusJson(statusPayload(context, "wait", message, remaining));
  };
  report();
  const ticker = setInterval(() => {
    if (Date.now() >= deadline) return;
    report();
  }, livelinessIntervalMs());
  return (clearStatus = true) => {
    clearInterval(ticker);
    if (clearStatus) clearLivelinessStatus();
  };
}

function countdownText(reason: RetryReason, deadline: number): string {
  const remaining = Math.max(0, deadline - Date.now());
  const totalSecs = Math.ceil(remaining / 1_000);
  const mins = Math.floor(totalSecs / 60);
  const secs = (totalSecs % 60).toString().padStart(2, "0");
  return `⏳ ${reasonLabel(reason)} — next retry in ${mins}m ${secs}s`;
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
    ctx.ui.setWorkingMessage(countdownText(reason, deadline));
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

/**
 * Atomically claim the canonical control path before inspecting its contents.
 * The writer may immediately replace the canonical path; cleanup only ever
 * touches the unique claimed path in the same directory.
 */
export async function claimControlFile(controlFile: string, waitId: string): Promise<string | undefined> {
  const claimedFile = `${controlFile}.consumed-${waitId}-${randomUUID()}`;
  try {
    await rename(controlFile, claimedFile);
    return claimedFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    return undefined;
  }
}

/** Coalesce timer ticks while an asynchronous filesystem poll is still running. */
export function createSerializedAsyncRunner<T>(task: () => Promise<T>): {
  run: () => Promise<T>;
  pending: () => Promise<T> | undefined;
} {
  let inFlight: Promise<T> | undefined;
  return {
    run: () => {
      if (inFlight) return inFlight;
      const current = task().finally(() => {
        if (inFlight === current) inFlight = undefined;
      });
      inFlight = current;
      return current;
    },
    pending: () => inFlight,
  };
}

export function waitForRetry(
  reason: RetryReason,
  waitMs: number,
  signal?: AbortSignal,
  telemetry?: WaitTelemetryOptions,
): Promise<LimitsWaitWaitOutcome> {
  if (waitMs <= 0) return Promise.resolve(signal?.aborted ? "aborted" : "waited");

  const startedAt = Date.now();
  const plannedDeadline = startedAt + waitMs;
  const waitId = createWaitId();
  const model = waitModel(telemetry?.model);
  const events = telemetry?.events ?? state.extensionApi?.events;
  const common = {
    version: 1 as const,
    waitId,
    ...(telemetry?.periodId ? { periodId: telemetry.periodId } : {}),
    reason,
    plannedDurationMs: waitMs,
    plannedDeadline,
    startedAt,
    ...(model ? { model } : {}),
    ...(telemetry?.error ? { error: formatErrorDetail(telemetry.error) } : {}),
  };
  emitWaitTelemetry(events, { ...common, phase: "start" } satisfies LimitsWaitWaitStartPayload);

  // Resolved once per wait so a /reload picks up a new value.
  const controlFile = controlFilePath();
  const statusContext: LimitsWaitStatusContext = {
    waitId,
    ...(telemetry?.periodId ? { periodId: telemetry.periodId } : {}),
    reason,
    error: telemetry?.error ? formatErrorDetail(telemetry.error) : null,
    ...(model ? { model } : {}),
    plannedDurationMs: waitMs,
    plannedDeadline,
    startedAt,
    attempt: telemetry?.attempt ?? null,
    maxAttempts: telemetry?.maxAttempts ?? null,
    livelinessIntervalMs: livelinessIntervalMs(),
    controlFile: controlFile ?? null,
  };

  return new Promise((resolve) => {
    const ctx = state.sharedCtx;
    let done = false;
    const stopLiveliness = startLivelinessReporting(statusContext, reason, plannedDeadline, model, telemetry?.error);
    let ticker: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => settle("aborted");

    const skipWait = () => settle("skipped");

    function cleanup() {
      if (ticker) clearInterval(ticker);
      if (timer) clearTimeout(timer);
      state.activeWaitSkips.delete(skipWait);
      try { stopLiveliness(false); } catch { /* UI unavailable */ }
      signal?.removeEventListener("abort", onAbort);
      try { ctx?.ui.setWorkingMessage(); } catch { /* UI unavailable */ }
      try { clearAmbientRetryStatus(); } catch { /* UI unavailable */ }
    }

    /**
     * Out-of-band "retry now": atomically move the observed canonical path to
     * a unique consumed path before reading it. Invalid claims are discarded;
     * cleanup can therefore never unlink a newer token renamed into place.
     */
    let pendingClaim: Promise<void> | undefined;
    async function pollControlFile(): Promise<boolean> {
      if (!controlFile || done) return false;
      let finishClaim!: () => void;
      const claimBarrier = new Promise<void>((resolveClaim) => { finishClaim = resolveClaim; });
      pendingClaim = claimBarrier;
      const claimedFile = await claimControlFile(controlFile, waitId).finally(() => {
        finishClaim();
        if (pendingClaim === claimBarrier) pendingClaim = undefined;
      });
      if (!claimedFile) return false;

      let accepted = false;
      try {
        const raw = await readFile(claimedFile, "utf8");
        const token: unknown = JSON.parse(raw);
        accepted = isSkipToken(token, waitId, startedAt);
      } catch { /* unreadable and malformed claims are discarded */ }

      await unlink(claimedFile).catch(() => undefined);
      return accepted;
    }
    const controlPoll = createSerializedAsyncRunner(pollControlFile);

    function settle(requestedOutcome: LimitsWaitWaitOutcome) {
      if (done) return;
      done = true;
      const pendingPoll = controlPoll.pending();
      const claimBarrier = pendingClaim;
      cleanup();

      void (async () => {
        // Do not let wait N resolve (and wait N+1 begin) while N can still
        // rename the canonical path. A token claimed at the deadline wins over
        // the timer. Explicit skip/abort only drain the bounded claim phase;
        // later reads and unique-path cleanup cannot affect a replacement.
        let acceptedAtSettlement = false;
        if (requestedOutcome === "waited") {
          acceptedAtSettlement = await pendingPoll?.catch(() => false) ?? false;
        } else {
          await claimBarrier?.catch(() => undefined);
        }
        const outcome = acceptedAtSettlement ? "skipped" : requestedOutcome;
        const endedAt = Date.now();
        const actualElapsedMs = Math.max(0, endedAt - startedAt);
        // Published before status cleanup so the consumer learns the outcome
        // first and the cleared key stays the end-of-window marker.
        publishStatusJson(statusPayload(
          statusContext,
          "wait_end",
          livelinessText(reason, Math.max(0, plannedDeadline - endedAt), model, telemetry?.error),
          0,
          { outcome, actualElapsedMs },
        ));
        try { stopLiveliness(); } catch { /* UI unavailable */ }
        try { telemetry?.onEnd?.(actualElapsedMs, outcome); } catch { /* observational callback */ }
        emitWaitTelemetry(events, {
          ...common,
          phase: "end",
          endedAt,
          actualElapsedMs,
          outcome,
        } satisfies LimitsWaitWaitEndPayload);
        resolve(outcome);
      })();
    }

    if (signal?.aborted) {
      settle("aborted");
      return;
    }

    // Raw terminal listeners run before whichever component currently owns
    // focus. Consuming Enter here would steal confirmation from built-in
    // selectors such as /model. Model changes and the out-of-band control
    // channel call this skip function directly instead.
    state.activeWaitSkips.add(skipWait);

    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) {
      settle("aborted");
      return;
    }

    const tick = () => {
      try { ctx?.ui.setWorkingMessage(countdownText(reason, plannedDeadline)); } catch { /* UI unavailable */ }
    };

    tick();
    if (done) return;
    ticker = setInterval(() => {
      const poll = controlPoll.run();
      void poll.then((accepted) => {
        if (accepted && !done) settle("skipped");
      });
      if (Date.now() >= plannedDeadline) settle("waited");
      else tick();
    }, 1_000);
    timer = setTimeout(() => settle("waited"), Math.max(0, plannedDeadline - Date.now()));
  });
}

export function waitForRateLimit(
  waitMs: number,
  signal?: AbortSignal,
): Promise<"waited" | "skipped" | "aborted"> {
  return waitForRetry("rate-limit", waitMs, signal);
}
