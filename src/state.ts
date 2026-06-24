import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { NON_RETRYABLE_MAX_ATTEMPTS, NON_RETRYABLE_RETRY_DELAY_MS } from "./constants.js";
import type { FallbackModel, NonRetryableFailureMemory, RateLimitMemory, StreamSimpleFn } from "./types.js";

export const state = {
  sharedCtx: undefined as ExtensionContext | undefined,
  extensionApi: undefined as ExtensionAPI | undefined,
  restoreFetch: undefined as (() => void) | undefined,
  ambientStatusCleanup: undefined as (() => void) | undefined,
  modelStatusCleanup: undefined as (() => void) | undefined,
  activeProviderRequests: 0,
  activeFallbackProviderRequests: 0,
  lastObservedHttpError: undefined as { at: number; message: string } | undefined,
  wrappedApis: new Set<Api>(),
  builtinStreamSimpleByApi: new Map<Api, StreamSimpleFn>(),
  fallbackModels: [] as FallbackModel[],
  nonRetryableMaxAttempts: NON_RETRYABLE_MAX_ATTEMPTS,
  nonRetryableRetryDelayMs: NON_RETRYABLE_RETRY_DELAY_MS,
  primaryModel: undefined as Model<Api> | undefined,
  primaryThinkingLevel: undefined as ThinkingLevel | undefined,
  suppressNextModelSelect: false,
  settingsSignature: undefined as string | undefined,
  rateLimitMemory: new Map<string, RateLimitMemory>(),
  nonRetryableFailureMemory: new Map<string, NonRetryableFailureMemory>(),
};

export function resetRuntimeStateForTests(models: FallbackModel[], ctx?: ExtensionContext): void {
  state.fallbackModels = models;
  state.sharedCtx = ctx;
  state.primaryModel = undefined;
  state.primaryThinkingLevel = undefined;
  state.rateLimitMemory.clear();
  state.nonRetryableFailureMemory.clear();
  state.lastObservedHttpError = undefined;
  state.ambientStatusCleanup?.();
  state.modelStatusCleanup?.();
}
