import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getApiProviders,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { installFetchRateLimitObserver } from "./fetch-observer.js";
import {
  candidateOrder,
  earliestCandidateDeadline,
  errorMessageWithRecentHttpStatus,
  fallbackEnabled,
  getPrimaryModel,
  initialAttempt,
  isFallbackEligibleModel,
  modelKey,
  nextAvailableCandidate,
  notifyRetryableError,
  notifyRetryingAfterError,
  optionsForModel,
  recentObservedRateLimitError,
  rememberNonRetryableFailure,
  rememberRateLimit,
  switchPiModel,
} from "./models.js";
import { anthropicSubscriptionContext } from "./prompt.js";
import { errorMessageWithCauses, getRetryableError, isAbortMessage } from "./retry-errors.js";
import { state } from "./state.js";
import type { FallbackModel, RetryableError, StreamSimpleFn } from "./types.js";
import { clearAmbientRetryStatus, clearModelStatus, freezingEnabled, reasonLabel, waitForRetry } from "./ui.js";

export function __setNonRetryableTuningForTests(maxAttempts: number, retryDelayMs: number): void {
  state.nonRetryableMaxAttempts = maxAttempts;
  state.nonRetryableRetryDelayMs = retryDelayMs;
}

export function __configureFallbackModelsForTests(
  models: FallbackModel[],
  ctx?: ExtensionContext,
): void {
  state.fallbackModels = models;
  state.sharedCtx = ctx;
  state.primaryModel = undefined;
  state.primaryThinkingLevel = undefined;
  state.rateLimitMemory.clear();
  state.nonRetryableFailureMemory.clear();
  state.lastObservedHttpError = undefined;
  state.ambientStatusCleanup?.();
  clearModelStatus();
}

function freshMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function isAbortErrorEvent(event: AssistantMessageEvent, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (event.type !== "error") return false;
  const reason = "reason" in event ? String(event.reason) : "";
  const stopReason = event.error.stopReason ? String(event.error.stopReason) : "";
  const message = event.error.errorMessage ?? "";
  return reason === "aborted" || stopReason === "aborted" || isAbortMessage(message);
}

export function streamWithLimitsRetry(
  delegate: StreamSimpleFn,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();

  void (async () => {
    const requestCtx = state.sharedCtx;
    let committed = false;
    const allowFallback = fallbackEnabled() && isFallbackEligibleModel(model);
    let attempt: FallbackModel = allowFallback ? initialAttempt(model) : { model, reasoningEffort: state.primaryThinkingLevel };
    const nonRetryableAttempts = new Map<string, number>();
    const triedModels = new Set<string>();

    const flush = (buffer: AssistantMessageEvent[]) => {
      for (const event of buffer) output.push(event);
      committed = true;
    };

    const pushAbort = (message: string) => {
      if (!committed) {
        output.push({ type: "start", partial: freshMessage(attempt.model) });
        committed = true;
      }
      const error = freshMessage(attempt.model);
      error.stopReason = "aborted";
      error.errorMessage = message;
      output.push({ type: "error", reason: "aborted", error });
      output.end();
    };

    while (true) {
      state.activeProviderRequests++;
      if (allowFallback) state.activeFallbackProviderRequests++;
      installFetchRateLimitObserver();
      const buffer: AssistantMessageEvent[] = [];
      let retryable: RetryableError | undefined;
      let retryableErrorMessage = "";
      let nonRetryableError: { message: string; event?: AssistantMessageEvent } | undefined;

      try {
        try {
          const attemptOptions = allowFallback
            ? await optionsForModel(model, attempt, options, requestCtx)
            : options;
          const attemptDelegate = attempt.model.api === model.api
            ? delegate
            : state.builtinStreamSimpleByApi.get(attempt.model.api)
              ?? getApiProviders().find((provider) => provider.api === attempt.model.api)?.streamSimple;
          if (!attemptDelegate) throw new Error(`No stream handler registered for API ${attempt.model.api}.`);
          const attemptContext = anthropicSubscriptionContext(attempt.model, context, attemptOptions, requestCtx);
          const inner = await attemptDelegate(attempt.model, attemptContext, attemptOptions);
          for await (const event of inner) {
            if (!committed) {
              if (event.type === "error") {
                const rawErrMsg = event.error.errorMessage ?? "";
                const errMsg = errorMessageWithRecentHttpStatus(rawErrMsg);

                if (isAbortErrorEvent(event, options?.signal)) {
                  if (buffer.length > 0) {
                    flush(buffer);
                  } else {
                    output.push({ type: "start", partial: freshMessage(attempt.model) });
                    committed = true;
                  }
                  const error = freshMessage(attempt.model);
                  error.stopReason = "aborted";
                  error.errorMessage = errMsg || "Operation aborted";
                  output.push({ type: "error", reason: "aborted", error });
                  output.end();
                  return;
                }

                retryable = getRetryableError(errMsg);
                if (retryable) {
                  retryableErrorMessage = errMsg;
                  break;
                }
                const observedRateLimit = allowFallback ? recentObservedRateLimitError() : undefined;
                retryable = observedRateLimit ? getRetryableError(observedRateLimit) : undefined;
                if (retryable && observedRateLimit) {
                  retryableErrorMessage = observedRateLimit;
                  break;
                }

                nonRetryableError = { message: errMsg, event };
                break;
              }

              if (event.type === "start") {
                buffer.push(event);
                continue;
              }

              if (allowFallback) await switchPiModel(attempt);
              if (buffer.length > 0) {
                flush(buffer);
              } else {
                output.push({ type: "start", partial: freshMessage(attempt.model) });
                committed = true;
              }
              output.push(event);
              if (event.type === "done") {
                output.end();
                return;
              }
              continue;
            }

            output.push(event);
            if (event.type === "done" || event.type === "error") {
              output.end();
              return;
            }
          }
        } catch (err) {
          const errMsg = errorMessageWithRecentHttpStatus(errorMessageWithCauses(err));
          const aborted = Boolean(options?.signal?.aborted) || isAbortMessage(errMsg);
          retryable = !aborted ? getRetryableError(errMsg) : undefined;
          if (retryable) retryableErrorMessage = errMsg;
          if (!retryable && allowFallback) {
            const observedRateLimit = recentObservedRateLimitError();
            retryable = observedRateLimit ? getRetryableError(observedRateLimit) : undefined;
            if (retryable && observedRateLimit) retryableErrorMessage = observedRateLimit;
          }
          if (!retryable) {
            if (aborted) {
              pushAbort(errMsg);
              return;
            }
            nonRetryableError = { message: errMsg };
          }
        }
      } finally {
        state.activeProviderRequests--;
        if (allowFallback) state.activeFallbackProviderRequests--;
        if (state.activeProviderRequests === 0) {
          clearAmbientRetryStatus();
          state.restoreFetch?.();
        }
      }

      if (!retryable) {
        const failureEvent = nonRetryableError?.event;
        const failureMessage = nonRetryableError?.message ?? "Provider stream ended without a terminal event.";

        const emitFailure = () => {
          if (!committed) {
            if (buffer.length > 0) {
              flush(buffer);
            } else {
              output.push({ type: "start", partial: freshMessage(attempt.model) });
              committed = true;
            }
          }
          if (failureEvent) {
            output.push(failureEvent);
          } else {
            const error = freshMessage(attempt.model);
            error.stopReason = "error";
            error.errorMessage = failureMessage;
            output.push({ type: "error", reason: "error", error });
          }
          output.end();
        };

        if (!committed) {
          const key = modelKey(attempt.model);
          const attempts = (nonRetryableAttempts.get(key) ?? 0) + 1;
          nonRetryableAttempts.set(key, attempts);

          if (attempts < state.nonRetryableMaxAttempts) {
            notifyRetryingAfterError(attempt.model, state.nonRetryableRetryDelayMs, failureMessage);
            const waitResult = await waitForRetry("retry", state.nonRetryableRetryDelayMs, options?.signal);
            if (waitResult === "aborted") {
              pushAbort("Request aborted while retrying after error.");
              return;
            }
            continue;
          }

          triedModels.add(key);

          if (allowFallback) {
            if (freezingEnabled()) {
              rememberNonRetryableFailure(attempt.model, failureMessage);
              const next = nextAvailableCandidate(attempt.model);
              if (next) {
                attempt = next;
                continue;
              }

              const deadline = earliestCandidateDeadline(attempt.model);
              if (deadline) {
                const waitResult = await waitForRetry("model-frozen", Math.max(0, deadline - Date.now()), options?.signal);
                if (waitResult !== "aborted") {
                  attempt = nextAvailableCandidate(attempt.model) ?? { model: getPrimaryModel(attempt.model), reasoningEffort: state.primaryThinkingLevel };
                  continue;
                }
              }
            } else {
              const next = candidateOrder(attempt.model).find((entry) => !triedModels.has(modelKey(entry.model)));
              if (next) {
                attempt = next;
                continue;
              }
            }
          }
        }

        emitFailure();
        return;
      }

      if (allowFallback) {
        if (retryable.reason === "network") {
          notifyRetryableError(attempt.model, retryable, retryableErrorMessage);
          const waitResult = await waitForRetry(retryable.reason, retryable.waitMs, options?.signal);
          if (waitResult === "aborted") {
            pushAbort(`Request aborted during ${reasonLabel(retryable.reason).toLowerCase()} wait.`);
            return;
          }
          continue;
        }

        rememberRateLimit(attempt.model, retryable, retryableErrorMessage);
        const next = nextAvailableCandidate(attempt.model);
        if (next) {
          attempt = next;
          continue;
        }

        const deadline = earliestCandidateDeadline(attempt.model);
        const waitMs = deadline ? Math.max(0, deadline - Date.now()) : retryable.waitMs;
        const waitResult = await waitForRetry(retryable.reason, waitMs, options?.signal);
        if (waitResult === "aborted") {
          pushAbort(`Request aborted during ${reasonLabel(retryable.reason).toLowerCase()} wait.`);
          return;
        }
        attempt = nextAvailableCandidate(attempt.model) ?? { model: getPrimaryModel(attempt.model), reasoningEffort: state.primaryThinkingLevel };
        continue;
      }

      notifyRetryableError(attempt.model, retryable, retryableErrorMessage);
      const waitResult = await waitForRetry(retryable.reason, retryable.waitMs, options?.signal);
      if (waitResult === "aborted") {
        pushAbort(`Request aborted during ${reasonLabel(retryable.reason).toLowerCase()} wait.`);
        return;
      }
    }
  })();

  return output;
}

export const streamWithRateLimitRetry = streamWithLimitsRetry;

const LIMITS_WAIT_WRAPPER_FLAG = "__piLimitsWaitWrapper";
type LimitsWaitStreamSimpleFn = ((
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream) & { [LIMITS_WAIT_WRAPPER_FLAG]?: true };

export function registerWrappedApi(pi: ExtensionAPI, api: Api): void {
  const currentStreamSimple = getApiProviders().find((provider) => provider.api === api)?.streamSimple;
  if (!currentStreamSimple) return;
  if ((currentStreamSimple as LimitsWaitStreamSimpleFn)[LIMITS_WAIT_WRAPPER_FLAG]) return;

  state.builtinStreamSimpleByApi.set(api, currentStreamSimple);
  state.wrappedApis.add(api);

  const wrappedStreamSimple = ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
    streamWithLimitsRetry(currentStreamSimple, model, context, options)) as LimitsWaitStreamSimpleFn;
  wrappedStreamSimple[LIMITS_WAIT_WRAPPER_FLAG] = true;

  pi.registerProvider(`limits-wait-${api}`, {
    api,
    streamSimple: wrappedStreamSimple,
  });

  // pi-ai wraps provider functions when registering them, so the function later
  // returned by getApiProviders() is not the same object as wrappedStreamSimple.
  // Tag the registered wrapper too; otherwise repeated agent_start/model loops
  // would wrap an already wrapped API again.
  const registeredStreamSimple = getApiProviders().find((provider) => provider.api === api)?.streamSimple as LimitsWaitStreamSimpleFn | undefined;
  if (registeredStreamSimple) registeredStreamSimple[LIMITS_WAIT_WRAPPER_FLAG] = true;
}
