import type { AgentEvent } from '../agent/types';
import {
  initialState,
  reduce,
  type Block,
  type RunState,
} from '../card/run-state';

const MIN_ACTIVE_TAIL_CHARS = 1000;

export interface RunRenderSink {
  measure(state: RunState): number;
  updateActive(state: RunState): Promise<void>;
  sealActive(state: RunState): Promise<void>;
  closeActive(state: RunState): Promise<void>;
}

export interface AgentEventProcessorOptions {
  sink: RunRenderSink;
  maxChars: number;
}

export class AgentEventProcessor {
  private state: RunState = initialState;
  private readonly sink: RunRenderSink;
  private readonly maxChars: number;
  private segment = 1;

  constructor(opts: AgentEventProcessorOptions) {
    this.sink = opts.sink;
    this.maxChars = opts.maxChars;
  }

  currentState(): RunState {
    return this.state;
  }

  async process(evt: AgentEvent): Promise<RunState> {
    this.state = compactState(reduce(this.state, compactEvent(evt, this.maxChars)), this.maxChars);

    if (this.state.terminal === 'running' && this.sink.measure(this.state) > this.maxChars) {
      const split = splitStateForRotation(this.state, this.maxChars);
      if (split) {
        await this.sink.sealActive(markSegmentContinuation(split.sealed, this.segment));
        this.segment += 1;
        this.state = split.active;
      }
    }

    await this.sink.updateActive(this.state);
    return this.state;
  }

  async finalize(state: RunState): Promise<RunState> {
    this.state = compactState(state, this.maxChars);
    await this.sink.updateActive(this.state);
    await this.sink.closeActive(this.state);
    return this.state;
  }
}

function compactEvent(evt: AgentEvent, maxChars: number): AgentEvent {
  if (evt.type === 'tool_use') {
    return {
      ...evt,
      input: compactToolInput(evt.input, maxChars),
    };
  }
  if (evt.type === 'tool_result') {
    return {
      ...evt,
      output: truncate(evt.output, maxChars),
    };
  }
  if (evt.type === 'thinking') {
    return {
      ...evt,
      delta: truncate(evt.delta, maxChars),
    };
  }
  if (evt.type === 'text') {
    return {
      ...evt,
      delta: truncate(evt.delta, maxChars * 2),
    };
  }
  return evt;
}

function compactToolInput(input: unknown, maxChars: number): unknown {
  if (!input || typeof input !== 'object') return input;
  const rendered = safeJson(input);
  if (rendered.length <= maxChars) return input;
  return {
    truncated: true,
    preview: truncate(rendered, Math.max(1000, Math.floor(maxChars / 2))),
  };
}

function compactState(state: RunState, maxChars: number): RunState {
  const reasoningMax = Math.max(1000, Math.floor(maxChars / 3));
  const reasoning = state.reasoning.content.length > reasoningMax
    ? {
        ...state.reasoning,
        content: `…\n${state.reasoning.content.slice(-reasoningMax)}`,
      }
    : state.reasoning;
  return {
    ...state,
    reasoning,
    blocks: state.blocks.map((block) => compactBlock(block, maxChars)),
  };
}

function compactBlock(block: Block, maxChars: number): Block {
  if (block.kind === 'text') {
    const hardMax = maxChars * 2;
    return block.content.length > hardMax
      ? { ...block, content: block.content.slice(-hardMax) }
      : block;
  }
  const tool = block.tool;
  return {
    ...block,
    tool: {
      ...tool,
      input: compactToolInput(tool.input, maxChars),
      ...(tool.output ? { output: truncate(tool.output, maxChars) } : {}),
    },
  };
}

function splitStateForRotation(
  state: RunState,
  maxChars: number,
): { sealed: RunState; active: RunState } | undefined {
  const textSplit = splitOversizedStreamingText(state, maxChars);
  if (textSplit) return textSplit;

  const idx = lastSealableBlockIndex(state.blocks);
  if (idx < 0) return undefined;
  const sealedBlocks = state.blocks.slice(0, idx + 1);
  const activeBlocks = state.blocks.slice(idx + 1);
  if (sealedBlocks.length === 0) return undefined;

  return {
    sealed: sealedStateFrom(state, sealedBlocks),
    active: activeStateFrom(state, activeBlocks),
  };
}

function splitOversizedStreamingText(
  state: RunState,
  maxChars: number,
): { sealed: RunState; active: RunState } | undefined {
  const last = state.blocks[state.blocks.length - 1];
  if (!last || last.kind !== 'text' || !last.streaming || last.content.length <= maxChars) {
    return undefined;
  }

  const activeTailChars = Math.min(
    Math.max(MIN_ACTIVE_TAIL_CHARS, Math.floor(maxChars / 4)),
    Math.floor(maxChars / 2),
  );
  const splitAt = Math.max(1, last.content.length - activeTailChars);
  const sealedText: Block = {
    kind: 'text',
    content: last.content.slice(0, splitAt),
    streaming: false,
  };
  const activeText: Block = {
    kind: 'text',
    content: last.content.slice(splitAt),
    streaming: true,
  };
  const prefix = state.blocks.slice(0, -1);

  return {
    sealed: sealedStateFrom(state, [...prefix, sealedText]),
    active: activeStateFrom(state, [activeText]),
  };
}

function lastSealableBlockIndex(blocks: Block[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (!block) continue;
    if (block.kind === 'text' && !block.streaming) return i;
    if (block.kind === 'tool' && block.tool.status !== 'running') return i;
  }
  return -1;
}

function sealedStateFrom(state: RunState, blocks: Block[]): RunState {
  return {
    ...state,
    blocks: closeStreamingBlocks(blocks),
    reasoning: { content: state.reasoning.content, active: false },
    footer: null,
    terminal: 'done',
  };
}

function activeStateFrom(state: RunState, blocks: Block[]): RunState {
  return {
    ...state,
    blocks,
    reasoning: { content: '', active: false },
    footer: state.footer,
    terminal: 'running',
    errorMsg: undefined,
    idleTimeoutMinutes: undefined,
  };
}

function markSegmentContinuation(state: RunState, segment: number): RunState {
  const note: Block = {
    kind: 'text',
    content: `_第 ${segment} 段已封存，继续见下一条。_`,
    streaming: false,
  };
  return {
    ...state,
    blocks: [...state.blocks, note],
  };
}

function closeStreamingBlocks(blocks: Block[]): Block[] {
  return blocks.map((block) =>
    block.kind === 'text' && block.streaming ? { ...block, streaming: false } : block,
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}
