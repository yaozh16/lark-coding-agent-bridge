import type { LarkChannel, SendOptions } from '@larksuite/channel';
import type { RunCardRenderOptions } from '../card/run-renderer';
import { renderCard } from '../card/run-renderer';
import type { RunState } from '../card/run-state';
import { initialState } from '../card/run-state';
import { renderText } from '../card/text-renderer';
import { log } from '../core/logger';
import type { RunRenderSink } from './agent-event-processor';

const STREAM_TERMINAL_GRACE_MS = 3000;

type MarkdownCtrl = { setContent(markdown: string): Promise<void> };
type CardCtrl = { update(next: object | ((current: object) => object)): Promise<void> };

interface Segment<Ctrl> {
  done: Deferred<void>;
  producerStarted: boolean;
  ctrl?: Ctrl;
  latest?: RunState;
  streamDone: Promise<StreamResult>;
}

type StreamResult =
  | { ok: true }
  | { ok: false; err: unknown };

export interface BaseRunRenderSinkOptions {
  channel: LarkChannel;
  chatId: string;
  sendOpts: SendOptions;
  maxChars: number;
}

export class MarkdownRunRenderSink implements RunRenderSink {
  private readonly channel: LarkChannel;
  private readonly chatId: string;
  private readonly sendOpts: SendOptions;
  private readonly maxChars: number;
  private current: Segment<MarkdownCtrl> | undefined;

  constructor(opts: BaseRunRenderSinkOptions) {
    this.channel = opts.channel;
    this.chatId = opts.chatId;
    this.sendOpts = opts.sendOpts;
    this.maxChars = opts.maxChars;
  }

  measure(state: RunState): number {
    return renderText(state).length;
  }

  async updateActive(state: RunState): Promise<void> {
    const segment = this.ensureSegment();
    segment.latest = state;
    if (segment.ctrl) {
      await segment.ctrl.setContent(this.render(state));
    }
  }

  async sealActive(state: RunState): Promise<void> {
    await this.updateActive(state);
    await this.finishCurrent(state, 'seal');
  }

  async closeActive(state: RunState): Promise<void> {
    await this.updateActive(state);
    await this.finishCurrent(state, 'close');
  }

  private ensureSegment(): Segment<MarkdownCtrl> {
    if (this.current) return this.current;
    const segment: Segment<MarkdownCtrl> = {
      done: deferred<void>(),
      producerStarted: false,
      streamDone: Promise.resolve({ ok: true }),
    };
    segment.streamDone = this.channel.stream(
      this.chatId,
      {
        markdown: async (ctrl) => {
          segment.producerStarted = true;
          segment.ctrl = ctrl;
          if (segment.latest) {
            await ctrl.setContent(this.render(segment.latest));
          }
          await segment.done.promise;
        },
      },
      this.sendOpts,
    ).then(
      () => ({ ok: true as const }),
      (err) => ({ ok: false as const, err }),
    );
    this.current = segment;
    return segment;
  }

  private async finishCurrent(state: RunState, step: 'seal' | 'close'): Promise<void> {
    const segment = this.current;
    if (!segment) return;
    segment.done.resolve();
    this.current = undefined;

    if (!segment.producerStarted) {
      await this.fallbackSend(state, step);
      return;
    }

    await settleStreamResult(segment.streamDone, 'markdown', step);
  }

  private async fallbackSend(state: RunState, step: string): Promise<void> {
    const body = this.render(state);
    if (!body.trim()) return;
    try {
      await this.channel.send(this.chatId, { markdown: body }, this.sendOpts);
    } catch (err) {
      log.fail('stream', err, { mode: 'markdown', step: `fallback-${step}` });
    }
  }

  private render(state: RunState): string {
    const renderedChars = this.measure(state);
    return appendMarkdownFooter(renderText(state), refreshCharSuffix(state, renderedChars, this.maxChars));
  }
}

export interface CardRunRenderSinkOptions extends BaseRunRenderSinkOptions {
  renderOptions: RunCardRenderOptions;
}

export class CardRunRenderSink implements RunRenderSink {
  private readonly channel: LarkChannel;
  private readonly chatId: string;
  private readonly sendOpts: SendOptions;
  private readonly renderOptions: RunCardRenderOptions;
  private readonly maxChars: number;
  private current: Segment<CardCtrl> | undefined;

  constructor(opts: CardRunRenderSinkOptions) {
    this.channel = opts.channel;
    this.chatId = opts.chatId;
    this.sendOpts = opts.sendOpts;
    this.renderOptions = opts.renderOptions;
    this.maxChars = opts.maxChars;
  }

  measure(state: RunState): number {
    return JSON.stringify(renderCard(state, this.renderOptions)).length;
  }

  async updateActive(state: RunState): Promise<void> {
    const segment = this.ensureSegment();
    segment.latest = state;
    if (segment.ctrl) {
      await segment.ctrl.update(this.render(state));
    }
  }

  async sealActive(state: RunState): Promise<void> {
    await this.updateActive(state);
    await this.finishCurrent(state, 'seal');
  }

  async closeActive(state: RunState): Promise<void> {
    await this.updateActive(state);
    await this.finishCurrent(state, 'close');
  }

  private ensureSegment(): Segment<CardCtrl> {
    if (this.current) return this.current;
    const segment: Segment<CardCtrl> = {
      done: deferred<void>(),
      producerStarted: false,
      streamDone: Promise.resolve({ ok: true }),
    };
    segment.streamDone = this.channel.stream(
      this.chatId,
      {
        card: {
          initial: renderCard(initialState, this.renderOptions),
          producer: async (ctrl) => {
            segment.producerStarted = true;
            segment.ctrl = ctrl;
            if (segment.latest) {
              await ctrl.update(this.render(segment.latest));
            }
            await segment.done.promise;
          },
        },
      },
      this.sendOpts,
    ).then(
      () => ({ ok: true as const }),
      (err) => ({ ok: false as const, err }),
    );
    this.current = segment;
    return segment;
  }

  private async finishCurrent(state: RunState, step: 'seal' | 'close'): Promise<void> {
    const segment = this.current;
    if (!segment) return;
    segment.done.resolve();
    this.current = undefined;

    if (!segment.producerStarted) {
      await this.fallbackSend(state, step);
      return;
    }

    await settleStreamResult(segment.streamDone, 'card', step);
  }

  private async fallbackSend(state: RunState, step: string): Promise<void> {
    try {
      await this.channel.send(
        this.chatId,
        { card: this.render(state) },
        this.sendOpts,
      );
    } catch (err) {
      log.fail('stream', err, { mode: 'card', step: `fallback-${step}` });
    }
  }

  private render(state: RunState): object {
    const renderedChars = this.measure(state);
    return appendCardFooter(
      renderCard(state, this.renderOptions),
      refreshCharSuffix(state, renderedChars, this.maxChars),
    );
  }
}

function appendMarkdownFooter(markdown: string, footer: string | undefined): string {
  if (!footer) return markdown;
  return markdown.trim() ? `${markdown}\n\n_${footer}_` : `_${footer}_`;
}

function appendCardFooter(card: object, footer: string | undefined): object {
  if (!footer) return card;
  const body = (card as { body?: { elements?: object[] } }).body;
  if (!body || !Array.isArray(body.elements)) return card;
  const elements = [...body.elements];
  const footerElement = { tag: 'markdown', content: footer, text_size: 'notation' };
  const last = elements.at(-1) as { tag?: string } | undefined;
  const insertAt = last?.tag === 'button' ? elements.length - 1 : elements.length;
  elements.splice(insertAt, 0, footerElement);
  return {
    ...card,
    body: {
      ...body,
      elements,
    },
  };
}

function refreshCharSuffix(
  state: RunState,
  renderedChars: number,
  maxChars: number,
): string | undefined {
  if (state.terminal !== 'running' || !Number.isFinite(maxChars)) return undefined;
  return `刷新字符 ${formatCount(renderedChars)}/${formatCount(maxChars)}`;
}

function formatCount(n: number): string {
  return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

async function settleStreamResult(
  streamDone: Promise<StreamResult>,
  mode: 'card' | 'markdown',
  step: string,
): Promise<void> {
  const result = await Promise.race([
    streamDone,
    delay(STREAM_TERMINAL_GRACE_MS).then(() => undefined),
  ]);
  if (!result) {
    log.warn('stream', 'terminal-grace-expired', {
      mode,
      step,
      graceMs: STREAM_TERMINAL_GRACE_MS,
    });
    void streamDone.then((late) => {
      if (!late.ok) {
        log.fail('stream', late.err, { mode, step: 'stream-terminal-late' });
      }
    });
    return;
  }
  if (!result.ok) {
    log.fail('stream', result.err, { mode, step: 'stream' });
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
