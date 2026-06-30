import { EOL } from 'node:os';
import { spawnProcess } from '../platform/spawn';

const DEFAULT_TIMEOUT = '300s';
const MAX_STREAM_CHARS = 12_000;

export interface ShellCommandRunResult {
  requestedCommand: string;
  executedCommand: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

interface ShellInvocation {
  command: string;
  args: string[];
  displayedCommand: string;
}

export function parseBangShellCommand(content: string): string | undefined {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('!')) return undefined;
  return trimmed.slice(1).trim();
}

export function commandWithDefaultTimeout(command: string): string {
  const trimmed = command.trim();
  if (/^timeout(?:\s|$)/.test(trimmed)) return trimmed;
  return `timeout ${DEFAULT_TIMEOUT} ${shellCommand()} -lc ${shellQuote(trimmed)}`;
}

export async function runShellCommand(command: string, cwd: string): Promise<ShellCommandRunResult> {
  const requestedCommand = command.trim();
  const invocation = buildShellInvocation(requestedCommand);
  const child = spawnProcess(invocation.command, invocation.args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = createLimitedCapture();
  const stderr = createLimitedCapture();
  child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));

  const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve({ exitCode: code, signal: sig }));
    },
  );

  return {
    requestedCommand,
    executedCommand: invocation.displayedCommand,
    cwd,
    exitCode,
    signal,
    stdout: stdout.value(),
    stderr: stderr.value(),
    stdoutTruncated: stdout.truncated(),
    stderrTruncated: stderr.truncated(),
  };
}

export function formatShellCommandResult(result: ShellCommandRunResult): string {
  const ok = result.exitCode === 0;
  const status = ok
    ? 'shell 执行完成'
    : `shell 执行失败 (${result.signal ? `signal ${result.signal}` : `exit ${result.exitCode ?? 'unknown'}`})`;
  const parts = [
    `${ok ? '✓' : '✗'} ${status}`,
    `cwd: \`${result.cwd}\``,
    ['command:', fenced(result.executedCommand, 'bash')].join(EOL),
  ];
  if (result.stdout.trim()) {
    parts.push(['stdout:', fenced(withTruncationNotice(result.stdout, result.stdoutTruncated), 'bash')].join(EOL));
  }
  if (result.stderr.trim()) {
    parts.push(['stderr:', fenced(withTruncationNotice(result.stderr, result.stderrTruncated))].join(EOL));
  }
  if (!result.stdout.trim() && !result.stderr.trim()) {
    parts.push('无输出。');
  }
  return parts.join(`${EOL}${EOL}`);
}

function buildShellInvocation(command: string): ShellInvocation {
  if (/^timeout(?:\s|$)/.test(command)) {
    return {
      command: shellCommand(),
      args: shellArgs(command),
      displayedCommand: command,
    };
  }
  if (process.platform === 'win32') {
    const displayedCommand = commandWithDefaultTimeout(command);
    return {
      command: shellCommand(),
      args: shellArgs(displayedCommand),
      displayedCommand,
    };
  }
  return {
    command: 'timeout',
    args: [DEFAULT_TIMEOUT, shellCommand(), '-lc', command],
    displayedCommand: commandWithDefaultTimeout(command),
  };
}

function shellCommand(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/bash';
}

function shellArgs(command: string): string[] {
  if (process.platform === 'win32') return ['/d', '/s', '/c', command];
  return ['-lc', command];
}

function createLimitedCapture(): {
  append(chunk: Buffer): void;
  value(): string;
  truncated(): boolean;
} {
  let value = '';
  let truncated = false;
  return {
    append(chunk: Buffer): void {
      if (value.length >= MAX_STREAM_CHARS) {
        truncated = true;
        return;
      }
      const text = chunk.toString('utf8');
      const remaining = MAX_STREAM_CHARS - value.length;
      value += text.slice(0, remaining);
      if (text.length > remaining) truncated = true;
    },
    value: () => value,
    truncated: () => truncated,
  };
}

function withTruncationNotice(value: string, truncated: boolean): string {
  if (!truncated) return value;
  return `${value}${value.endsWith(EOL) ? '' : EOL}[output truncated]`;
}

function fenced(value: string, language = ''): string {
  return [`\`\`\`${language}`, value.replace(/```/g, '`\\`\\`'), '```'].join(EOL);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
