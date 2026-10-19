// Path B — one Android Monkey run with a fixed seed, logcat monitor in parallel.
//   adb shell monkey -p <pkg> -s <seed> --throttle <ms> --randomize-throttle 100 -vvv
//         --ignore-crashes --ignore-timeouts --monitor-native-crashes <count>   > monkey.log
// Crash verdict: logcat FATAL EXCEPTION / ANR in (week-2 LogcatMonitor) is primary; monkey.log
// CRASH: / NOT RESPONDING: is the cross-check (see log-parser.ts).
// No Midscene dependency on purpose (works without model credentials).
// ref: none in ref/; flags per https://developer.android.com/studio/test/other-testing-tools/monkey
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnAdb } from '../core/adb';
import { type CrashEvent, startLogcatMonitor } from '../core/logcat-monitor';

export interface MonkeyOptions {
  packageName: string;
  deviceId?: string;
  seed?: number;
  eventCount?: number;
  throttle?: number;
  outputDir: string;
  /** Default true: keep injecting after a crash/ANR (logcat still captures it). */
  ignoreErrors?: boolean;
}

export interface MonkeyResult {
  seed: number;
  eventCount: number;
  exitCode: number | null;
  crashesDetected: number;
  logPath: string;
  crashArtifactDirs: string[];
  crashes: CrashEvent[];
  reproduceCommand: string;
  startedAt: string;
  durationMs: number;
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/** `monkey` arguments (after `adb shell`). Pure, exported for tests and the repro command. */
export function monkeyArgs(o: Required<Pick<MonkeyOptions, 'packageName' | 'seed' | 'eventCount' | 'throttle'>> & { ignoreErrors?: boolean }): string[] {
  return [
    'monkey',
    '-p', o.packageName,
    '-s', String(o.seed),
    '--throttle', String(o.throttle),
    '--randomize-throttle', '100',
    '-vvv',
    ...(o.ignoreErrors === false ? [] : ['--ignore-crashes', '--ignore-timeouts', '--monitor-native-crashes']),
    String(o.eventCount),
  ];
}

export function reproduceCommand(args: string[], deviceId?: string): string {
  return `adb ${deviceId ? `-s ${deviceId} ` : ''}shell ${args.join(' ')}`;
}

export async function runMonkey(options: MonkeyOptions): Promise<MonkeyResult> {
  const seed = options.seed ?? randomSeed();
  const eventCount = options.eventCount ?? 5000;
  const throttle = options.throttle ?? 300;
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const logPath = join(outputDir, 'monkey.log');
  const args = monkeyArgs({ packageName: options.packageName, seed, eventCount, throttle, ignoreErrors: options.ignoreErrors });
  const repro = reproduceCommand(args, options.deviceId);
  const startedAt = new Date();
  console.log(`[monkey] seed=${seed} events=${eventCount} throttle=${throttle}ms → ${logPath}`);
  console.log(`[monkey] ${repro}`);

  const monitor = startLogcatMonitor({
    udid: options.deviceId,
    packageName: options.packageName,
    extraContext: { source: 'monkey', seed, reproduceCommand: repro, monkeyLog: logPath },
    onCrash: (e) => console.log(`[monkey] logcat captured ${e.keywords.join('+')} → ${e.dir}`),
  });

  const out = createWriteStream(logPath);
  const child = spawnAdb(['shell', ...args], options.deviceId);
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  const exitCode = await new Promise<number | null>((res) => {
    child.on('error', (err) => {
      out.write(`\n<adb spawn failed: ${err.message}>\n`);
      res(null);
    });
    child.on('close', (code) => res(code));
  });
  await new Promise<void>((r) => out.end(r));
  // Let the monitor finish a capture that started near the end of the run.
  await new Promise((r) => setTimeout(r, 3_500));
  await monitor.stop();

  const crashes = monitor.crashes.filter((c) => c.matchesPackage);
  return {
    seed,
    eventCount,
    exitCode,
    crashesDetected: crashes.length,
    logPath,
    crashArtifactDirs: crashes.map((c) => c.dir),
    crashes: monitor.crashes,
    reproduceCommand: repro,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  };
}
