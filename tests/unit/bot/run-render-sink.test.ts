import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentEventProcessor } from '../../../src/bot/agent-event-processor.js';
import {
  CardRunRenderSink,
  MarkdownRunRenderSink,
} from '../../../src/bot/run-render-sink.js';
import { reduce, type RunState } from '../../../src/card/run-state.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('run render snapshot pacing', () => {
  it('coalesces markdown states into one atomic card patch and flushes terminal state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const writes: CardWrite[] = [];
    const channel = atomicCardChannel(writes);
    const sink = new MarkdownRunRenderSink({
      channel,
      chatId: 'oc_chat',
      sendOpts: {},
      maxChars: 12_000,
      refreshMinIntervalMs: 1000,
    });

    const first = textState(undefined, 'A');
    await sink.updateActive(first);
    await flushMicrotasks();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.kind).toBe('send');
    expect(JSON.stringify(writes[0]?.card)).toContain('A');
    expectNonStreaming(writes[0]?.card);

    const second = textState(first, 'B');
    const latest = textState(second, 'C');
    await sink.updateActive(second);
    await sink.updateActive(latest);
    await flushMicrotasks();
    expect(writes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(writes).toHaveLength(2);
    expect(writes[1]?.kind).toBe('update');
    expect(writes[1]?.messageId).toBe(writes[0]?.messageId);
    expect(JSON.stringify(writes[1]?.card)).toContain('ABC');
    expectNonStreaming(writes[1]?.card);

    const terminal = reduce(latest, { type: 'done', terminationReason: 'normal' });
    await sink.closeActive(terminal);
    expect(writes).toHaveLength(3);
    expect(JSON.stringify(writes[2]?.card)).toContain('ABC');
    expect(JSON.stringify(writes[2]?.card)).not.toContain('刷新字符');
    expectNonStreaming(writes[2]?.card);
    expect(channel.stream).not.toHaveBeenCalled();
  });

  it('uses the same non-streaming full-card transport for interactive cards', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const writes: CardWrite[] = [];
    const channel = atomicCardChannel(writes);
    const sink = new CardRunRenderSink({
      channel,
      chatId: 'oc_chat',
      sendOpts: {},
      maxChars: 12_000,
      renderOptions: {},
      refreshMinIntervalMs: 1000,
    });

    const first = textState(undefined, 'A');
    await sink.updateActive(first);
    await flushMicrotasks();
    expect(writes).toHaveLength(1);
    expectNonStreaming(writes[0]?.card);

    const second = textState(first, 'B');
    const latest = textState(second, 'C');
    await sink.updateActive(second);
    await sink.updateActive(latest);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(writes).toHaveLength(2);
    expect(writes[1]?.kind).toBe('update');
    expect(JSON.stringify(writes[1]?.card)).toContain('ABC');
    expectNonStreaming(writes[1]?.card);

    const terminal = reduce(latest, { type: 'done', terminationReason: 'normal' });
    await sink.closeActive(terminal);
    expect(writes).toHaveLength(3);
    expect(JSON.stringify(writes[2]?.card)).toContain('ABC');
    expect(JSON.stringify(writes[2]?.card)).not.toContain('刷新字符');
    expectNonStreaming(writes[2]?.card);
    expect(channel.stream).not.toHaveBeenCalled();
  });

  it('refreshes the running footer timestamp atomically on heartbeat and stops at terminal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const writes: CardWrite[] = [];
    const channel = atomicCardChannel(writes);
    const sink = new MarkdownRunRenderSink({
      channel,
      chatId: 'oc_chat',
      sendOpts: {},
      maxChars: 12_000,
      refreshMinIntervalMs: 1000,
      heartbeatIntervalMs: 10_000,
    });
    const running = textState(undefined, 'still working');

    await sink.updateActive(running);
    await flushMicrotasks();
    expect(writes).toHaveLength(1);
    const firstCard = JSON.stringify(writes[0]?.card);
    expect(firstCard).toMatch(
      /刷新字符 [\d,]+\/[\d,]+ · Updated at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/,
    );
    expectNonStreaming(writes[0]?.card);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();
    expect(writes).toHaveLength(2);
    expect(JSON.stringify(writes[1]?.card)).not.toBe(firstCard);
    expect(writes[1]?.kind).toBe('update');
    expectNonStreaming(writes[1]?.card);

    const terminal = reduce(running, { type: 'done', terminationReason: 'normal' });
    await sink.closeActive(terminal);
    expect(writes).toHaveLength(3);
    expect(JSON.stringify(writes[2]?.card)).not.toContain('Updated at');

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(writes).toHaveLength(3);
    expect(channel.stream).not.toHaveBeenCalled();
  });

  it('treats segment sealing as an atomic snapshot barrier', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const writes: CardWrite[] = [];
    const channel = atomicCardChannel(writes);
    const sink = new MarkdownRunRenderSink({
      channel,
      chatId: 'oc_chat',
      sendOpts: {},
      maxChars: 20,
      refreshMinIntervalMs: 1000,
    });
    const processor = new AgentEventProcessor({ sink, maxChars: 20 });

    await processor.process({ type: 'text', delta: 'abcdefghijklmnopqrstuvwxyz' });
    await flushMicrotasks();

    const sends = writes.filter((write) => write.kind === 'send');
    expect(sends).toHaveLength(2);
    expect(JSON.stringify(sends[0]?.card)).toContain('abcdefghijklmnop');
    expect(JSON.stringify(sends[0]?.card)).toContain('继续见下一条');
    expect(JSON.stringify(sends[1]?.card)).toContain('qrstuvwxyz');
    expect(sends.every((write) => streamingMode(write.card) === false)).toBe(true);

    const terminal = reduce(processor.currentState(), {
      type: 'done',
      terminationReason: 'normal',
    });
    await processor.finalize(terminal);
    expect(channel.stream).not.toHaveBeenCalled();
  });
});

interface CardWrite {
  kind: 'send' | 'update';
  messageId: string;
  card: object;
}

function textState(previous: RunState | undefined, delta: string): RunState {
  return reduce(
    previous ?? {
      blocks: [],
      reasoning: { content: '', active: false },
      footer: 'thinking',
      terminal: 'running',
    },
    { type: 'text', delta },
  );
}

function atomicCardChannel(writes: CardWrite[]): LarkChannel {
  let nextMessage = 0;
  return {
    stream: vi.fn(async () => {
      throw new Error('snapshot rendering must not use channel.stream');
    }),
    send: vi.fn(async (_chatId: string, input: unknown) => {
      const card = (input as { card?: object }).card;
      if (!card) throw new Error('expected an interactive card snapshot');
      const messageId = `om_snapshot_${++nextMessage}`;
      writes.push({ kind: 'send', messageId, card });
      return { messageId };
    }),
    updateCard: vi.fn(async (messageId: string, card: object) => {
      writes.push({ kind: 'update', messageId, card });
    }),
  } as unknown as LarkChannel;
}

function expectNonStreaming(card: object | undefined): void {
  expect(streamingMode(card)).toBe(false);
}

function streamingMode(card: object | undefined): unknown {
  return (card as { config?: { streaming_mode?: unknown } } | undefined)?.config?.streaming_mode;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}
