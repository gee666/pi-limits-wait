import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isInternalSyntheticModel } from "./models.js";
import { sanitiseAnthropicPayloadSystem } from "./prompt.js";
import { loadFallbackSettings } from "./settings.js";
import { state } from "./state.js";
import { registerWrappedApi } from "./stream.js";

export { sanitiseAnthropicPayloadSystem, sanitiseSystemPrompt } from "./prompt.js";
export {
  getRetryableError,
  isAuthenticationRefreshError,
  isRateLimitError,
  isServerOverloadedError,
  isTransientNetworkError,
  parseRetryDelayMs,
  rateLimitWaitMs,
  retryAfterHeaderMs,
} from "./retry-errors.js";
export {
  __readFallbackSettingsForTests,
  configFileCandidates,
  readFallbackSettings,
} from "./settings.js";
export {
  __configureFallbackModelsForTests,
  __setNonRetryableTuningForTests,
  streamWithLimitsRetry,
  streamWithRateLimitRetry,
} from "./stream.js";
export { freezingEnabled, waitForRateLimit, waitForRetry } from "./ui.js";
export type { FallbackModel } from "./types.js";

function registerContextApis(pi: ExtensionAPI, ctx: ExtensionContext): void {
  for (const model of ctx.modelRegistry.getAll()) {
    if (!isInternalSyntheticModel(model)) registerWrappedApi(pi, model.api);
  }
  if (ctx.model && !isInternalSyntheticModel(ctx.model)) registerWrappedApi(pi, ctx.model.api);
}

export default function (pi: ExtensionAPI) {
  state.extensionApi = pi;

  // Anthropic now rejects Claude Pro/Max (OAuth) requests whose system prompt
  // still carries the host agent's fingerprints (pi-coding-agent paths, "You
  // are pi", etc.). pi-ai prepends the Claude Code identity block for OAuth
  // tokens but passes the host system prompt through as a second block, which
  // trips the check. Sanitise that block on the outbound payload right before
  // it is sent. This hook fires for every provider request and only mutates
  // Anthropic OAuth payloads (identified by the Claude Code identity block), so
  // API-key Anthropic calls and non-Anthropic providers are untouched.
  pi.on("before_provider_request", (event) => sanitiseAnthropicPayloadSystem(event.payload));

  pi.on("model_select", (event) => {
    if (state.suppressNextModelSelect) {
      state.suppressNextModelSelect = false;
      return;
    }
    if (isInternalSyntheticModel(event.model)) return;
    state.primaryModel = event.model;
    state.primaryThinkingLevel = pi.getThinkingLevel();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    state.sharedCtx = ctx;
    if (!state.primaryModel && ctx.model && !isInternalSyntheticModel(ctx.model)) state.primaryModel = ctx.model;
    state.primaryThinkingLevel ??= pi.getThinkingLevel();
    loadFallbackSettings(ctx);

    // Some extensions may register providers after this extension loads. Wrap
    // any APIs that exist by the time an agent starts too.
    registerContextApis(pi, ctx);

    // Anthropic subscription/OAuth identity is applied per provider request in
    // streamWithLimitsRetry(). Doing it there ensures every retry/fallback
    // attempt gets the right prompt for its actual target model, while
    // non-Anthropic providers never inherit the Claude Code identity.
  });

  // Run once more after all before_agent_start handlers have completed and the
  // agent loop is about to make its first provider request. This catches
  // providers that another extension registered during before_agent_start after
  // our handler had already run.
  pi.on("agent_start", (_event, ctx) => {
    state.sharedCtx = ctx;
    registerContextApis(pi, ctx);
  });
}
