import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";

export type RetryReason = "rate-limit" | "overloaded" | "authentication" | "model-frozen";

export type RetryableError = {
  reason: RetryReason;
  waitMs: number;
};

export type ConfiguredModel = {
  provider: string;
  modelname: string;
  reasoningEffort?: ThinkingLevel;
};

export type FallbackModel = {
  model: Model<Api>;
  reasoningEffort?: ThinkingLevel;
};

export type RateLimitMemory = {
  reason: RetryReason;
  limitedAt: number;
  deadline: number;
};

export type NonRetryableFailureMemory = {
  failedAt: number;
  deadline: number;
  errorMessage: string;
};

export type StreamSimpleFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export type TestExtensionContext = ExtensionContext | undefined;
