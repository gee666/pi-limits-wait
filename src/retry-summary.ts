import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const LIMITS_WAIT_ENTRY_TYPE = "limits-wait";

export type LimitsWaitSessionEntryData = {
  totalWaitingTime: number;
  reasons: string[];
  retries_total: number;
};

export interface RetryPeriodTracker {
  readonly periodId: string;
  readonly events: EventBus;
  beginRetry(errorMessage: string): void;
  completeRetry(): void;
  recordImmediateRetry(errorMessage: string): void;
  recordReason(errorMessage: string): void;
  recordWait(actualWaitMs: number): void;
  finalize(): void;
}

type PendingSummary = {
  id: string;
  data: LimitsWaitSessionEntryData;
};

let nextPeriodId = 0;

function createPeriodId(): string {
  nextPeriodId = (nextPeriodId + 1) % Number.MAX_SAFE_INTEGER;
  return `period-${Date.now().toString(36)}-${nextPeriodId.toString(36)}`;
}

export function normalizeRetryReason(errorMessage: string): string {
  return errorMessage.replace(/\s+/g, " ").trim() || "unknown error";
}

export class RetrySummaryCoordinator {
  private readonly active = new Set<PeriodTracker>();
  private readonly pending: PendingSummary[] = [];
  private readonly flushed = new Set<string>();

  constructor(private readonly pi: Pick<ExtensionAPI, "appendEntry" | "events">) {}

  createStream(): RetryPeriodTracker {
    const tracker = new PeriodTracker(this, createPeriodId(), this.pi.events);
    this.active.add(tracker);
    return tracker;
  }

  finish(tracker: PeriodTracker): void {
    if (!this.active.delete(tracker)) return;
    const data = tracker.summary();
    if (data) this.pending.push({ id: tracker.periodId, data });
  }

  flush(): void {
    for (const summary of this.pending.splice(0)) {
      if (this.flushed.has(summary.id)) continue;
      // At-most-once even if an unusual appendEntry implementation throws after
      // persisting. Lifecycle fallback hooks must never create duplicates.
      this.flushed.add(summary.id);
      try {
        this.pi.appendEntry<LimitsWaitSessionEntryData>(LIMITS_WAIT_ENTRY_TYPE, summary.data);
      } catch {
        // Session teardown/replacement can make the old API unavailable.
      }
    }
  }

  finalizeAndFlush(): void {
    for (const tracker of [...this.active]) tracker.finalize();
    this.flush();
  }
}

class PeriodTracker implements RetryPeriodTracker {
  readonly reasons: string[] = [];
  readonly reasonSet = new Set<string>();
  retries = 0;
  actualWaitMs = 0;
  started = false;
  finalized = false;

  constructor(
    private readonly coordinator: RetrySummaryCoordinator,
    readonly periodId: string,
    readonly events: EventBus,
  ) {}

  beginRetry(errorMessage: string): void {
    if (this.finalized) return;
    this.started = true;
    this.recordReason(errorMessage);
  }

  completeRetry(): void {
    if (!this.finalized && this.started) this.retries++;
  }

  recordImmediateRetry(errorMessage: string): void {
    this.beginRetry(errorMessage);
    this.completeRetry();
  }

  recordReason(errorMessage: string): void {
    if (this.finalized) return;
    const reason = normalizeRetryReason(errorMessage);
    if (!this.reasonSet.has(reason)) {
      this.reasonSet.add(reason);
      this.reasons.push(reason);
    }
  }

  recordWait(actualWaitMs: number): void {
    if (!this.finalized) this.actualWaitMs += Math.max(0, actualWaitMs);
  }

  summary(): LimitsWaitSessionEntryData | undefined {
    if (!this.started) return undefined;
    return {
      totalWaitingTime: this.actualWaitMs / 1_000,
      reasons: [...this.reasons],
      retries_total: this.retries,
    };
  }

  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.coordinator.finish(this);
  }
}

export function __createRetrySummaryCoordinatorForTests(
  pi: Pick<ExtensionAPI, "appendEntry" | "events">,
): RetrySummaryCoordinator {
  return new RetrySummaryCoordinator(pi);
}
