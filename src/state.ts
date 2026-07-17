import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { NON_RETRYABLE_MAX_ATTEMPTS, NON_RETRYABLE_RETRY_DELAY_MS } from "./constants.js";
import type { FallbackModel, NonRetryableFailureMemory, RateLimitMemory } from "./types.js";

export const state = {
  sharedCtx: undefined as ExtensionContext | undefined,
  extensionApi: undefined as ExtensionAPI | undefined,
  ambientStatusCleanup: undefined as (() => void) | undefined,
  modelStatusCleanup: undefined as (() => void) | undefined,
  fallbackModels: [] as FallbackModel[],
  nonRetryableMaxAttempts: NON_RETRYABLE_MAX_ATTEMPTS,
  nonRetryableRetryDelayMs: NON_RETRYABLE_RETRY_DELAY_MS,
  primaryModel: undefined as Model<Api> | undefined,
  primaryThinkingLevel: undefined as ModelThinkingLevel | undefined,
  expectedModelSelections: new Map<string, Set<symbol>>(),
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
  state.sharedCtx = ctx;
  state.primaryModel = undefined;
  state.primaryThinkingLevel = undefined;
  state.rateLimitMemory.clear();
  state.nonRetryableFailureMemory.clear();
  state.expectedModelSelections.clear();
  state.ambientStatusCleanup?.();
  state.modelStatusCleanup?.();
}
