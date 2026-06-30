import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandWithDefaultTimeout,
  formatShellCommandResult,
  parseBangShellCommand,
  runShellCommand,
} from '../../../src/bot/shell-command';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('bang shell command', () => {
  it('parses bang-prefixed messages only', () => {
    expect(parseBangShellCommand('!git status')).toBe('git status');
    expect(parseBangShellCommand('  ! pwd  ')).toBe('pwd');
    expect(parseBangShellCommand('git status')).toBeUndefined();
  });

  it('adds a 300s timeout unless the command already starts with timeout', () => {
    expect(commandWithDefaultTimeout('git status')).toBe(
      `timeout 300s ${process.env.SHELL ?? '/bin/bash'} -lc 'git status'`,
    );
    expect(commandWithDefaultTimeout('timeout 10s git status')).toBe('timeout 10s git status');
  });

  it('runs in the requested cwd and formats stdout', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bridge-shell-command-'));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));

    const result = await runShellCommand(
      'node -e "process.stdout.write(process.cwd())"',
      cwd,
    );

    expect(result.exitCode).toBe(0);
    expect(result.executedCommand).toBe(
      `timeout 300s ${process.env.SHELL ?? '/bin/bash'} -lc 'node -e "process.stdout.write(process.cwd())"'`,
    );
    expect(result.stdout).toBe(cwd);
    const formatted = formatShellCommandResult(result);
    expect(formatted).toContain('✓ shell 执行完成');
    expect(formatted).toContain('```bash');
  });
});
