import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isInternalSyntheticModel } from "./models.js";
import { sanitiseAnthropicPayloadSystem } from "./prompt.js";
import { RetrySummaryCoordinator } from "./retry-summary.js";
import { loadFallbackSettings } from "./settings.js";
import { allWaitingDisabled, loadUnknownErrorRetrySettings } from "./ui.js";
import { consumeExpectedModelSelection, state } from "./state.js";
import { disableModelRuntimeInterception, installModelRuntimeInterception } from "./stream.js";

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
  __createRetrySummaryCoordinatorForTests,
  LIMITS_WAIT_ENTRY_TYPE,
  RetrySummaryCoordinator,
} from "./retry-summary.js";
export {
  LIMITS_WAIT_EVENT_CHANNEL,
} from "./telemetry.js";
export {
  CONTROL_FILE_ENV_VAR,
  EXTENSION_VERSION,
  LIVELINESS_JSON_STATUS_KEY,
  LIVELINESS_JSON_VERSION,
  LIVELINESS_STATUS_KEY,
  STATUS_JSON_ENV_VAR,
} from "./constants.js";
export {
  clearStatusJson,
  controlFilePath,
  publishStatusJson,
  statusJsonEnabled,
  statusPayload,
} from "./status-json.js";
export type {
  LimitsWaitStatusContext,
  LimitsWaitStatusEvent,
  LimitsWaitStatusPayload,
} from "./status-json.js";
export type {
  LimitsWaitEndEventPayload,
  LimitsWaitEventPayload,
  LimitsWaitModel,
  LimitsWaitOutcome,
  LimitsWaitStartEventPayload,
  LimitsWaitWaitEndPayload,
  LimitsWaitWaitEventPayload,
  LimitsWaitWaitOutcome,
  LimitsWaitWaitStartPayload,
} from "./telemetry.js";
export type { LimitsWaitSessionEntryData } from "./retry-summary.js";
export {
  __configureFallbackModelsForTests,
  __setNonRetryableTuningForTests,
  disableModelRuntimeInterception,
  installModelRuntimeInterception,
  streamWithLimitsRetry,
  streamWithRateLimitRetry,
} from "./stream.js";
export {
  allWaitingDisabled,
  clearLivelinessStatus,
  freezingEnabled,
  isNonInteractiveHost,
  loadUnknownErrorRetrySettings,
  notifyFinalFailure,
  notifyLiveliness,
  waitForRateLimit,
  waitForRetry,
} from "./ui.js";
export type { FallbackModel } from "./types.js";

export default function (pi: ExtensionAPI) {
  // Current pi-ai inserts the Claude Code identity as the first system block
  // for Anthropic OAuth. Sanitise only that exact payload shape; authentication,
  // identity insertion, Anthropic headers, and all other request composition
  // remain owned by ModelRuntime.
  pi.on("before_provider_request", (event) => sanitiseAnthropicPayloadSystem(event.payload));

  // Keep prompt sanitisation and the runtime's normal Anthropic header path,
  // but install no retry/error interception or retry-related lifecycle hooks.
  if (allWaitingDisabled()) {
    disableModelRuntimeInterception();
    return;
  }

  state.extensionApi = pi;
  loadUnknownErrorRetrySettings();
  const retrySummaries = new RetrySummaryCoordinator(pi);
  const releaseInterception = installModelRuntimeInterception(() => retrySummaries.createStream());

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

  // turn_end runs after Pi has persisted the assistant turn, so these custom
  // entries remain durable transcript metadata without entering LLM context.
  pi.on("turn_end", () => {
    retrySummaries.flush();
  });

  pi.on("agent_end", () => {
    retrySummaries.finalizeAndFlush();
  });

  pi.on("session_shutdown", () => {
    // An old extension instance must not disable or clear state owned by a
    // newer /reload instance.
    const ownsInterception = releaseInterception();
    retrySummaries.finalizeAndFlush();
    if (!ownsInterception) return;
    state.ambientStatusCleanup?.();
    state.modelStatusCleanup?.();
    state.expectedModelSelections.clear();
    state.sharedCtx = undefined;
    state.extensionApi = undefined;
  });
}
