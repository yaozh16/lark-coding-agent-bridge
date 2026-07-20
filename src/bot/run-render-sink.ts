import type { LarkChannel, SendOptions } from '@larksuite/channel';
import type { RunCardRenderOptions } from '../card/run-renderer';
import { renderCard } from '../card/run-renderer';
import type { RunState } from '../card/run-state';
import { renderText } from '../card/text-renderer';
import { log } from '../core/logger';
import type { RunRenderSink } from './agent-event-processor';
import { LatestSnapshotScheduler } from './latest-snapshot-scheduler';

const SNAPSHOT_REFRESH_MIN_INTERVAL_MS = 1000;
const SNAPSHOT_HEARTBEAT_INTERVAL_MS = 10_000;

interface Segment {
  scheduler: LatestSnapshotScheduler<RunState>;
  messageId?: string;
}

export interface BaseRunRenderSinkOptions {
  channel: LarkChannel;
  chatId: string;
  sendOpts: SendOptions;
  maxChars: number;
  /** Internal/test override. Production uses one refresh at most per second. */
  refreshMinIntervalMs?: number;
  /** Internal/test override. Production refreshes an idle running card every 10s. */
  heartbeatIntervalMs?: number;
}

export class MarkdownRunRenderSink implements RunRenderSink {
  private readonly channel: LarkChannel;
  private readonly chatId: string;
  private readonly sendOpts: SendOptions;
  private readonly maxChars: number;
  private readonly refreshMinIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private current: Segment | undefined;

  constructor(opts: BaseRunRenderSinkOptions) {
    this.channel = opts.channel;
    this.chatId = opts.chatId;
    this.sendOpts = opts.sendOpts;
    this.maxChars = opts.maxChars;
    this.refreshMinIntervalMs =
      opts.refreshMinIntervalMs ?? SNAPSHOT_REFRESH_MIN_INTERVAL_MS;
    this.heartbeatIntervalMs =
      opts.heartbeatIntervalMs ?? SNAPSHOT_HEARTBEAT_INTERVAL_MS;
  }

  measure(state: RunState): number {
    return renderText(state).length;
  }

  async updateActive(state: RunState): Promise<void> {
    this.ensureSegment().scheduler.offer(state);
  }

  async sealActive(state: RunState): Promise<void> {
    await this.finishCurrent(state, 'seal');
  }

  async closeActive(state: RunState): Promise<void> {
    await this.finishCurrent(state, 'close');
  }

  private ensureSegment(): Segment {
    if (this.current) return this.current;
    let segment!: Segment;
    segment = {
      scheduler: new LatestSnapshotScheduler<RunState>({
        minIntervalMs: this.refreshMinIntervalMs,
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        push: (state) => this.publish(segment, state),
      }),
    };
    this.current = segment;
    return segment;
  }

  private async finishCurrent(state: RunState, step: 'seal' | 'close'): Promise<void> {
    const segment = this.current ?? this.ensureSegment();
    this.current = undefined;

    try {
      segment.scheduler.offer(state);
      await segment.scheduler.finish();
    } catch (err) {
      log.fail('snapshot', err, { mode: 'markdown', step });
    }
  }

  private async publish(segment: Segment, state: RunState): Promise<void> {
    const card = markdownSnapshotCard(this.renderMarkdown(state), state);
    if (segment.messageId) {
      await this.channel.updateCard(segment.messageId, card);
      return;
    }
    const sent = await this.channel.send(this.chatId, { card }, this.sendOpts);
    segment.messageId = sent.messageId;
  }

  private renderMarkdown(state: RunState): string {
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
  private readonly refreshMinIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private current: Segment | undefined;

  constructor(opts: CardRunRenderSinkOptions) {
    this.channel = opts.channel;
    this.chatId = opts.chatId;
    this.sendOpts = opts.sendOpts;
    this.renderOptions = opts.renderOptions;
    this.maxChars = opts.maxChars;
    this.refreshMinIntervalMs =
      opts.refreshMinIntervalMs ?? SNAPSHOT_REFRESH_MIN_INTERVAL_MS;
    this.heartbeatIntervalMs =
      opts.heartbeatIntervalMs ?? SNAPSHOT_HEARTBEAT_INTERVAL_MS;
  }

  measure(state: RunState): number {
    return JSON.stringify(renderCard(state, this.renderOptions)).length;
  }

  async updateActive(state: RunState): Promise<void> {
    this.ensureSegment().scheduler.offer(state);
  }

  async sealActive(state: RunState): Promise<void> {
    await this.finishCurrent(state, 'seal');
  }

  async closeActive(state: RunState): Promise<void> {
    await this.finishCurrent(state, 'close');
  }

  private ensureSegment(): Segment {
    if (this.current) return this.current;
    let segment!: Segment;
    segment = {
      scheduler: new LatestSnapshotScheduler<RunState>({
        minIntervalMs: this.refreshMinIntervalMs,
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        push: (state) => this.publish(segment, state),
      }),
    };
    this.current = segment;
    return segment;
  }

  private async finishCurrent(state: RunState, step: 'seal' | 'close'): Promise<void> {
    const segment = this.current ?? this.ensureSegment();
    this.current = undefined;

    try {
      segment.scheduler.offer(state);
      await segment.scheduler.finish();
    } catch (err) {
      log.fail('snapshot', err, { mode: 'card', step });
    }
  }

  private async publish(segment: Segment, state: RunState): Promise<void> {
    const card = this.render(state);
    if (segment.messageId) {
      await this.channel.updateCard(segment.messageId, card);
      return;
    }
    const sent = await this.channel.send(this.chatId, { card }, this.sendOpts);
    segment.messageId = sent.messageId;
  }

  private render(state: RunState): object {
    const renderedChars = this.measure(state);
    return disableStreaming(
      appendCardFooter(
        renderCard(state, this.renderOptions),
        refreshCharSuffix(state, renderedChars, this.maxChars),
      ),
    );
  }
}

function markdownSnapshotCard(markdown: string, state: RunState): object {
  const content = markdown.trim() || (state.terminal === 'done' ? '_（未返回内容）_' : '…');
  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
      summary: { content: snapshotSummary(state) },
    },
    body: {
      elements: [{ tag: 'markdown', content }],
    },
  };
}

function disableStreaming(card: object): object {
  const config = (card as { config?: object }).config ?? {};
  return {
    ...card,
    config: {
      ...config,
      streaming_mode: false,
    },
  };
}

function snapshotSummary(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
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
  return `刷新字符 ${formatCount(renderedChars)}/${formatCount(maxChars)} · Updated at ${formatLocalTimestamp(new Date())}`;
}

function formatCount(n: number): string {
  return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatLocalTimestamp(value: Date): string {
  return [
    value.getFullYear(),
    twoDigits(value.getMonth() + 1),
    twoDigits(value.getDate()),
  ].join('-') + ` ${twoDigits(value.getHours())}:${twoDigits(value.getMinutes())}:${twoDigits(value.getSeconds())}`;
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, '0');
}
