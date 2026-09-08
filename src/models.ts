import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_NON_RETRYABLE_FREEZE_MS } from "./constants.js";
import { expectModelSelection, state } from "./state.js";
import type { FallbackModel, RetryableError } from "./types.js";
import { formatErrorDetail, formatDuration, notifyLiveliness, reasonLabel } from "./ui.js";

export function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function formatModel(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function isInternalSyntheticModel(model: Pick<Model<Api>, "provider" | "id">): boolean {
  return model.provider.startsWith("pi-") || model.id.startsWith("synthetic-");
}

export function isFallbackEligibleModel(model: Model<Api>): boolean {
  if (isInternalSyntheticModel(model)) return false;
  const key = modelKey(model);
  return state.primaryModel
    ? key === modelKey(state.primaryModel) || state.fallbackModels.some((entry) => modelKey(entry.model) === key)
    : true;
}

export function fallbackEnabled(): boolean {
  return state.fallbackModels.length > 0;
}

export function getPrimaryModel(current: Model<Api>): Model<Api> {
  return state.primaryModel ?? current;
}

export function configuredAttempt(model: Model<Api>): FallbackModel {
  return state.fallbackModels.find((entry) => modelKey(entry.model) === modelKey(model))
    ?? { model, reasoningEffort: state.primaryThinkingLevel };
}

/**
 * Listed models are authoritative, top to bottom. An explicitly selected
 * model outside the list stays first; the configured list is used only if
 * that selection fails. Unrelated calls are excluded by isFallbackEligibleModel.
 */
export function candidateOrder(current: Model<Api>): FallbackModel[] {
  const primary = getPrimaryModel(current);
  const listed = state.fallbackModels.some((entry) => modelKey(entry.model) === modelKey(primary));
  const order: FallbackModel[] = listed ? [] : [configuredAttempt(primary)];
  const seen = new Set(order.map((entry) => modelKey(entry.model)));
  for (const entry of state.fallbackModels) {
    const key = modelKey(entry.model);
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(entry);
  }
  return order;
}

export function activeLimit(model: Model<Api>) {
  const entry = state.rateLimitMemory.get(modelKey(model));
  if (!entry) return undefined;
  if (Date.now() >= entry.deadline) {
    return undefined;
  }
  return entry;
}

export function ensureRateLimitedModelsStatus(): void {
  // Intentionally no-op: limited/frozen model information is communicated via
  // chat notifications only. Do not render persistent TUI status lines.
}

export function notifyRetryableError(model: Model<Api>, retryable: RetryableError, errorMessage?: string): void {
  const detail = errorMessage ? ` Error: ${formatErrorDetail(errorMessage, Number.MAX_SAFE_INTEGER)}` : "";
  // A retry is still planned, so this is progress information, not a failure.
  notifyLiveliness(`${formatModel(model)} ${reasonLabel(retryable.reason).toLowerCase()} for ${formatDuration(retryable.waitMs)}; waiting, then retrying.${detail}`);
}

export function notifyRetryingAfterError(model: Model<Api>, waitMs: number, errorMessage: string): void {
  notifyLiveliness(`${formatModel(model)} retrying after error in ${formatDuration(waitMs)}. Error: ${formatErrorDetail(errorMessage, Number.MAX_SAFE_INTEGER)}`);
}

function notifyProbe(model: Model<Api>, remainingMs: number): void {
  const ctx = state.sharedCtx;
  if (!ctx) return;
  const remaining = remainingMs > 0 ? ` (${formatDuration(remainingMs)} left on its remembered limit)` : "";
  try {
    ctx.ui.notify(`Probing higher-priority model ${formatModel(model)}${remaining}.`, "info");
  } catch { /* UI unavailable */ }
}

export function rememberRateLimit(model: Model<Api>, retryable: RetryableError, errorMessage?: string): void {
  const deadline = Date.now() + retryable.waitMs;
  state.rateLimitMemory.set(modelKey(model), { reason: retryable.reason, limitedAt: Date.now(), deadline });
  notifyRetryableError(model, retryable, errorMessage);
  ensureRateLimitedModelsStatus();
}

export function activeNonRetryableFailure(model: Model<Api>) {
  const entry = state.nonRetryableFailureMemory.get(modelKey(model));
  if (!entry) return undefined;
  if (Date.now() >= entry.deadline) {
    return undefined;
  }
  return entry;
}

export function hasNonRetryableFailure(model: Model<Api>): boolean {
  return Boolean(activeNonRetryableFailure(model));
}

export function probeIntervalMs(): number {
  return Math.max(0, state.probeIntervalMs);
}

/**
 * Remembered unusability of a model, merged across the rate-limit and frozen
 * memories, plus the moment it becomes worth re-probing. Remembered deadlines
 * are estimates (`retry-after` is often pessimistic, or absent and defaulted),
 * so a blocked model is re-probed periodically instead of being trusted until
 * its deadline.
 */
export function blockedState(model: Model<Api>): { deadline: number; probeAt: number } | undefined {
  const limit = activeLimit(model);
  const frozen = activeNonRetryableFailure(model);
  if (!limit && !frozen) return undefined;
  const deadline = Math.max(limit?.deadline ?? 0, frozen?.deadline ?? 0);
  // Probe timing follows the most recent evidence of unusability, so a probe
  // that fails again postpones the next probe.
  const lastEvidence = Math.max(
    limit ? limit.lastProbeAt ?? limit.limitedAt : 0,
    frozen ? frozen.lastProbeAt ?? frozen.failedAt : 0,
  );
  const interval = probeIntervalMs();
  const probeAt = interval > 0 ? Math.min(lastEvidence + interval, deadline) : deadline;
  return { deadline, probeAt };
}

export function isModelBlocked(model: Model<Api>): boolean {
  return Boolean(blockedState(model));
}

/** Capture record identities before invoking a provider, for concurrency-safe clearing. */
export function unavailabilitySnapshot(model: Model<Api>) {
  const key = modelKey(model);
  return { limit: state.rateLimitMemory.get(key), frozen: state.nonRetryableFailureMemory.get(key) };
}

/** Successful output clears only the failure evidence known to that attempt. */
export function clearUnavailability(model: Model<Api>, snapshot: ReturnType<typeof unavailabilitySnapshot>): void {
  const key = modelKey(model);
  // Each new failure replaces its record. Older output cannot erase newer evidence.
  if (state.rateLimitMemory.get(key) === snapshot.limit) state.rateLimitMemory.delete(key);
  if (state.nonRetryableFailureMemory.get(key) === snapshot.frozen) state.nonRetryableFailureMemory.delete(key);
}

/** Record that a blocked model was just re-probed, so probes stay rate-limited. */
export function markProbeAttempt(model: Model<Api>, now = Date.now()): void {
  const remainingMs = (blockedState(model)?.deadline ?? now) - now;
  postponeProbe(model, now);
  notifyProbe(model, remainingMs);
}

/** Postpone probing existing evidence without creating or extending a freeze. */
export function postponeProbe(model: Model<Api>, now = Date.now()): void {
  const key = modelKey(model);
  const limit = state.rateLimitMemory.get(key);
  if (limit) limit.lastProbeAt = now;
  const frozen = state.nonRetryableFailureMemory.get(key);
  if (frozen) frozen.lastProbeAt = now;
}

/**
 * The model to use right now, in strict configured priority order: the first
 * candidate that is usable, or - ahead of any lower-priority usable candidate -
 * the first blocked candidate whose probe is due. This is what makes the top
 * model reclaim traffic as soon as it works again.
 */
export function nextAttemptCandidate(
  current: Model<Api>,
  excluded?: ReadonlySet<string>,
): { entry: FallbackModel; probe: boolean } | undefined {
  const now = Date.now();
  for (const entry of candidateOrder(current)) {
    if (excluded?.has(modelKey(entry.model))) continue;
    const blocked = blockedState(entry.model);
    if (!blocked) return { entry, probe: false };
    if (probeIntervalMs() > 0 && now >= blocked.probeAt) {
      return { entry, probe: true };
    }
  }
  return undefined;
}

export function nextAvailableCandidate(current: Model<Api>, excluded?: ReadonlySet<string>): FallbackModel | undefined {
  return nextAttemptCandidate(current, excluded)?.entry;
}

export function rememberNonRetryableFailure(model: Model<Api>, errorMessage: string): void {
  const deadline = Date.now() + DEFAULT_NON_RETRYABLE_FREEZE_MS;
  state.nonRetryableFailureMemory.set(modelKey(model), { failedAt: Date.now(), deadline, errorMessage });
  notifyLiveliness(`${formatModel(model)} failed (${formatErrorDetail(errorMessage)}); freezing it for ${formatDuration(DEFAULT_NON_RETRYABLE_FREEZE_MS)} and trying another configured model if available.`);
  ensureRateLimitedModelsStatus();
}

export function earliestCandidateDeadline(current: Model<Api>): number | undefined {
  const deadlines = candidateOrder(current)
    .map((entry) => activeLimit(entry.model)?.deadline ?? activeNonRetryableFailure(entry.model)?.deadline)
    .filter((deadline): deadline is number => typeof deadline === "number");
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

/**
 * When to stop waiting while every candidate is blocked: the earliest of all
 * remembered deadlines and all due-probe times, so a wait never outlives the
 * next chance to reclaim a higher-priority model.
 */
export function earliestCandidateWakeup(current: Model<Api>, excluded?: ReadonlySet<string>): number | undefined {
  const wakeups = candidateOrder(current)
    .filter((entry) => !excluded?.has(modelKey(entry.model)))
    .map((entry) => blockedState(entry.model)?.probeAt)
    .filter((wakeup): wakeup is number => typeof wakeup === "number");
  return wakeups.length > 0 ? Math.min(...wakeups) : undefined;
}

/**
 * Every request restarts from the top of the priority order, so work returns to
 * the highest-priority usable model on its own instead of sticking to whatever
 * fallback happened to answer last.
 */
export function initialAttempt(model: Model<Api>): FallbackModel | undefined {
  const current = configuredAttempt(model);
  if (!fallbackEnabled()) return current;
  return nextAvailableCandidate(model);
}

let modelSwitchQueue = Promise.resolve();

export async function switchPiModel(
  entry: FallbackModel,
  signal?: AbortSignal,
  canSelect?: (current: Model<Api> | undefined) => boolean,
): Promise<boolean> {
  let selected = false;
  const operation = modelSwitchQueue.then(async () => {
    if (signal?.aborted) return;
    const pi = state.extensionApi;
    if (!pi) return;
    const current = state.sharedCtx?.model;
    if (current && modelKey(current) === modelKey(entry.model)) {
      selected = true;
      return;
    }
    if (canSelect && !canSelect(current)) return;
    if (signal?.aborted) return;

    const cancelExpectedSelection = expectModelSelection(entry.model);
    try {
      const ok = await pi.setModel(entry.model);
      if (!ok) {
        cancelExpectedSelection();
        return;
      }
      if (signal?.aborted) return;
      selected = true;
      const level = entry.reasoningEffort ?? state.primaryThinkingLevel;
      if (level) pi.setThinkingLevel(level);
      if (!signal?.aborted) {
        state.sharedCtx?.ui.notify(`Switched to ${formatModel(entry.model)}${level ? ` (${level})` : ""}.`, "info");
      }
    } catch {
      // The request can outlive its session during /reload or replacement. The
      // interception owner aborts it; never let a stale UI/model switch strand
      // the output stream.
      cancelExpectedSelection();
    }
  });
  modelSwitchQueue = operation.catch(() => undefined);
  await operation;
  return selected;
}
