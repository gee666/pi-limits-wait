import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_UNKNOWN_ERROR_MAX_RETRIES,
  DEFAULT_UNKNOWN_ERROR_RETRY_INTERVAL_MS,
} from "./constants.js";
import type { FallbackModel, NonRetryableFailureMemory, RateLimitMemory } from "./types.js";

export const state = {
  sharedCtx: undefined as ExtensionContext | undefined,
  extensionApi: undefined as ExtensionAPI | undefined,
  ambientStatusCleanup: undefined as (() => void) | undefined,
  modelStatusCleanup: undefined as (() => void) | undefined,
  fallbackModels: [] as FallbackModel[],
  unknownErrorWaitingEnabled: true,
  // Includes the initial request, so the default is one more than max retries.
  nonRetryableMaxAttempts: DEFAULT_UNKNOWN_ERROR_MAX_RETRIES + 1,
  nonRetryableRetryDelayMs: DEFAULT_UNKNOWN_ERROR_RETRY_INTERVAL_MS,
  // How often a still-limited higher-priority model is re-probed. 0 disables.
  probeIntervalMs: DEFAULT_PROBE_INTERVAL_MS,
  primaryModel: undefined as Model<Api> | undefined,
  primaryThinkingLevel: undefined as ModelThinkingLevel | undefined,
  manualModelOverride: undefined as Model<Api> | undefined,
  manualModelOverrideReleased: false,
  expectedModelSelections: new Map<string, Set<symbol>>(),
  userModelSelectionGeneration: 0,
  activeWaitSkips: new Set<() => void>(),
  settingsSignature: undefined as string | undefined,
  rateLimitMemory: new Map<string, RateLimitMemory>(),
  nonRetryableFailureMemory: new Map<string, NonRetryableFailureMemory>(),
};

function selectionKey(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function expectModelSelection(model: Pick<Model<Api>, "provider" | "id">): () => void {
  const key = selectionKey(model);
  const token = Symbol(key);
  const pending = state.expectedModelSelections.get(key) ?? new Set<symbol>();
  pending.add(token);
  state.expectedModelSelections.set(key, pending);
  return () => {
    const current = state.expectedModelSelections.get(key);
    current?.delete(token);
    if (current?.size === 0) state.expectedModelSelections.delete(key);
  };
}

export function consumeExpectedModelSelection(model: Pick<Model<Api>, "provider" | "id">): boolean {
  const key = selectionKey(model);
  const pending = state.expectedModelSelections.get(key);
  const token = pending?.values().next().value as symbol | undefined;
  if (!pending || !token) return false;
  pending.delete(token);
  if (pending.size === 0) state.expectedModelSelections.delete(key);
  return true;
}

export function resetRuntimeStateForTests(models: FallbackModel[], ctx?: ExtensionContext): void {
  state.fallbackModels = models;
  state.probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS;
  state.sharedCtx = ctx;
  state.primaryModel = undefined;
  state.primaryThinkingLevel = undefined;
  state.manualModelOverride = undefined;
  state.manualModelOverrideReleased = false;
  state.rateLimitMemory.clear();
  state.nonRetryableFailureMemory.clear();
  state.expectedModelSelections.clear();
  state.userModelSelectionGeneration = 0;
  state.activeWaitSkips.clear();
  state.ambientStatusCleanup?.();
  state.modelStatusCleanup?.();
}
