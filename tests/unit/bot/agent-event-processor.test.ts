import { describe, expect, it } from 'vitest';
import { AgentEventProcessor, type RunRenderSink } from '../../../src/bot/agent-event-processor';
import type { RunState } from '../../../src/card/run-state';
import { renderText } from '../../../src/card/text-renderer';

describe('AgentEventProcessor', () => {
  it('seals old text and keeps only the active tail when a block exceeds the limit', async () => {
    const sink = new FakeSink();
    const processor = new AgentEventProcessor({ sink, maxChars: 20 });

    await processor.process({ type: 'text', delta: 'abcdefghijklmnopqrstuvwxyz' });

    expect(sink.sealed).toHaveLength(1);
    expect(renderText(sink.sealed[0]!)).toContain('abcdefghijklmnop');
    expect(renderText(sink.sealed[0]!)).toContain('继续见下一条');
    expect(renderText(processor.currentState())).toContain('qrstuvwxyz');
    expect(renderText(processor.currentState())).not.toContain('abcdefghijklmnop');
  });

  it('truncates large tool output before storing it in RunState', async () => {
    const sink = new FakeSink();
    const processor = new AgentEventProcessor({ sink, maxChars: 30 });

    await processor.process({
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'node huge-output.js' },
    });
    await processor.process({
      type: 'tool_result',
      id: 'tool-1',
      output: 'x'.repeat(200),
      isError: false,
    });

    const tool = processor.currentState().blocks.find((block) => block.kind === 'tool');
    expect(tool?.kind).toBe('tool');
    expect(tool?.kind === 'tool' ? tool.tool.output?.length : 0).toBeLessThanOrEqual(30);
  });
});

class FakeSink implements RunRenderSink {
  sealed: RunState[] = [];
  updates: RunState[] = [];

  measure(state: RunState): number {
    return renderText(state).length;
  }

  async updateActive(state: RunState): Promise<void> {
    this.updates.push(state);
  }

  async sealActive(state: RunState): Promise<void> {
    this.sealed.push(state);
  }

  async closeActive(state: RunState): Promise<void> {
    this.updates.push(state);
  }
}
