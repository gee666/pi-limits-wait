import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ModelsSimpleStreamOptions,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai";

export type RetryReason = "rate-limit" | "overloaded" | "authentication" | "model-frozen" | "network" | "retry";

export type RetryableError = {
  reason: RetryReason;
  waitMs: number;
};

export type ConfiguredModel = {
  provider: string;
  modelname: string;
  reasoningEffort?: ModelThinkingLevel;
};

export type FallbackModel = {
  model: Model<Api>;
  reasoningEffort?: ModelThinkingLevel;
};

export type RateLimitMemory = {
  reason: RetryReason;
  limitedAt: number;
  deadline: number;
  /** Last time this model was re-probed while still remembered as limited. */
  lastProbeAt?: number;
};

export type NonRetryableFailureMemory = {
  failedAt: number;
  deadline: number;
  errorMessage: string;
  /** Last time this model was re-probed while still remembered as frozen. */
  lastProbeAt?: number;
};

export type RuntimeStreamSimpleFn = (
  this: ModelRuntime,
  model: Model<Api>,
  context: Context,
  options?: ModelsSimpleStreamOptions,
) => AssistantMessageEventStream;

export type TestExtensionContext = ExtensionContext | undefined;
