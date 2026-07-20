import { afterEach, describe, expect, it, vi } from 'vitest';
import { LatestSnapshotScheduler } from '../../../src/bot/latest-snapshot-scheduler.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('LatestSnapshotScheduler', () => {
  it('keeps only the latest pending snapshot and waits from push completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const firstPush = deferred<void>();
    const secondPush = deferred<void>();
    const gates = [firstPush, secondPush];
    const calls: Array<{ snapshot: string; at: number }> = [];
    let pushIndex = 0;
    const scheduler = new LatestSnapshotScheduler<string>({
      minIntervalMs: 1000,
      push: async (snapshot) => {
        calls.push({ snapshot, at: Date.now() });
        await gates[pushIndex++]?.promise;
      },
    });

    scheduler.offer('first');
    scheduler.offer('first-latest');
    await flushMicrotasks();

    expect(calls).toEqual([{ snapshot: 'first-latest', at: 0 }]);

    scheduler.offer('second');
    scheduler.offer('second-latest');
    await vi.advanceTimersByTimeAsync(500);
    firstPush.resolve();
    await flushMicrotasks();

    // The lower bound starts when the first push callback settles at t=500.
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(calls).toEqual([
      { snapshot: 'first-latest', at: 0 },
      { snapshot: 'second-latest', at: 1500 },
    ]);

    secondPush.resolve();
    await flushMicrotasks();
    await scheduler.finish();
  });

  it('has no idle polling and publishes immediately after a long idle period', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const calls: Array<{ snapshot: string; at: number }> = [];
    const scheduler = new LatestSnapshotScheduler<string>({
      minIntervalMs: 1000,
      push: async (snapshot) => {
        calls.push({ snapshot, at: Date.now() });
      },
    });

    scheduler.offer('before-idle');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(calls).toEqual([{ snapshot: 'before-idle', at: 0 }]);

    scheduler.offer('after-idle');
    await flushMicrotasks();
    expect(calls).toEqual([
      { snapshot: 'before-idle', at: 0 },
      { snapshot: 'after-idle', at: 10 * 60 * 1000 },
    ]);

    await scheduler.finish();
  });

  it('heartbeats the latest snapshot while open and stops after finish', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const calls: Array<{ snapshot: string; at: number }> = [];
    const scheduler = new LatestSnapshotScheduler<string>({
      minIntervalMs: 1000,
      heartbeatIntervalMs: 10_000,
      push: async (snapshot) => {
        calls.push({ snapshot, at: Date.now() });
      },
    });

    scheduler.offer('running');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(9999);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(calls).toEqual([
      { snapshot: 'running', at: 0 },
      { snapshot: 'running', at: 10_000 },
    ]);

    scheduler.offer('running-with-new-data');
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(calls[2]).toEqual({ snapshot: 'running-with-new-data', at: 11_000 });

    await scheduler.finish();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(calls).toHaveLength(3);
  });

  it('waits for an in-flight heartbeat before finishing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const heartbeatPush = deferred<void>();
    let pushes = 0;
    const scheduler = new LatestSnapshotScheduler<string>({
      minIntervalMs: 1000,
      heartbeatIntervalMs: 10_000,
      push: async () => {
        pushes += 1;
        if (pushes === 2) await heartbeatPush.promise;
      },
    });

    scheduler.offer('running');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();
    expect(pushes).toBe(2);

    let finished = false;
    const finishing = scheduler.finish().then(() => {
      finished = true;
    });
    await flushMicrotasks();
    expect(finished).toBe(false);

    heartbeatPush.resolve();
    await finishing;
    expect(finished).toBe(true);
  });

  it('forces the terminal snapshot through without waiting for the active interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runningPush = deferred<void>();
    const calls: Array<{ snapshot: string; at: number }> = [];
    const scheduler = new LatestSnapshotScheduler<string>({
      minIntervalMs: 1000,
      push: async (snapshot) => {
        calls.push({ snapshot, at: Date.now() });
        if (snapshot === 'running') await runningPush.promise;
      },
    });

    scheduler.offer('running');
    await flushMicrotasks();
    scheduler.offer('terminal');
    const finished = scheduler.finish();
    await flushMicrotasks();
    expect(calls).toEqual([{ snapshot: 'running', at: 0 }]);

    await vi.advanceTimersByTimeAsync(500);
    runningPush.resolve();
    await flushMicrotasks();
    await finished;

    expect(calls).toEqual([
      { snapshot: 'running', at: 0 },
      { snapshot: 'terminal', at: 500 },
    ]);
    expect(() => scheduler.offer('too-late')).toThrow(/after scheduler finish/);
  });

  it('surfaces a background push failure to the producer and finish barrier', async () => {
    const failure = new Error('update failed');
    const scheduler = new LatestSnapshotScheduler<string>({
      minIntervalMs: 1000,
      push: async () => {
        throw failure;
      },
    });

    scheduler.offer('snapshot');
    await expect(scheduler.whenFailed).rejects.toBe(failure);
    await expect(scheduler.finish()).rejects.toBe(failure);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}
