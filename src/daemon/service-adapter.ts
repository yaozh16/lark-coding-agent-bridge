import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as launchd from './launchd';
import {
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  launchAgentPlistPath,
  systemdUnitPath,
  windowsTaskName,
} from './paths';
import * as schtasks from './schtasks';
import * as systemd from './systemd';
import { paths } from '../config/paths';

export interface ServiceResult {
  ok: boolean;
  stderr: string;
}

export interface ServiceLaunchOptions {
  workspace?: string;
}

/** Some platforms' restart is sync (spawnSync), others (schtasks) are
 * naturally async. Adapter methods can return either; callers await. */
export type ServiceResultLike = ServiceResult | Promise<ServiceResult>;

/**
 * Platform-agnostic interface over OS service managers (launchd / systemd /
 * schtasks). All methods are best-effort idempotent — calling stop()
 * on an already-stopped service returns ok=true.
 */
export interface ServiceAdapter {
  /** Display name used in error / status messages. */
  readonly platformName: string;

  /** Whether the service file (plist / unit / task) is on disk / registered. */
  fileExists(): boolean;

  /** Whether the service is currently running (process alive). */
  isRunning(): boolean;

  /** Path/name to the service definition (for status output). */
  servicePath(): string;

  /** Write or overwrite the service definition. */
  install(opts?: ServiceLaunchOptions): Promise<void>;

  /** Start the service (enables autostart where applicable). */
  start(opts?: ServiceLaunchOptions): ServiceResultLike;

  /** Stop the service. Does NOT disable autostart on its own. */
  stop(): ServiceResultLike;

  /** Stop + disable autostart. Used by `unregister` flow. */
  stopAndDisableAutostart(): ServiceResultLike;

  /** Restart the running service in place. */
  restart(opts?: ServiceLaunchOptions): ServiceResultLike;

  /** Poll until the service is no longer running, or timeout. */
  waitUntilStopped(timeoutMs?: number): Promise<boolean>;

  /** Remove the service definition from the OS. */
  deleteFile(): Promise<void>;

  /** Raw status output from the underlying tool, for downstream parsing. */
  describeStatus(): string;

  /**
   * Extract pid / last exit code from `describeStatus()` text. Returns
   * undefined for fields the platform doesn't expose or hasn't recorded yet.
   */
  parseStatus(text: string): { pid?: string; lastExit?: string };
}

function makeLaunchdAdapter(profile: string): ServiceAdapter {
  return {
    platformName: 'launchd (macOS)',
    fileExists: () => launchd.plistExists(profile),
    isRunning: () => launchd.isLoaded(profile),
    servicePath: () => launchAgentPlistPath(profile),
    install: (opts) => launchd.writePlist(profile, opts),
    start: () => launchd.bootstrap(profile),
    stop: () => launchd.bootout(profile),
    // launchd has no separate "disable" — bootout already removes the
    // service from launchd, which also nukes KeepAlive / RunAtLoad.
    stopAndDisableAutostart: () => launchd.bootout(profile),
    restart: () => launchd.kickstart(profile),
    waitUntilStopped: (timeoutMs) => launchd.waitUntilUnloaded(profile, timeoutMs),
    deleteFile: () => launchd.deletePlist(profile),
    describeStatus: () => launchd.describeService(profile),
    parseStatus: (text) => ({
      pid: text.match(/pid\s*=\s*(\d+)/)?.[1],
      lastExit: text.match(/last exit code\s*=\s*(-?\d+)/i)?.[1],
    }),
  };
}

function makeSystemdAdapter(profile: string): ServiceAdapter {
  return {
    platformName: 'systemd (Linux user)',
    fileExists: () => systemd.unitExists(profile),
    isRunning: () => systemd.isActive(profile),
    servicePath: () => systemdUnitPath(profile),
    install: async (opts) => {
      await systemd.writeUnit(profile, opts);
      // systemd needs daemon-reload after any unit file change.
      systemd.daemonReload();
    },
    start: () => systemd.enableAndStart(profile),
    stop: () => systemd.stop(profile),
    stopAndDisableAutostart: () => systemd.disableAndStop(profile),
    restart: () => systemd.restart(profile),
    waitUntilStopped: (timeoutMs) => systemd.waitUntilInactive(profile, timeoutMs),
    deleteFile: async () => {
      await systemd.deleteUnit(profile);
      systemd.daemonReload();
    },
    describeStatus: () => systemd.describeService(profile),
    // `systemctl status` includes a "Main PID:" line and an "Active:"
    // line. There's no single "last exit code" field in the standard
    // output but the "Process: <pid> ExecStart=... status=<n>" line on
    // an inactive service exposes it.
    parseStatus: (text) => ({
      pid: text.match(/Main PID:\s*(\d+)/)?.[1],
      lastExit: text.match(/Process:\s+\d+\s+ExecStart=.*status=(\d+)/)?.[1],
    }),
  };
}

function makeDetachedAdapter(profile: string): ServiceAdapter {
  const pidPath = () => join(daemonLogDir(profile), 'detached.pid');
  const readPid = (): number | undefined => {
    try {
      const pid = Number.parseInt(readFileSync(pidPath(), 'utf8').trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  };
  const isPidRunning = (pid: number | undefined): boolean => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  const cleanupDeadPid = (): void => {
    if (!isPidRunning(readPid())) {
      try {
        rmSync(pidPath(), { force: true });
      } catch {
        // Best effort only; stale pidfiles are harmless and overwritten on start.
      }
    }
  };
  const stopPid = (): ServiceResult => {
    const pid = readPid();
    if (!isPidRunning(pid)) {
      cleanupDeadPid();
      return { ok: true, stderr: '' };
    }
    try {
      process.kill(pid!, 'SIGTERM');
      return { ok: true, stderr: '' };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        cleanupDeadPid();
        return { ok: true, stderr: '' };
      }
      return { ok: false, stderr: String((err as Error).message ?? err) };
    }
  };

  return {
    platformName: 'detached process (Linux)',
    fileExists: () => existsSync(pidPath()),
    isRunning: () => {
      const running = isPidRunning(readPid());
      if (!running) cleanupDeadPid();
      return running;
    },
    servicePath: () => pidPath(),
    install: async () => {
      await mkdir(daemonLogDir(profile), { recursive: true });
    },
    start: (opts) => {
      const bridgeEntryPath = process.argv[1];
      if (!bridgeEntryPath) {
        return { ok: false, stderr: 'cannot determine bridge entry path (process.argv[1] is empty)' };
      }
      const stdout = openSync(daemonStdoutPath(profile), 'a');
      const stderr = openSync(daemonStderrPath(profile), 'a');
      try {
        const args = [bridgeEntryPath, 'run', '--profile', profile];
        if (opts?.workspace) args.push('--workspace', opts.workspace);
        const child = spawn(process.execPath, args, {
          detached: true,
          stdio: ['ignore', stdout, stderr],
          env: {
            ...process.env,
            PATH: process.env.PATH ?? '',
            LARK_CHANNEL_HOME: paths.rootDir,
          },
        });
        child.unref();
        writeFileSync(pidPath(), `${child.pid}\n`, { mode: 0o600 });
        return { ok: true, stderr: '' };
      } catch (err) {
        return { ok: false, stderr: String((err as Error).message ?? err) };
      } finally {
        closeSync(stdout);
        closeSync(stderr);
      }
    },
    stop: stopPid,
    stopAndDisableAutostart: () => {
      const result = stopPid();
      if (result.ok) rmSync(pidPath(), { force: true });
      return result;
    },
    restart: async (opts) => {
      const stopped = stopPid();
      if (!stopped.ok) return stopped;
      await waitFor(() => !isPidRunning(readPid()), 5000);
      return makeDetachedAdapter(profile).start(opts);
    },
    waitUntilStopped: (timeoutMs) => waitFor(() => !isPidRunning(readPid()), timeoutMs ?? 5000),
    deleteFile: () => rm(pidPath(), { force: true }),
    describeStatus: () => {
      const pid = readPid();
      return [
        `Detached PID: ${pid ?? '-'}`,
        `Active: ${isPidRunning(pid) ? 'active' : 'inactive'}`,
        `Stdout: ${daemonStdoutPath(profile)}`,
        `Stderr: ${daemonStderrPath(profile)}`,
      ].join('\n');
    },
    parseStatus: (text) => ({
      pid: text.match(/Detached PID:\s*(\d+)/)?.[1],
    }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return predicate();
}

function hasSystemdUserBus(): boolean {
  return Boolean(process.env.DBUS_SESSION_BUS_ADDRESS || process.env.XDG_RUNTIME_DIR);
}

function makeSchtasksAdapter(profile: string): ServiceAdapter {
  return {
    platformName: 'Task Scheduler (Windows)',
    fileExists: () => schtasks.isTaskRegistered(profile),
    isRunning: () => schtasks.isTaskRunning(profile),
    // Windows doesn't have a single "service file" — there's the task
    // registration (queryable via schtasks) and the launcher .cmd we wrote.
    // The task name is what the user would search for in Task Scheduler UI.
    servicePath: () => windowsTaskName(profile),
    install: async (opts) => {
      const r = await schtasks.installTask(profile, opts);
      if (!r.ok) throw new Error(r.stderr || 'schtasks /Create failed');
    },
    start: () => schtasks.runTask(profile),
    stop: () => schtasks.endTask(profile),
    stopAndDisableAutostart: () => schtasks.endAndDisable(profile),
    // schtasks has no native /Restart — adapter awaits end+wait+run.
    restart: () => schtasks.restartTask(profile),
    waitUntilStopped: (timeoutMs) => schtasks.waitUntilStopped(profile, timeoutMs),
    deleteFile: async () => {
      await schtasks.deleteTask(profile);
    },
    describeStatus: () => schtasks.describeTask(profile),
    parseStatus: (text) => ({
      // `Process ID: <n>` shows up in verbose listing only when task is running.
      pid: text.match(/Process ID:\s*(\d+)/i)?.[1],
      // `Last Result: <0|nonzero>` — `0` means last run succeeded.
      // Filter the `1056` ("task already running") and `267011` ("task hasn't
      // run") sentinels that aren't real exit codes.
      lastExit: text.match(/Last Result:\s*(\d+)/i)?.[1],
    }),
  };
}

/**
 * Return the right adapter for the current platform, or null if this OS
 * isn't supported. Callers should null-check and surface a friendly error.
 */
export function getServiceAdapter(profile = 'claude'): ServiceAdapter | null {
  if (process.platform === 'darwin') return makeLaunchdAdapter(profile);
  if (process.platform === 'linux') {
    return hasSystemdUserBus() ? makeSystemdAdapter(profile) : makeDetachedAdapter(profile);
  }
  if (process.platform === 'win32') return makeSchtasksAdapter(profile);
  return null;
}
