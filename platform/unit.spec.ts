// Pure-function checks for the platform layer.
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAdbDevices } from './adb-devices';
import { DevicePool, parsePoolConfig } from './device-pool';
import { safeFilePath } from './server';

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

  it('one phone runs its app and its browser for one task; the host has its own slots', async () => {
    const pool = new DevicePool();
    pool.config = parsePoolConfig('maxConcurrent: 1\ndevices:\n  - udid: ph1\n    surfaces: [android-app, android-web]\n    accounts: { android-app: p1, android-web: p3 }\nhosts:\n  - id: local\n    surfaces: { desktop-web: 1, mobile-web: 2 }\n');
    await pool.refresh([{ udid: 'ph1', state: 'device' }]);
    expect(pool.list().map((d) => `${d.udid}:${d.kind}`)).toEqual(['ph1:android', 'host:local:host']);
    expect(pool.acquire('t1', undefined, 'android-app')?.udid).toBe('ph1');
    expect(pool.acquire('t1', undefined, 'android-web')?.udid).toBe('ph1'); // same task: no second budget unit
    expect(pool.acquire('t2', undefined, 'android-web')).toBeNull(); // slot taken (and budget 1)
    expect(pool.acquire('t1', undefined, 'desktop-web')?.udid).toBe('host:local');
    expect(pool.acquire('t2', undefined, 'desktop-web')).toBeNull(); // capacity 1
    expect(pool.get('ph1')?.accounts['android-web']).toBe('p3');
    pool.release('ph1', 'android-app', 't1');
    expect(pool.get('ph1')?.status).toBe('busy'); // the browser slot is still held
    pool.release('ph1', undefined, 't1');
    expect(pool.get('ph1')?.status).toBe('idle');
  });

  it('a leased phone survives a heartbeat without it; one release frees one slot of a task', async () => {
    const pool = new DevicePool();
    pool.config = parsePoolConfig('maxConcurrent: 2\nhosts:\n  - id: local\n    surfaces: { desktop-web: 2 }\n');
    await pool.refresh([{ udid: 'ph1', state: 'device' }]); // undeclared phones come from adb
    expect(pool.acquire('t1', undefined, 'android-app')?.udid).toBe('ph1');
    await pool.refresh([]); // adb lost the phone for one beat
    expect(pool.get('ph1')?.leases['android-app']).toEqual(['t1']);
    await pool.refresh([{ udid: 'ph1', state: 'device' }]);
    expect(pool.acquire('t2', undefined, 'android-app')).toBeNull(); // still taken
    pool.acquire('t1', undefined, 'desktop-web');
    pool.acquire('t1', undefined, 'desktop-web'); // two desktop roles of one sync task
    pool.release('host:local', 'desktop-web', 't1');
    expect(pool.get('host:local')?.leases['desktop-web']).toEqual(['t1']);
  });

  it('declared phones default to app + browser; the host defaults to this computer', () => {
    const c = parsePoolConfig('devices:\n  - udid: a\n');
    expect(Object.keys(c.devices[0].capacity)).toEqual(['android-app', 'android-web']);
    expect(c.hosts.map((h) => h.udid)).toEqual(['host:local']);
  });

  it('keeps /files inside midscene_run', () => {
    const root = resolve('midscene_run');
    expect(safeFilePath(root, 'missions/x/report.md')).toBe(`${root}${sep}missions${sep}x${sep}report.md`);
    expect(safeFilePath(root, '../.env')).toBeUndefined();
    expect(safeFilePath(root, '..%2F.env')).toBeUndefined();
  });
});
