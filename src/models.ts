import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_NON_RETRYABLE_FREEZE_MS } from "./constants.js";
import { expectModelSelection, state } from "./state.js";
import type { FallbackModel, RetryableError } from "./types.js";
import { formatErrorDetail, formatDuration, reasonLabel } from "./ui.js";

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

export function candidateOrder(current: Model<Api>): FallbackModel[] {
  const primary = getPrimaryModel(current);
  const order: FallbackModel[] = [configuredAttempt(primary)];
  const seen = new Set([modelKey(primary)]);
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
    state.rateLimitMemory.delete(modelKey(model));
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
  state.sharedCtx?.ui.notify(`${formatModel(model)} ${reasonLabel(retryable.reason).toLowerCase()} for ${formatDuration(retryable.waitMs)}.${detail}`, "warning");
}

export function notifyRetryingAfterError(model: Model<Api>, waitMs: number, errorMessage: string): void {
  state.sharedCtx?.ui.notify(`${formatModel(model)} retrying after error for ${formatDuration(waitMs)}. Error: ${formatErrorDetail(errorMessage, Number.MAX_SAFE_INTEGER)}`, "warning");
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
    state.nonRetryableFailureMemory.delete(modelKey(model));
    return undefined;
  }
  return entry;
}

export function hasNonRetryableFailure(model: Model<Api>): boolean {
  return Boolean(activeNonRetryableFailure(model));
}

export function nextAvailableCandidate(current: Model<Api>): FallbackModel | undefined {
  return candidateOrder(current).find((entry) => !activeLimit(entry.model) && !hasNonRetryableFailure(entry.model));
}

export function rememberNonRetryableFailure(model: Model<Api>, errorMessage: string): void {
  const deadline = Date.now() + DEFAULT_NON_RETRYABLE_FREEZE_MS;
  state.nonRetryableFailureMemory.set(modelKey(model), { failedAt: Date.now(), deadline, errorMessage });
  state.sharedCtx?.ui.notify(`${formatModel(model)} failed (${formatErrorDetail(errorMessage)}); freezing it for ${formatDuration(DEFAULT_NON_RETRYABLE_FREEZE_MS)} and trying another configured model if available.`, "warning");
  ensureRateLimitedModelsStatus();
}

export function earliestCandidateDeadline(current: Model<Api>): number | undefined {
  const deadlines = candidateOrder(current)
    .map((entry) => activeLimit(entry.model)?.deadline ?? activeNonRetryableFailure(entry.model)?.deadline)
    .filter((deadline): deadline is number => typeof deadline === "number");
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

export function initialAttempt(model: Model<Api>): FallbackModel {
  const current = configuredAttempt(model);
  if (!fallbackEnabled() || (!activeLimit(model) && !hasNonRetryableFailure(model))) return current;
  return nextAvailableCandidate(model) ?? current;
}

let modelSwitchQueue = Promise.resolve();

export async function switchPiModel(entry: FallbackModel, signal?: AbortSignal): Promise<void> {
  const operation = modelSwitchQueue.then(async () => {
    if (signal?.aborted) return;
    const pi = state.extensionApi;
    if (!pi) return;
    const current = state.sharedCtx?.model;
    if (current && modelKey(current) === modelKey(entry.model)) return;
    if (signal?.aborted) return;

    const cancelExpectedSelection = expectModelSelection(entry.model);
    try {
      const ok = await pi.setModel(entry.model);
      if (!ok) {
        cancelExpectedSelection();
        return;
      }
      if (signal?.aborted) return;
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
}
