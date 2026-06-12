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
  earliestCandidateDeadline,
  fallbackEnabled,
  formatModel,
  getPrimaryModel,
  initialAttempt,
  isFallbackEligibleModel,
  modelKey,
  nextAvailableCandidate,
  optionsForModel,
  recentObservedRateLimitError,
  rememberNonRetryableFailure,
  rememberRateLimit,
  switchPiModel,
} from "./models.js";
import { errorMessageWithCauses, getRetryableError, isAbortMessage } from "./retry-errors.js";
import { state } from "./state.js";
import type { FallbackModel, StreamSimpleFn } from "./types.js";
import { clearAmbientRetryStatus, reasonLabel, waitForRetry } from "./ui.js";

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
  state.lastObservedRateLimitError = undefined;
  state.ambientStatusCleanup?.();
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

/**
 * Wrap a streamSimple with an indefinite retry loop for rate limits and
 * server_is_overloaded errors.
 *
 * Provider events are forwarded unchanged once an attempt is known to be
 * non-retryable. Potential retryable attempts are buffered and discarded, so Pi
 * never sees failed partial output.
 */
export function streamWithLimitsRetry(
  delegate: StreamSimpleFn,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();

  void (async () => {
    let committed = false;
    const allowFallback = fallbackEnabled() && isFallbackEligibleModel(model);
    let attempt: FallbackModel = allowFallback ? initialAttempt(model) : { model, reasoningEffort: state.primaryThinkingLevel };

    const flush = (buffer: AssistantMessageEvent[]) => {
      for (const event of buffer) output.push(event);
      committed = true;
    };

    while (true) {
      state.activeProviderRequests++;
      if (allowFallback) state.activeFallbackProviderRequests++;
      installFetchRateLimitObserver();
      const buffer: AssistantMessageEvent[] = [];
      let retryable: ReturnType<typeof getRetryableError>;
      let retryableErrorMessage = "";
      let nonRetryableError: { message: string; event?: AssistantMessageEvent } | undefined;

      try {
        try {
          const attemptOptions = allowFallback
            ? await optionsForModel(model, attempt, options)
            : options;
          const attemptDelegate = attempt.model.api === model.api
            ? delegate
            : state.builtinStreamSimpleByApi.get(attempt.model.api)
              ?? getApiProviders().find((provider) => provider.api === attempt.model.api)?.streamSimple;
          if (!attemptDelegate) throw new Error(`No stream handler registered for API ${attempt.model.api}.`);
          const inner = await attemptDelegate(attempt.model, context, attemptOptions);
          for await (const event of inner) {
            if (!committed) {
              if (event.type === "error") {
                const errMsg = event.error.errorMessage ?? "";

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

                if (allowFallback) {
                  nonRetryableError = { message: errMsg, event };
                  break;
                }

                if (buffer.length > 0) {
                  flush(buffer);
                } else {
                  output.push({ type: "start", partial: freshMessage(attempt.model) });
                  committed = true;
                }
                output.push(event);
                output.end();
                return;
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
          const errMsg = errorMessageWithCauses(err);
          const aborted = Boolean(options?.signal?.aborted) || isAbortMessage(errMsg);
          retryable = !aborted ? getRetryableError(errMsg) : undefined;
          if (retryable) retryableErrorMessage = errMsg;
          if (!retryable && allowFallback) {
            const observedRateLimit = recentObservedRateLimitError();
            retryable = observedRateLimit ? getRetryableError(observedRateLimit) : undefined;
            if (retryable && observedRateLimit) retryableErrorMessage = observedRateLimit;
          }
          if (!retryable) {
            if (allowFallback && !aborted) {
              nonRetryableError = { message: errMsg };
            } else {
              if (!committed) {
                output.push({ type: "start", partial: freshMessage(attempt.model) });
                committed = true;
              }
              const error = freshMessage(attempt.model);
              error.stopReason = aborted ? "aborted" : "error";
              error.errorMessage = errMsg;
              output.push({
                type: "error",
                reason: error.stopReason as "error" | "aborted",
                error,
              });
              output.end();
              return;
            }
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

      if (nonRetryableError) {
        if (allowFallback && !committed) {
          rememberNonRetryableFailure(attempt.model, nonRetryableError.message);
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
        }

        if (!committed) {
          if (buffer.length > 0) {
            flush(buffer);
          } else {
            output.push({ type: "start", partial: freshMessage(attempt.model) });
            committed = true;
          }
        }
        if (nonRetryableError.event) {
          output.push(nonRetryableError.event);
        } else {
          const error = freshMessage(attempt.model);
          error.stopReason = "error";
          error.errorMessage = nonRetryableError.message;
          output.push({ type: "error", reason: "error", error });
        }
        output.end();
        return;
      }

      if (!retryable) {
        if (allowFallback && !committed) {
          const message = "Provider stream ended without a terminal event.";
          rememberNonRetryableFailure(attempt.model, message);
          const next = nextAvailableCandidate(attempt.model);
          if (next) {
            attempt = next;
            continue;
          }
        }
        if (!committed) {
          if (buffer.length > 0) {
            flush(buffer);
          } else {
            output.push({ type: "start", partial: freshMessage(attempt.model) });
            committed = true;
          }
        }
        const error = freshMessage(attempt.model);
        error.stopReason = "error";
        error.errorMessage = "Provider stream ended without a terminal event.";
        output.push({ type: "error", reason: "error", error });
        output.end();
        return;
      }

      if (allowFallback) {
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
          if (!committed) {
            output.push({ type: "start", partial: freshMessage(attempt.model) });
            committed = true;
          }
          const error = freshMessage(attempt.model);
          error.stopReason = "aborted";
          error.errorMessage = `Request aborted during ${reasonLabel(retryable.reason).toLowerCase()} wait.`;
          output.push({ type: "error", reason: "aborted", error });
          output.end();
          return;
        }
        attempt = nextAvailableCandidate(attempt.model) ?? { model: getPrimaryModel(attempt.model), reasoningEffort: state.primaryThinkingLevel };
        continue;
      }

      const waitResult = await waitForRetry(retryable.reason, retryable.waitMs, options?.signal);
      if (waitResult === "aborted") {
        if (!committed) {
          output.push({ type: "start", partial: freshMessage(attempt.model) });
          committed = true;
        }
        const error = freshMessage(attempt.model);
        error.stopReason = "aborted";
        error.errorMessage = `Request aborted during ${reasonLabel(retryable.reason).toLowerCase()} wait.`;
        output.push({ type: "error", reason: "aborted", error });
        output.end();
        return;
      }
    }
  })();

  return output;
}

export const streamWithRateLimitRetry = streamWithLimitsRetry;

export function registerWrappedApi(pi: ExtensionAPI, api: Api): void {
  if (state.wrappedApis.has(api)) return;

  const builtinStreamSimple = getApiProviders().find((provider) => provider.api === api)?.streamSimple;
  if (!builtinStreamSimple) return;

  state.builtinStreamSimpleByApi.set(api, builtinStreamSimple);
  state.wrappedApis.add(api);
  pi.registerProvider(`limits-wait-${api}`, {
    api,
    streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
      streamWithLimitsRetry(builtinStreamSimple, model, context, options),
  });
}
