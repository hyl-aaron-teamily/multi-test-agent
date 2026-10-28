// Offline unit test for core/logcat-monitor.ts: feeds logcat text through the `source` test seam.
// Proves detection + artifact layout without a device. It does NOT replace the on-device check
// (pnpm loop:android with CRASH_AT_ITERATION), which needs a real device.
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { type CrashEvent, detectCrashSignal, startLogcatMonitor } from './logcat-monitor';

// Line format of `adb logcat -v time`.
const FATAL = [
  '10-19 13:40:01.120 I/ActivityManager( 1234): Start proc 4321:com.example.app/u0a123',
  '--------- beginning of crash',
  '10-19 13:40:02.001 E/AndroidRuntime( 4321): FATAL EXCEPTION: main',
  '10-19 13:40:02.001 E/AndroidRuntime( 4321): Process: com.example.app, PID: 4321',
  '10-19 13:40:02.001 E/AndroidRuntime( 4321): java.lang.IllegalStateException: boom',
  '10-19 13:40:02.001 E/AndroidRuntime( 4321): \tat com.example.app.MainActivity.onClick(MainActivity.java:42)',
];
const ANR = '10-19 13:41:00.000 E/ActivityManager( 1234): ANR in com.example.app (com.example.app/.MainActivity)';

let outDir: string | undefined;
afterEach(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
  outDir = undefined;
});

async function feed(lines: string[], packageName?: string) {
  outDir = await mkdtemp(join(tmpdir(), 'logcat-monitor-'));
  const source = new PassThrough();
  const seen: CrashEvent[] = [];
  const monitor = startLogcatMonitor({
    udid: 'emulator-5554',
    packageName,
    outputDir: outDir,
    source,
    captureScreenshot: async () => Buffer.from('fake-png'),
    dumpCrashBuffer: async () => FATAL.slice(1).join('\n'),
    onCrash: (e) => void seen.push(e),
  });
  monitor.setContext({ iteration: 3, step: '2. Open "About phone"' });
  for (let i = 0; i < 250; i++) source.write(`10-19 13:39:00.000 D/Noise( 1): line ${i}\n`);
  for (const l of lines) source.write(`${l}\n`);
  source.end();
  await monitor.stop();
  return { monitor, seen };
}

describe('logcat monitor (offline)', () => {
  it('detects the required keywords', () => {
    expect(detectCrashSignal(FATAL[2])).toBe('FATAL EXCEPTION');
    expect(detectCrashSignal(ANR)).toBe('ANR in');
    expect(detectCrashSignal('--------- beginning of crash')).toBe('beginning of crash');
    expect(detectCrashSignal('10-19 D/Foo( 1): all good')).toBeUndefined();
  });

  it('saves screenshot.png, logcat.txt and context.json for a FATAL EXCEPTION', async () => {
    const { monitor, seen } = await feed(FATAL, 'com.example.app');
    expect(monitor.crashes).toHaveLength(1); // marker + FATAL lines grouped into one event
    expect(seen).toHaveLength(1);
    const crash = monitor.crashes[0];
    expect(crash.keywords).toEqual(expect.arrayContaining(['beginning of crash', 'FATAL EXCEPTION']));
    expect(crash.matchesPackage).toBe(true);
    for (const f of ['screenshot.png', 'logcat.txt', 'context.json']) {
      expect(existsSync(join(crash.dir, f))).toBe(true);
    }
    const logcat = readFileSync(join(crash.dir, 'logcat.txt'), 'utf8');
    expect(logcat).toContain('line 249'); // lines before the hit
    expect(logcat).not.toContain('line 49\n'); // only the last 200 lines before are kept
    expect(logcat).toContain('IllegalStateException: boom');
    expect(logcat).toContain('# ---- adb logcat -b crash -d ----');
    const ctx = JSON.parse(readFileSync(join(crash.dir, 'context.json'), 'utf8'));
    expect(ctx).toMatchObject({
      iteration: 3,
      udid: 'emulator-5554',
      packageName: 'com.example.app',
      step: '2. Open "About phone"',
    });
    expect(ctx.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('flags crashes from other packages via the Process: marker', async () => {
    const { monitor } = await feed(FATAL, 'com.android.settings');
    expect(monitor.crashes).toHaveLength(1);
    expect(monitor.crashes[0].matchesPackage).toBe(false);
  });

  it('captures ANR and ignores clean logs', async () => {
    expect((await feed([ANR])).monitor.crashes[0].keywords).toEqual(['ANR in']);
    expect((await feed([])).monitor.crashes).toHaveLength(0);
  });
});
