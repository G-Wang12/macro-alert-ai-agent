/**
 * Per-space outbound ordering: user replies and preference confirmations run
 * before proactive alerts when both arrive around the same time.
 */
export type OutboundKind = "user" | "alert";

export class SpaceOutboundCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly alertHoldCount = new Map<string, number>();
  private readonly alertHoldWaiters = new Map<string, Array<() => void>>();

  /** Block proactive alerts for this space until the returned function is called. */
  holdAlerts(spaceId: string): () => void {
    const next = (this.alertHoldCount.get(spaceId) ?? 0) + 1;
    this.alertHoldCount.set(spaceId, next);
    return () => {
      const count = (this.alertHoldCount.get(spaceId) ?? 1) - 1;
      if (count <= 0) {
        this.alertHoldCount.delete(spaceId);
        const waiters = this.alertHoldWaiters.get(spaceId) ?? [];
        this.alertHoldWaiters.delete(spaceId);
        for (const wake of waiters) wake();
      } else {
        this.alertHoldCount.set(spaceId, count);
      }
    };
  }

  private alertsHeld(spaceId: string): boolean {
    return (this.alertHoldCount.get(spaceId) ?? 0) > 0;
  }

  private waitForAlertHoldRelease(spaceId: string): Promise<void> {
    if (!this.alertsHeld(spaceId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.alertHoldWaiters.get(spaceId) ?? [];
      waiters.push(resolve);
      this.alertHoldWaiters.set(spaceId, waiters);
    });
  }

  /**
   * Run outbound work for a space in FIFO order. Alert tasks wait until no
   * alert hold is active (typically while an inbound user message is handled).
   */
  run<T>(spaceId: string, kind: OutboundKind, fn: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      if (kind === "alert") {
        while (this.alertsHeld(spaceId)) {
          await this.waitForAlertHoldRelease(spaceId);
        }
      }
      return fn();
    };

    const prev = this.tails.get(spaceId) ?? Promise.resolve();
    const chained = prev.then(execute, execute);
    this.tails.set(
      spaceId,
      chained.then(
        () => undefined,
        () => undefined,
      ),
    );
    return chained;
  }
}
