import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Api, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { DEFAULT_NON_RETRYABLE_FREEZE_MS } from "./constants.js";
import { isRateLimitError, parseRetryDelayMs } from "./retry-errors.js";
import { state } from "./state.js";
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

export function candidateOrder(current: Model<Api>): FallbackModel[] {
  const primary = getPrimaryModel(current);
  const order: FallbackModel[] = [{ model: primary, reasoningEffort: state.primaryThinkingLevel }];
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

export function recentObservedHttpError(maxAgeMs = 60_000): string | undefined {
  if (!state.lastObservedHttpError) return undefined;
  if (Date.now() - state.lastObservedHttpError.at > maxAgeMs) return undefined;
  return state.lastObservedHttpError.message;
}

export function recentObservedRateLimitError(maxAgeMs = 60_000): string | undefined {
  const message = recentObservedHttpError(maxAgeMs);
  return message && isRateLimitError(message) ? message : undefined;
}

export function errorMessageWithRecentHttpStatus(errorMessage: string): string {
  const observed = recentObservedHttpError();
  if (!observed || errorMessage.includes(observed)) return errorMessage;

  // SDK errors often keep only "429 Too Many Requests" and drop the response
  // headers. Keep the observed fetch response when it carries retry timing, so
  // Claude subscription limits use their exact reset/retry time instead of the
  // generic 30 minute fallback.
  const currentHasRetryTiming = parseRetryDelayMs(errorMessage) !== undefined;
  const observedHasRetryTiming = parseRetryDelayMs(observed) !== undefined;
  if (!currentHasRetryTiming && observedHasRetryTiming) return `${observed}; Error: ${errorMessage}`;

  if (/(?:^|\D)[1-5]\d\d(?:\D|$)/.test(errorMessage)) return errorMessage;
  return `${observed}; Error: ${errorMessage}`;
}

export function earliestCandidateDeadline(current: Model<Api>): number | undefined {
  const deadlines = candidateOrder(current)
    .map((entry) => activeLimit(entry.model)?.deadline ?? activeNonRetryableFailure(entry.model)?.deadline)
    .filter((deadline): deadline is number => typeof deadline === "number");
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

export function initialAttempt(model: Model<Api>): FallbackModel {
  const configured = state.fallbackModels.find((entry) => modelKey(entry.model) === modelKey(model));
  const current = configured ?? { model, reasoningEffort: state.primaryThinkingLevel };
  if (!fallbackEnabled() || (!activeLimit(model) && !hasNonRetryableFailure(model))) return current;
  return nextAvailableCandidate(model) ?? current;
}

export async function optionsForModel(
  originalModel: Model<Api>,
  target: FallbackModel,
  options?: SimpleStreamOptions,
  ctx: ExtensionContext | undefined = state.sharedCtx,
): Promise<SimpleStreamOptions | undefined> {
  const level = target.reasoningEffort ?? state.primaryThinkingLevel;
  const reasoning = level && level !== "off" ? level : undefined;
  if (modelKey(originalModel) === modelKey(target.model)) {
    return reasoning ? { ...options, reasoning } : options;
  }
  const auth = await ctx?.modelRegistry.getApiKeyAndHeaders(target.model);
  if (!auth?.ok) throw new Error(auth ? auth.error : "Model registry is unavailable.");
  return {
    ...options,
    ...(reasoning ? { reasoning } : {}),
    apiKey: auth.apiKey,
    headers: auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
  } as SimpleStreamOptions;
}

export async function switchPiModel(entry: FallbackModel): Promise<void> {
  const pi = state.extensionApi;
  if (!pi) return;
  const current = state.sharedCtx?.model;
  if (current && modelKey(current) === modelKey(entry.model)) return;
  state.suppressNextModelSelect = true;
  const ok = await pi.setModel(entry.model);
  if (!ok) {
    state.suppressNextModelSelect = false;
    return;
  }
  const level = entry.reasoningEffort ?? state.primaryThinkingLevel;
  if (level) pi.setThinkingLevel(level);
  state.sharedCtx?.ui.notify(`Switched to ${formatModel(entry.model)}${level ? ` (${level})` : ""}.`, "info");
}
