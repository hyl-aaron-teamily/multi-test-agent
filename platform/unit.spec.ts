// Pure-function checks for the platform layer.
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAdbDevices } from './adb-devices';
import { DevicePool, parsePoolConfig } from './device-pool';
import { safeFilePath } from './server';
import { type Task, taskArgs, validateTaskInput } from './tasks';

describe('platform', () => {
  it('parses adb devices -l', () => {
    const out = 'List of devices attached\n4f2ebdf2  device usb:1-1 product:fuxi model:2211133C device:fuxi\nemulator-5554 offline\n\n';
    expect(parseAdbDevices(out)).toEqual([
      { udid: '4f2ebdf2', state: 'device', model: '2211133C', product: 'fuxi' },
      { udid: 'emulator-5554', state: 'offline', model: undefined, product: undefined },
    ]);
  });

  it('parses devices.yaml and enforces maxConcurrent', async () => {
    const pool = new DevicePool();
    pool.config = parsePoolConfig('maxConcurrent: 1\ndevices:\n  - udid: a\n  - udid: b\n');
    await pool.refresh([{ udid: 'a', state: 'device' }, { udid: 'b', state: 'device' }]);
    expect(pool.acquire('t1')?.udid).toBe('a');
    expect(pool.acquire('t2')).toBeNull(); // concurrency 1
    pool.config.maxConcurrent = 2;
    expect(pool.acquire('t2')?.udid).toBe('b');
    pool.release('a');
    expect(pool.list().find((d) => d.udid === 'a')?.status).toBe('idle');
    await pool.refresh([{ udid: 'a', state: 'device' }]);
    expect(pool.list().find((d) => d.udid === 'b')?.status).toBe('busy'); // busy survives heartbeat
  });

  it('validates task input', () => {
    expect(validateTaskInput({ type: 'mission', package: 'ai.teamily.mobile' })).toMatch(/request/);
    expect(validateTaskInput({ type: 'rm -rf', package: 'a.b' })).toMatch(/type/);
    expect(validateTaskInput({ type: 'monkey', package: 'a.b; reboot' })).toMatch(/package/);
    expect(validateTaskInput({ type: 'monkey', package: 'a.b', seed: '7' })).toEqual({ type: 'monkey', package: 'a.b', seed: 7 });
  });

  it('builds CLI args without a shell', () => {
    const t = { id: 't1', type: 'mission', package: 'a.b', request: '聊天 "闪退"', maxMinutes: 5 } as Task;
    expect(taskArgs(t, 'dev')).toEqual(['bin/autotest.ts', 'mission', '聊天 "闪退"', '--id', 't1', '--package', 'a.b', '--device', 'dev', '--max-minutes', '5']);
  });

  it('imui tasks need a conversation and map to imui run with the pool device', () => {
    expect(validateTaskInput({ type: 'imui', package: 'ai.teamily.mobile' })).toMatch(/conversation/);
    expect(validateTaskInput({ type: 'imui', package: 'a.b', conversation: 'x', rate: 5 })).toMatch(/rate/);
    const v = validateTaskInput({ type: 'imui', package: 'a.b', conversation: "A's AI", web: 'test', duration: 30, rate: 0.2, msgTypes: 'text,long', yesProd: true });
    expect(typeof v).toBe('object');
    expect(taskArgs({ ...(v as object), id: 't9' } as Task, 'dev1')).toEqual([
      'bin/autotest.ts', 'imui', 'run', '--client', "android:dev1@A's AI", '--client', "web:test@A's AI",
      '--duration', '30', '--rate', '0.2', '--msg-types', 'text,long', '--yes-prod',
    ]);
  });

  it('keeps /files inside midscene_run', () => {
    const root = resolve('midscene_run');
    expect(safeFilePath(root, 'missions/x/report.md')).toBe(`${root}${sep}missions${sep}x${sep}report.md`);
    expect(safeFilePath(root, '../.env')).toBeUndefined();
    expect(safeFilePath(root, '..%2F.env')).toBeUndefined();
  });
});
