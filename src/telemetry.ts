import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { RetryReason } from "./types.js";

/** Public, versioned pi.events channel for limits-wait wait telemetry. */
export const LIMITS_WAIT_EVENT_CHANNEL = "oira666.pi-limits-wait.wait.v1";

export type LimitsWaitModel = {
  provider: string;
  id: string;
};

export type LimitsWaitWaitOutcome = "waited" | "skipped" | "aborted";

export type LimitsWaitWaitStartPayload = {
  version: 1;
  phase: "start";
  waitId: string;
  periodId?: string;
  reason: RetryReason;
  plannedDurationMs: number;
  plannedDeadline: number;
  startedAt: number;
  model?: LimitsWaitModel;
  error?: string;
};

export type LimitsWaitWaitEndPayload = {
  version: 1;
  phase: "end";
  waitId: string;
  periodId?: string;
  reason: RetryReason;
  plannedDurationMs: number;
  plannedDeadline: number;
  startedAt: number;
  endedAt: number;
  actualElapsedMs: number;
  outcome: LimitsWaitWaitOutcome;
  model?: LimitsWaitModel;
  error?: string;
};

export type LimitsWaitWaitEventPayload = LimitsWaitWaitStartPayload | LimitsWaitWaitEndPayload;

// Concise public aliases; the longer names remain descriptive and compatible.
export type LimitsWaitStartEventPayload = LimitsWaitWaitStartPayload;
export type LimitsWaitEndEventPayload = LimitsWaitWaitEndPayload;
export type LimitsWaitEventPayload = LimitsWaitWaitEventPayload;
export type LimitsWaitOutcome = LimitsWaitWaitOutcome;

export type WaitTelemetryOptions = {
  periodId?: string;
  model?: Pick<Model<Api>, "provider" | "id">;
  error?: string;
  events?: EventBus;
  /** Extension-created attempt counters, when the call site tracks them. */
  attempt?: number;
  maxAttempts?: number;
  onEnd?: (actualElapsedMs: number, outcome: LimitsWaitWaitOutcome) => void;
};

let nextWaitId = 0;

export function createWaitId(): string {
  nextWaitId = (nextWaitId + 1) % Number.MAX_SAFE_INTEGER;
  return `wait-${Date.now().toString(36)}-${nextWaitId.toString(36)}`;
}

export function waitModel(model: WaitTelemetryOptions["model"]): LimitsWaitModel | undefined {
  return model ? { provider: model.provider, id: model.id } : undefined;
}

/** Event listeners are observational and must never alter retry control flow. */
export function emitWaitTelemetry(events: EventBus | undefined, payload: LimitsWaitWaitEventPayload): void {
  try {
    events?.emit(LIMITS_WAIT_EVENT_CHANNEL, payload);
  } catch {
    // Custom/test event buses may throw even though Pi's standard bus isolates listeners.
  }
}
