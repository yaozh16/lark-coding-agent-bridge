import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { LarkChannel } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { ProfileConfig } from '../config/profile-schema';
import { log } from '../core/logger';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 3000;

const MEMORY_CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.cursorrules',
  '.cursor/rules',
];

export interface StartupStatusInput {
  channel: LarkChannel;
  ownerOpenId?: string;
  profile: string;
  agent: AgentAdapter;
  profileConfig: ProfileConfig;
}

export async function sendStartupStatus(input: StartupStatusInput): Promise<void> {
  const ownerOpenId = input.ownerOpenId;
  if (!ownerOpenId) {
    log.warn('startup-status', 'skip', { reason: 'missing-owner-open-id' });
    return;
  }

  const workspace = input.profileConfig.workspaces.default;
  if (!workspace) {
    log.warn('startup-status', 'skip', { reason: 'missing-workspace' });
    return;
  }

  const [memory, git] = await Promise.all([
    inspectMemory(workspace),
    inspectGit(workspace),
  ]);

  const markdown = renderStartupStatus({
    profile: input.profile,
    agent: `${input.agent.displayName} (${input.agent.id})`,
    workspace,
    memory,
    git,
  });

  try {
    await input.channel.send(ownerOpenId, { markdown });
    log.info('startup-status', 'sent', {
      profile: input.profile,
      ownerOpenId,
      workspace,
      memoryCount: memory.files.length,
      gitBranch: git.branch,
      gitDirty: git.dirty,
    });
  } catch (err) {
    log.warn('startup-status', 'send-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface MemoryStatus {
  files: string[];
}

async function inspectMemory(workspace: string): Promise<MemoryStatus> {
  const files: string[] = [];
  await Promise.all(
    MEMORY_CANDIDATES.map(async (candidate) => {
      try {
        await stat(join(workspace, candidate));
        files.push(candidate);
      } catch {
        // Missing memory files are normal.
      }
    }),
  );
  files.sort();
  return { files };
}

export interface GitStatus {
  available: boolean;
  branch?: string;
  head?: string;
  dirty?: boolean;
  changedFiles?: number;
  error?: string;
}

async function inspectGit(workspace: string): Promise<GitStatus> {
  const inside = await git(workspace, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) return { available: false };
  if (inside.stdout.trim() !== 'true') return { available: false };

  const [branch, head, status] = await Promise.all([
    git(workspace, ['branch', '--show-current']),
    git(workspace, ['rev-parse', '--short', 'HEAD']),
    git(workspace, ['status', '--porcelain']),
  ]);

  const branchName = branch.ok ? branch.stdout.trim() : '';
  const headSha = head.ok ? head.stdout.trim() : undefined;
  const statusLines = status.ok
    ? status.stdout.split('\n').filter((line) => line.trim().length > 0)
    : [];

  const errors = [
    branch.ok ? undefined : branch.error,
    head.ok ? undefined : head.error,
    status.ok ? undefined : status.error,
  ].filter((error): error is string => Boolean(error));

  return {
    available: true,
    branch: branchName || (headSha ? `detached@${headSha}` : undefined),
    head: headSha,
    dirty: status.ok ? statusLines.length > 0 : undefined,
    changedFiles: status.ok ? statusLines.length : undefined,
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  };
}

async function git(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    return { ok: true, stdout };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function renderStartupStatus(input: {
  profile: string;
  agent: string;
  workspace: string;
  memory: MemoryStatus;
  git: GitStatus;
}): string {
  const memoryText = input.memory.files.length > 0
    ? input.memory.files.join(', ')
    : '未检测到 AGENTS.md / CLAUDE.md 等 memory 文件';
  const gitText = input.git.available
    ? [
        input.git.branch ? `分支 ${input.git.branch}` : '分支未知',
        input.git.head ? `HEAD ${input.git.head}` : undefined,
        input.git.dirty === undefined
          ? undefined
          : input.git.dirty
            ? `有未提交变更 (${input.git.changedFiles ?? 0})`
            : '工作区干净',
      ].filter(Boolean).join('，')
    : `未检测到 git 仓库${input.git.error ? `：${shortError(input.git.error)}` : ''}`;

  const rows: Array<[string, string]> = [
    ['Profile', input.profile],
    ['Agent', input.agent],
    ['Workspace', input.workspace],
    ['Memory', memoryText],
    ['Git', gitText],
  ];

  return [
    '**Bridge 已启动**',
    '',
    '| 项目 | 状态 |',
    '| --- | --- |',
    ...rows.map(([key, value]) => `| ${escapeTableCell(key)} | ${escapeTableCell(value)} |`),
  ].join('\n');
}

function shortError(error: string): string {
  const firstLine = error.split('\n')[0] ?? error;
  return basename(firstLine).slice(0, 160);
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}
