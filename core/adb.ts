// Thin adb wrapper over child_process. No npm adb library on purpose (keeps deps lean).
// adb location: MIDSCENE_ADB_PATH → ./tools/platform-tools/adb[.exe] → `adb` on PATH.
// ref: @midscene/core device-options.d.ts — AndroidDeviceOpt.androidAdbPath (same path is passed to Midscene)
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class AdbNotFoundError extends Error {
  constructor(tried: string, cause?: unknown) {
    super(
      `[adb not found] Could not run "${tried}". Install Android platform-tools ` +
        '(see env-plan.md), then either put adb on PATH or set MIDSCENE_ADB_PATH in .env ' +
        'to the full path of adb / adb.exe.',
    );
    this.name = 'AdbNotFoundError';
    this.cause = cause;
  }
}

export function resolveAdbPath(): string {
  const fromEnv = process.env.MIDSCENE_ADB_PATH?.trim();
  if (fromEnv) return fromEnv;
  const local = resolve('tools/platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  if (existsSync(local)) return local;
  return 'adb';
}

function withSerial(args: string[], serial?: string): string[] {
  return serial ? ['-s', serial, ...args] : args;
}

/** Run adb and return stdout as text. Throws AdbNotFoundError if the binary is missing. */
export async function adb(args: string[], serial?: string, timeoutMs = 30_000): Promise<string> {
  const bin = resolveAdbPath();
  try {
    const { stdout } = await execFileAsync(bin, withSerial(args, serial), {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AdbNotFoundError(bin, err);
    throw err;
  }
}

/** Run adb and return raw stdout bytes (for `exec-out screencap -p`). */
export async function adbBuffer(args: string[], serial?: string, timeoutMs = 30_000): Promise<Buffer> {
  const bin = resolveAdbPath();
  try {
    const { stdout } = await execFileAsync(bin, withSerial(args, serial), {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer',
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AdbNotFoundError(bin, err);
    throw err;
  }
}

export function spawnAdb(args: string[], serial?: string): ChildProcessWithoutNullStreams {
  return spawn(resolveAdbPath(), withSerial(args, serial), { windowsHide: true });
}

/** PNG of the current screen. */
export function screencap(serial?: string): Promise<Buffer> {
  return adbBuffer(['exec-out', 'screencap', '-p'], serial);
}

export async function forceStopApp(packageName: string, serial?: string): Promise<void> {
  await adb(['shell', 'am', 'force-stop', packageName], serial);
}

/** Start the app's launcher activity without knowing its activity name. */
export async function launchApp(packageName: string, serial?: string): Promise<void> {
  const out = await adb(
    ['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'],
    serial,
  );
  if (/No activities found to run|monkey aborted/i.test(out)) {
    throw new Error(`Could not launch ${packageName}: no launcher activity (is the app installed?)\n${out}`);
  }
}

/** Crash buffer dump (`adb logcat -b crash -d`). */
export function dumpCrashBuffer(serial?: string): Promise<string> {
  return adb(['logcat', '-b', 'crash', '-d', '-v', 'time'], serial);
}
