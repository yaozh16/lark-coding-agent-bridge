interface VersionedSnapshot<T> {
  version: number;
  value: T;
}

interface PublishWaiter {
  targetVersion: number;
  resolve(): void;
  reject(reason: unknown): void;
}

export interface LatestSnapshotSchedulerOptions<T> {
  /** Minimum quiet period after one push callback settles before the next starts. */
  minIntervalMs: number;
  /** Re-publish the latest snapshot at this cadence while the scheduler is open. */
  heartbeatIntervalMs?: number;
  push(snapshot: T): Promise<void>;
  now?: () => number;
}

/**
 * Coalesces a stream of cumulative snapshots into a completion-paced publisher.
 *
 * The first snapshot after an idle period is published on the next microtask.
 * While output remains active, newer snapshots only replace `latest`; one
 * callback runs after the previous callback has settled plus `minIntervalMs`.
 * With `heartbeatIntervalMs`, an otherwise idle scheduler periodically pushes
 * the same latest snapshot so render-time metadata can stay fresh. `finish()`
 * is a barrier: it publishes the latest snapshot immediately after any
 * in-flight callback, cancels the heartbeat, then closes.
 */
export class LatestSnapshotScheduler<T> {
  private readonly minIntervalMs: number;
  private readonly heartbeatIntervalMs: number | undefined;
  private readonly push: (snapshot: T) => Promise<void>;
  private readonly now: () => number;
  private readonly failureSignal = deferred<never>();
  private readonly waiters: PublishWaiter[] = [];

  private latest: VersionedSnapshot<T> | undefined;
  private nextVersion = 0;
  private publishedVersion = 0;
  private forceThroughVersion = 0;
  private nextAllowedAt = 0;
  private nextHeartbeatAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerKind: 'pending' | 'heartbeat' | undefined;
  private microtaskScheduled = false;
  private inFlight: Promise<void> | undefined;
  private failure: unknown;
  private failed = false;
  private closing = false;
  private closed = false;
  private finishPromise: Promise<void> | undefined;

  constructor(opts: LatestSnapshotSchedulerOptions<T>) {
    if (!Number.isFinite(opts.minIntervalMs) || opts.minIntervalMs < 0) {
      throw new Error(`invalid snapshot refresh interval: ${opts.minIntervalMs}`);
    }
    if (
      opts.heartbeatIntervalMs !== undefined &&
      (!Number.isFinite(opts.heartbeatIntervalMs) || opts.heartbeatIntervalMs <= 0)
    ) {
      throw new Error(`invalid snapshot heartbeat interval: ${opts.heartbeatIntervalMs}`);
    }
    this.minIntervalMs = opts.minIntervalMs;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs;
    this.push = opts.push;
    this.now = opts.now ?? Date.now;
    // Callers observe background push failures through `whenFailed` or the
    // `finish()` barrier. Keep an internal handler attached so the interval
    // before either observer is installed cannot emit an unhandled rejection.
    void this.failureSignal.promise.catch(() => {});
  }

  /** Rejects if a scheduled background push fails. */
  get whenFailed(): Promise<never> {
    return this.failureSignal.promise;
  }

  /** Replace the pending snapshot. No queue of superseded render states is kept. */
  offer(snapshot: T): number {
    if (this.closing || this.closed) {
      throw new Error('cannot offer a snapshot after scheduler finish');
    }
    if (this.failed) throw this.failure;

    const version = ++this.nextVersion;
    this.latest = { version, value: snapshot };
    if (this.timerKind === 'heartbeat') this.cancelTimer();
    this.schedule();
    return version;
  }

  /**
   * Publish the latest offered snapshot as a terminal/barrier update and stop.
   * The normal interval is intentionally bypassed so done/error and segment
   * rotation cannot leave the visible card one snapshot behind.
   */
  finish(): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.closing = true;
    this.finishPromise = this.finishLatest();
    return this.finishPromise;
  }

  private async finishLatest(): Promise<void> {
    try {
      if (this.failed) throw this.failure;
      // A heartbeat does not advance publishedVersion, so version comparison
      // alone cannot detect it. Always let the current callback settle before
      // deciding whether a final data snapshot is still outstanding.
      if (this.inFlight) await this.inFlight;
      if (this.failed) throw this.failure;
      const targetVersion = this.latest?.version ?? this.publishedVersion;
      if (targetVersion > this.publishedVersion) {
        this.forceThroughVersion = Math.max(this.forceThroughVersion, targetVersion);
        const published = this.waitUntilPublished(targetVersion);
        this.cancelTimer();
        this.schedule();
        await published;
      }
    } finally {
      this.closed = true;
      this.cancelTimer();
    }
  }

  private schedule(): void {
    const pending = this.latest;
    if (
      this.closed ||
      this.failed ||
      this.inFlight ||
      !pending ||
      this.timer ||
      this.microtaskScheduled
    ) {
      return;
    }

    const hasPendingSnapshot = pending.version > this.publishedVersion;
    if (!hasPendingSnapshot) {
      if (
        this.closing ||
        this.publishedVersion === 0 ||
        this.heartbeatIntervalMs === undefined
      ) {
        return;
      }
      this.scheduleTimer(Math.max(0, this.nextHeartbeatAt - this.now()), 'heartbeat');
      return;
    }

    const forced = this.forceThroughVersion > this.publishedVersion;
    const waitMs =
      forced || this.publishedVersion === 0
        ? 0
        : Math.max(0, this.nextAllowedAt - this.now());
    if (waitMs > 0) {
      this.scheduleTimer(waitMs, 'pending');
      return;
    }

    this.microtaskScheduled = true;
    queueMicrotask(() => {
      this.microtaskScheduled = false;
      void this.publishNext();
    });
  }

  private async publishNext(): Promise<void> {
    const pending = this.latest;
    if (
      this.closed ||
      this.failed ||
      this.inFlight ||
      !pending
    ) {
      return;
    }

    const hasPendingSnapshot = pending.version > this.publishedVersion;
    const heartbeatDue =
      !hasPendingSnapshot &&
      !this.closing &&
      this.publishedVersion > 0 &&
      this.heartbeatIntervalMs !== undefined &&
      this.now() >= this.nextHeartbeatAt;
    if (!hasPendingSnapshot && !heartbeatDue) {
      this.schedule();
      return;
    }

    const forced = hasPendingSnapshot && this.forceThroughVersion > this.publishedVersion;
    const waitMs = hasPendingSnapshot
      ? forced || this.publishedVersion === 0
        ? 0
        : Math.max(0, this.nextAllowedAt - this.now())
      : Math.max(0, this.nextHeartbeatAt - this.now());
    if (waitMs > 0) {
      this.scheduleTimer(waitMs, hasPendingSnapshot ? 'pending' : 'heartbeat');
      return;
    }

    const operation = Promise.resolve().then(() => this.push(pending.value));
    this.inFlight = operation;
    try {
      await operation;
      if (hasPendingSnapshot) this.publishedVersion = pending.version;
      this.nextAllowedAt = this.now() + this.minIntervalMs;
      if (this.heartbeatIntervalMs !== undefined) {
        this.nextHeartbeatAt = this.now() + this.heartbeatIntervalMs;
      }
      if (this.forceThroughVersion <= this.publishedVersion) {
        this.forceThroughVersion = 0;
      }
      this.resolvePublishedWaiters();
    } catch (err) {
      this.fail(err);
    } finally {
      this.inFlight = undefined;
      this.schedule();
    }
  }

  private waitUntilPublished(targetVersion: number): Promise<void> {
    if (targetVersion <= this.publishedVersion) return Promise.resolve();
    if (this.failed) return Promise.reject(this.failure);
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ targetVersion, resolve, reject });
    });
  }

  private resolvePublishedWaiters(): void {
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i];
      if (!waiter || waiter.targetVersion > this.publishedVersion) continue;
      this.waiters.splice(i, 1);
      waiter.resolve();
    }
  }

  private fail(reason: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.failure = reason;
    this.cancelTimer();
    this.failureSignal.reject(reason);
    for (const waiter of this.waiters.splice(0)) waiter.reject(reason);
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerKind = undefined;
  }

  private scheduleTimer(waitMs: number, kind: 'pending' | 'heartbeat'): void {
    if (waitMs <= 0) {
      this.microtaskScheduled = true;
      queueMicrotask(() => {
        this.microtaskScheduled = false;
        void this.publishNext();
      });
      return;
    }
    this.timerKind = kind;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerKind = undefined;
      void this.publishNext();
    }, waitMs);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
