import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ModelsSimpleStreamOptions,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai";

export type RetryReason = "rate-limit" | "overloaded" | "authentication" | "model-frozen" | "network" | "retry" | "weekly-budget";

export type RetryableError = {
  reason: RetryReason;
  waitMs: number;
};

export type ConfiguredModel = {
  provider: string;
  modelname: string;
  reasoningEffort?: ModelThinkingLevel;
  weeklyLimitReserve?: number;
  releaseReserveBeforeResetMs?: number;
};

export type FallbackModel = {
  model: Model<Api>;
  reasoningEffort?: ModelThinkingLevel;
  /** Percentage of the weekly limit to keep unused; reaching it blocks the model. */
  weeklyLimitReserve?: number;
  /** The reserve no longer applies this close to the weekly reset. */
  releaseReserveBeforeResetMs?: number;
};

export type WeeklyUsage = {
  usedPercent: number;
  /** Epoch ms of the weekly window reset, when the provider reports it. */
  resetAt?: number;
};

export type RateLimitMemory = {
  reason: RetryReason;
  limitedAt: number;
  deadline: number;
  /** Provider supplied retry/reset timing; never probe before this deadline. */
  explicitDeadline?: boolean;
  /** Last time this model was re-probed while still remembered as limited. */
  lastProbeAt?: number;
  /** Human explanation shown when every candidate is unavailable. */
  detail?: string;
  /** Weekly usage that caused a "weekly-budget" block, for re-evaluation on settings changes. */
  weeklyUsage?: WeeklyUsage;
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
