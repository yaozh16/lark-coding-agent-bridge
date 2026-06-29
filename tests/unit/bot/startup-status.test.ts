import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRunOptions } from '../../../src/agent/types';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { sendStartupStatus } from '../../../src/bot/startup-status';

describe('startup status notification', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('sends a markdown table and treats non-git workspaces as normal', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'bridge-startup-status-'));
    cleanup.push(workspace);
    await writeFile(join(workspace, 'AGENTS.md'), 'rules\n');

    const send = vi.fn(async (_to: string, _input: { markdown: string }) => ({ messageId: 'om_1' }));
    const profileConfig = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: { binaryPath: 'codex' },
    });
    profileConfig.workspaces.default = workspace;

    await sendStartupStatus({
      channel: { send } as unknown as LarkChannel,
      ownerOpenId: 'ou_owner',
      profile: 'codex',
      agent: fakeAgent(),
      profileConfig,
    });

    expect(send).toHaveBeenCalledWith('ou_owner', {
      markdown: expect.stringContaining('| 项目 | 状态 |'),
    });
    const call = send.mock.calls[0];
    expect(call).toBeDefined();
    const markdown = call![1].markdown;
    expect(markdown).toContain(`| Workspace | ${workspace} |`);
    expect(markdown).toContain('| Memory | AGENTS.md |');
    expect(markdown).toContain('| Git | 未检测到 git 仓库 |');
  });
});

function fakeAgent(): AgentAdapter {
  return {
    id: 'codex',
    displayName: 'Codex CLI',
    async isAvailable() {
      return true;
    },
    run(_opts: AgentRunOptions) {
      throw new Error('not used');
    },
  };
}
