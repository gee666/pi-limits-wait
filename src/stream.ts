import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
  type ProviderResponse,
} from "@earendil-works/pi-ai";
import {
  candidateOrder,
  configuredAttempt,
  earliestCandidateDeadline,
  fallbackEnabled,
  getPrimaryModel,
  initialAttempt,
  isFallbackEligibleModel,
  modelKey,
  nextAvailableCandidate,
  notifyRetryableError,
  notifyRetryingAfterError,
  rememberNonRetryableFailure,
  rememberRateLimit,
  switchPiModel,
} from "./models.js";
import { withAttemptResponseObserver } from "./response-observer.js";
import { errorMessageWithCauses, getRetryableError, isAbortMessage, parseRetryDelayMs, retryAfterHeaderMs } from "./retry-errors.js";
import { state } from "./state.js";
import type { FallbackModel, RetryableError, RuntimeStreamSimpleFn } from "./types.js";
import { clearModelStatus, freezingEnabled, reasonLabel, waitForRetry } from "./ui.js";

export function __setNonRetryableTuningForTests(maxAttempts: number, retryDelayMs: number): void {
  state.nonRetryableMaxAttempts = maxAttempts;
  state.nonRetryableRetryDelayMs = retryDelayMs;
}

export function __configureFallbackModelsForTests(models: FallbackModel[], ctx?: ExtensionContext): void {
  state.fallbackModels = models;
  state.sharedCtx = ctx;
  state.primaryModel = undefined;
  state.primaryThinkingLevel = undefined;
  state.rateLimitMemory.clear();
  state.nonRetryableFailureMemory.clear();
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
  return event.reason === "aborted"
    || event.error.stopReason === "aborted"
    || isAbortMessage(event.error.errorMessage ?? "");
}

function responseErrorMessage(response: ProviderResponse): string {
  const headers = new Headers(response.headers);
  const waitMs = retryAfterHeaderMs(headers);
  return `HTTP ${response.status}${waitMs !== undefined ? ` retry-after-ms ${waitMs}` : ""}`;
}

function responseFingerprint(response: ProviderResponse): string {
  const headers = Object.entries(response.headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([response.status, headers]);
}

function enrichError(errorMessage: string, observed: string | undefined): string {
  if (!observed || errorMessage.includes(observed)) return errorMessage;
  const currentHasTiming = parseRetryDelayMs(errorMessage) !== undefined;
  const observedHasTiming = parseRetryDelayMs(observed) !== undefined;
  if (!currentHasTiming && observedHasTiming) return `${observed}; Error: ${errorMessage}`;
  if (/(?:^|\D)[1-5]\d\d(?:\D|$)/.test(errorMessage)) return errorMessage;
  return `${observed}; Error: ${errorMessage}`;
}

function errorHttpMetadata(error: unknown): string | undefined {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { status?: unknown; headers?: unknown; cause?: unknown };
    if (typeof record.status === "number") {
      let headers: Headers | undefined;
      try {
        if (record.headers instanceof Headers) headers = record.headers;
        else if (record.headers && typeof record.headers === "object") {
          headers = new Headers(record.headers as Record<string, string>);
        }
      } catch { /* malformed SDK headers */ }
      const waitMs = headers ? retryAfterHeaderMs(headers) : undefined;
      return `HTTP ${record.status}${waitMs !== undefined ? ` retry-after-ms ${waitMs}` : ""}`;
    }
    current = record.cause;
  }
  return undefined;
}

function attemptOptions(
  originalModel: Model<Api>,
  target: FallbackModel,
  options: ModelsSimpleStreamOptions | undefined,
  signal: AbortSignal | undefined,
  onPayload: ModelsSimpleStreamOptions["onPayload"],
  onResponse: ModelsSimpleStreamOptions["onResponse"],
): ModelsSimpleStreamOptions | undefined {
  const reasoningLevel = target.reasoningEffort ?? state.primaryThinkingLevel;
  const reasoning = reasoningLevel && reasoningLevel !== "off" ? reasoningLevel : undefined;
  const common = { ...(signal ? { signal } : {}), onPayload, onResponse };

  // Exact-model retries preserve every option. Any different model, including
  // one on the same provider, must resolve its own request-owned configuration.
  if (modelKey(originalModel) === modelKey(target.model)) {
    const exact = { ...options, ...common };
    if (reasoningLevel === "off") delete exact.reasoning;
    else if (reasoning) exact.reasoning = reasoning;
    return exact;
  }

  // Whitelist transport-neutral controls so credentials, headers, env,
  // provider-specific fields and the original model's transformHeaders closure
  // cannot leak to a fallback model.
  const neutral: ModelsSimpleStreamOptions = {
    signal,
    onPayload,
    onResponse,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    timeoutMs: options?.timeoutMs,
    websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
    maxRetries: options?.maxRetries,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
    temperature: options?.temperature,
    maxTokens: options?.maxTokens,
    thinkingBudgets: options?.thinkingBudgets,
    transport: options?.transport,
    reasoning,
  };
  return Object.fromEntries(Object.entries(neutral).filter(([, value]) => value !== undefined)) as ModelsSimpleStreamOptions;
}

export function streamWithLimitsRetry(
  runtime: ModelRuntime,
  delegate: RuntimeStreamSimpleFn,
  model: Model<Api>,
  context: Context,
  options?: ModelsSimpleStreamOptions,
  ownerSignal?: AbortSignal,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const signal = options?.signal && ownerSignal
    ? AbortSignal.any([options.signal, ownerSignal])
    : options?.signal ?? ownerSignal;

  void (async () => {
    let committed = false;
    let finished = false;
    const allowFallback = fallbackEnabled() && isFallbackEligibleModel(model);
    let attempt: FallbackModel = allowFallback
      ? initialAttempt(model)
      : { model, reasoningEffort: state.primaryThinkingLevel };
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
      finished = true;
      output.end();
    };

    while (true) {
      if (signal?.aborted) {
        pushAbort("Operation aborted before provider attempt.");
        return;
      }

      const buffer: AssistantMessageEvent[] = [];
      let retryable: RetryableError | undefined;
      let retryableErrorMessage = "";
      let nonRetryableError: { message: string; event?: AssistantMessageEvent } | undefined;
      let observedHttpError: string | undefined;
      let providerPayloadReady = false;
      let providerRequestUrl: string | undefined;
      let nextObservedResponseId = 0;
      const observedProviderResponses: Array<{
        id: number;
        requestUrl?: string;
        fingerprint: string;
        response: ProviderResponse;
      }> = [];
      const priorOnPayload = options?.onPayload;
      const priorOnResponse = options?.onResponse;
      const onPayload: ModelsSimpleStreamOptions["onPayload"] = async (payload, payloadModel) => {
        if (signal?.aborted) return undefined;
        const nextPayload = await priorOnPayload?.(payload, payloadModel);
        // Arm observation only after extension payload hooks finish, so nested
        // fetches inside those hooks cannot become the provider request.
        providerPayloadReady = true;
        return nextPayload;
      };
      const deliverObservedResponses = async (count = observedProviderResponses.length) => {
        const pending = observedProviderResponses.splice(0, count);
        for (const entry of pending) {
          if (signal?.aborted) return;
          await priorOnResponse?.(entry.response, attempt.model);
        }
      };
      const onResponse: ModelsSimpleStreamOptions["onResponse"] = async (response, responseModel) => {
        if (signal?.aborted) {
          observedProviderResponses.length = 0;
          return;
        }

        // Fetch observation precedes the adapter callback. Match the earliest
        // queued response with the same fingerprint: when repeated responses
        // share a status and headers, choosing the latest would duplicate the
        // first response and drop a later one.
        const fingerprint = responseFingerprint(response);
        const canonicalObservedIndex = observedProviderResponses.findIndex(
          (entry) => entry.fingerprint === fingerprint,
        );
        if (canonicalObservedIndex >= 0) {
          await deliverObservedResponses(canonicalObservedIndex);
          const canonicalObserved = observedProviderResponses.shift();
          if (canonicalObserved?.fingerprint !== fingerprint) {
            throw new Error("Provider response identity/order changed unexpectedly.");
          }
        } else {
          // The observer may be unavailable when another fetch owner supersedes
          // it. Preserve the adapter's canonical callback in that case.
          await deliverObservedResponses();
        }

        if (response.status >= 400) {
          observedHttpError = responseErrorMessage(response);
        } else {
          // A later canonical success supersedes hidden retry failures; never
          // use stale status metadata to classify a stream/parsing error.
          observedHttpError = undefined;
        }
        if (signal?.aborted) return;
        await priorOnResponse?.(response, responseModel);
        if (signal?.aborted) return;
        // Throw only after the canonical callback, so after_provider_response
        // still sees the response and 429 fallback can start immediately.
        if (response.status === 429) throw new Error(observedHttpError);
      };

      try {
        await withAttemptResponseObserver((response, requestUrl) => {
          if (!providerPayloadReady) return;
          const effectiveUrl = requestUrl ?? (response.url || undefined);
          if (providerRequestUrl === undefined) providerRequestUrl = effectiveUrl;
          else if (effectiveUrl !== undefined && effectiveUrl !== providerRequestUrl) return;

          const observed = {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
          };
          observedProviderResponses.push({
            id: nextObservedResponseId++,
            requestUrl: effectiveUrl,
            fingerprint: responseFingerprint(observed),
            response: observed,
          });
          if (!response.ok) observedHttpError = responseErrorMessage(observed);
        }, async () => {
          const currentOptions = attemptOptions(model, attempt, options, signal, onPayload, onResponse);
          const inner = delegate.call(runtime, attempt.model, context, currentOptions);
          for await (const event of inner) {
            if (signal?.aborted) {
              pushAbort("Request aborted before processing provider output.");
              return;
            }

            if (!committed) {
              if (event.type === "error") {
                const errMsg = enrichError(event.error.errorMessage ?? "", observedHttpError);
                if (isAbortErrorEvent(event, signal)) {
                  if (buffer.length > 0) flush(buffer);
                  pushAbort(errMsg || "Operation aborted");
                  return;
                }
                retryable = getRetryableError(errMsg);
                if (retryable) retryableErrorMessage = errMsg;
                else nonRetryableError = { message: errMsg, event };
                break;
              }

              if (event.type === "start") {
                buffer.push(event);
                continue;
              }

              if (allowFallback) {
                if (signal?.aborted) {
                  pushAbort("Request aborted before switching model.");
                  return;
                }
                await switchPiModel(attempt, signal);
                if (signal?.aborted) {
                  pushAbort("Request aborted while switching model.");
                  return;
                }
              }
              if (buffer.length > 0) flush(buffer);
              else {
                output.push({ type: "start", partial: freshMessage(attempt.model) });
                committed = true;
              }
              output.push(event);
              if (event.type === "done") {
                finished = true;
                output.end();
                return;
              }
              continue;
            }

            output.push(event);
            if (event.type === "done" || event.type === "error") {
              finished = true;
              output.end();
              return;
            }
          }
        });
        await deliverObservedResponses();
        if (finished) return;
      } catch (caught) {
        let err = caught;
        try {
          await deliverObservedResponses();
        } catch (responseError) {
          err = responseError;
        }
        const errMsg = enrichError(errorMessageWithCauses(err), observedHttpError ?? errorHttpMetadata(err));
        const aborted = Boolean(signal?.aborted) || isAbortMessage(errMsg);
        retryable = aborted ? undefined : getRetryableError(errMsg);
        if (retryable) retryableErrorMessage = errMsg;
        else if (aborted) {
          pushAbort(errMsg || "Operation aborted");
          return;
        } else {
          nonRetryableError = { message: errMsg };
        }
      }

      if (signal?.aborted) {
        pushAbort("Request aborted before retry or fallback handling.");
        return;
      }

      if (!retryable) {
        const failureEvent = nonRetryableError?.event;
        const failureMessage = nonRetryableError?.message ?? "Provider stream ended without a terminal event.";
        const emitFailure = () => {
          if (!committed) {
            if (buffer.length > 0) flush(buffer);
            else {
              output.push({ type: "start", partial: freshMessage(attempt.model) });
              committed = true;
            }
          }
          if (failureEvent) output.push(failureEvent);
          else {
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
            if (await waitForRetry("retry", state.nonRetryableRetryDelayMs, signal) === "aborted") {
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
                const wait = await waitForRetry("model-frozen", Math.max(0, deadline - Date.now()), signal);
                if (wait === "aborted") {
                  pushAbort("Request aborted while all fallback models were frozen.");
                  return;
                }
                attempt = nextAvailableCandidate(attempt.model)
                  ?? configuredAttempt(getPrimaryModel(attempt.model));
                continue;
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
          if (await waitForRetry(retryable.reason, retryable.waitMs, signal) === "aborted") {
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
        if (await waitForRetry(retryable.reason, waitMs, signal) === "aborted") {
          pushAbort(`Request aborted during ${reasonLabel(retryable.reason).toLowerCase()} wait.`);
          return;
        }
        attempt = nextAvailableCandidate(attempt.model)
          ?? configuredAttempt(getPrimaryModel(attempt.model));
        continue;
      }

      notifyRetryableError(attempt.model, retryable, retryableErrorMessage);
      if (await waitForRetry(retryable.reason, retryable.waitMs, signal) === "aborted") {
        pushAbort(`Request aborted during ${reasonLabel(retryable.reason).toLowerCase()} wait.`);
        return;
      }
    }
  })().catch((error) => {
    const failure = freshMessage(model);
    failure.stopReason = signal?.aborted ? "aborted" : "error";
    failure.errorMessage = errorMessageWithCauses(error);
    output.push({ type: "start", partial: freshMessage(model) });
    output.push({ type: "error", reason: failure.stopReason, error: failure });
    output.end();
  });

  return output;
}

export const streamWithRateLimitRetry = streamWithLimitsRetry;

// The extension factory is not given its ModelRuntime, so a WeakMap cannot
// transfer/abort ownership at /reload time before another call enters a given
// runtime. Pi has one active session runtime per process; use one process owner
// and abort it eagerly when the next extension instance takes over.
const INTERCEPTION_SYMBOL = Symbol.for("oira666.pi-limits-wait.ModelRuntime.streamSimple.v1");
type InterceptionHandler = (
  runtime: ModelRuntime,
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions | undefined,
  delegate: RuntimeStreamSimpleFn,
) => AssistantMessageEventStream;
interface InterceptionSlot {
  owner?: object;
  abortOwner?: () => void;
  handler?: InterceptionHandler;
  previous: RuntimeStreamSimpleFn;
  wrapper: RuntimeStreamSimpleFn;
}
type InterceptablePrototype = ModelRuntime & { [INTERCEPTION_SYMBOL]?: InterceptionSlot };

/** Install one stable, reload-safe process-wide trampoline. */
export function installModelRuntimeInterception(): () => boolean {
  const prototype = ModelRuntime.prototype as InterceptablePrototype;
  const owner = {};
  const controller = new AbortController();
  let slot = prototype[INTERCEPTION_SYMBOL];

  const handler: InterceptionHandler = (runtime, model, context, options, delegate) =>
    streamWithLimitsRetry(runtime, delegate, model, context, options, controller.signal);

  if (slot && prototype.streamSimple === slot.wrapper) {
    slot.abortOwner?.();
    slot.owner = owner;
    slot.abortOwner = () => controller.abort();
    slot.handler = handler;
  } else {
    if (slot) {
      slot.abortOwner?.();
      slot.owner = undefined;
      slot.abortOwner = undefined;
      slot.handler = undefined;
    }
    const previous = prototype.streamSimple as RuntimeStreamSimpleFn;
    const newSlot = {} as InterceptionSlot;
    newSlot.previous = previous;
    newSlot.wrapper = function (model, context, options) {
      const active = newSlot.handler;
      return active
        ? active(this, model, context, options, newSlot.previous)
        : newSlot.previous.call(this, model, context, options);
    };
    newSlot.owner = owner;
    newSlot.abortOwner = () => controller.abort();
    newSlot.handler = handler;
    slot = newSlot;
    Object.defineProperty(prototype, INTERCEPTION_SYMBOL, {
      configurable: true,
      value: slot,
    });
    prototype.streamSimple = slot.wrapper;
  }

  return () => {
    if (slot?.owner !== owner) return false;
    slot.abortOwner?.();
    slot.owner = undefined;
    slot.abortOwner = undefined;
    slot.handler = undefined;
    return true;
  };
}
