import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CLAUDE_CODE_IDENTITY } from "./constants.js";
import { isInternalSyntheticModel } from "./models.js";
import { isAnthropicOAuthSession, sanitiseSystemPrompt } from "./prompt.js";
import { loadFallbackSettings } from "./settings.js";
import { state } from "./state.js";
import { registerWrappedApi } from "./stream.js";

export { sanitiseSystemPrompt } from "./prompt.js";
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

export default function (pi: ExtensionAPI) {
  state.extensionApi = pi;

  pi.on("model_select", (event) => {
    if (state.suppressNextModelSelect) {
      state.suppressNextModelSelect = false;
      return;
    }
    if (isInternalSyntheticModel(event.model)) return;
    state.primaryModel = event.model;
    state.primaryThinkingLevel = pi.getThinkingLevel();
  });

  pi.on("before_agent_start", (event, ctx) => {
    state.sharedCtx = ctx;
    if (!state.primaryModel && ctx.model && !isInternalSyntheticModel(ctx.model)) state.primaryModel = ctx.model;
    state.primaryThinkingLevel ??= pi.getThinkingLevel();
    loadFallbackSettings(ctx);

    // Some extensions may register providers after this extension loads. Wrap
    // any APIs that exist by the time an agent starts too.
    for (const model of ctx.modelRegistry.getAll()) {
      if (!isInternalSyntheticModel(model)) registerWrappedApi(pi, model.api);
    }
    if (ctx.model && !isInternalSyntheticModel(ctx.model)) registerWrappedApi(pi, ctx.model.api);

    // Anthropic subscription/OAuth requests identify as Claude Code, not Pi.
    if (!isAnthropicOAuthSession(ctx)) return;

    const sanitised = sanitiseSystemPrompt(event.systemPrompt);
    return {
      systemPrompt: sanitised
        ? `${CLAUDE_CODE_IDENTITY}\n\n${sanitised}`
        : CLAUDE_CODE_IDENTITY,
    };
  });
}
