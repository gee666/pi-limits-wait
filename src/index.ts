import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isInternalSyntheticModel } from "./models.js";
import { sanitiseAnthropicPayloadSystem } from "./prompt.js";
import { loadFallbackSettings } from "./settings.js";
import { loadUnknownErrorRetrySettings } from "./ui.js";
import { consumeExpectedModelSelection, state } from "./state.js";
import { installModelRuntimeInterception } from "./stream.js";

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
  installModelRuntimeInterception,
  streamWithLimitsRetry,
  streamWithRateLimitRetry,
} from "./stream.js";
export { freezingEnabled, loadUnknownErrorRetrySettings, waitForRateLimit, waitForRetry } from "./ui.js";
export type { FallbackModel } from "./types.js";

export default function (pi: ExtensionAPI) {
  state.extensionApi = pi;
  loadUnknownErrorRetrySettings();
  const releaseInterception = installModelRuntimeInterception();

  // Current pi-ai inserts the Claude Code identity as the first system block
  // for Anthropic OAuth. Sanitise only that exact payload shape; authentication,
  // identity insertion and all request composition remain owned by ModelRuntime.
  pi.on("before_provider_request", (event) => sanitiseAnthropicPayloadSystem(event.payload));

  pi.on("model_select", (event) => {
    if (consumeExpectedModelSelection(event.model)) return;
    if (isInternalSyntheticModel(event.model)) return;
    state.primaryModel = event.model;
    state.primaryThinkingLevel = pi.getThinkingLevel();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    state.sharedCtx = ctx;
    if (!state.primaryModel && ctx.model && !isInternalSyntheticModel(ctx.model)) state.primaryModel = ctx.model;
    state.primaryThinkingLevel ??= pi.getThinkingLevel();
    loadFallbackSettings(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    state.sharedCtx = ctx;
  });

  pi.on("session_shutdown", () => {
    // An old extension instance must not disable or clear state owned by a
    // newer /reload instance.
    if (!releaseInterception()) return;
    state.ambientStatusCleanup?.();
    state.modelStatusCleanup?.();
    state.expectedModelSelections.clear();
    state.sharedCtx = undefined;
    state.extensionApi = undefined;
  });
}
