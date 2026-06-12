import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { FallbackModel, NonRetryableFailureMemory, RateLimitMemory, StreamSimpleFn } from "./types.js";

export const state = {
  sharedCtx: undefined as ExtensionContext | undefined,
  extensionApi: undefined as ExtensionAPI | undefined,
  restoreFetch: undefined as (() => void) | undefined,
  ambientStatusCleanup: undefined as (() => void) | undefined,
  activeProviderRequests: 0,
  activeFallbackProviderRequests: 0,
  lastObservedRateLimitError: undefined as { at: number; message: string } | undefined,
  wrappedApis: new Set<Api>(),
  builtinStreamSimpleByApi: new Map<Api, StreamSimpleFn>(),
  fallbackModels: [] as FallbackModel[],
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
  state.lastObservedRateLimitError = undefined;
  state.ambientStatusCleanup?.();
}
