import { describe, expect, it } from 'vitest';
import { diagnose, doctorText, type Facts } from './doctor';

const base = (): Facts => ({
  node: { version: '22.1.0', missing: [] },
  platform: { up: true, url: 'http://localhost:3210/api/v1' },
  model: { text: true, vision: true },
  adb: { ok: true, path: 'adb', version: 'Android Debug Bridge version 1.0.41' },
  devices: [{ udid: '4f2ebdf2', state: 'device', model: '2211133C', declared: true, locked: false, awake: true, backend: 'uiautomator' }],
  recorder: { scrcpy: true },
  envs: [{ id: 'android-app:4f2ebdf2@prod', state: 'ready' }],
  stale: { locks: [], forwards: [], leases: [] },
});

describe('platform/doctor diagnose (W2-4 T5: four cases)', () => {
  it('all fine → ready, OK, no next steps', () => {
    const d = diagnose(base());
    expect(d.conclusion).toBe('ready');
    expect(d.code).toBe('OK');
    expect(d.next).toEqual([]);
  });
  it('phone locked → blocked 51, a person unlocks (never the tool)', () => {
    const f = base();
    f.devices[0].locked = true;
    const d = diagnose(f);
    expect(d).toMatchObject({ conclusion: 'blocked', code: 'ENV_LOCKED' });
    expect(d.next).toEqual([{ kind: 'human', text: expect.stringMatching(/请解锁手机 4f2ebdf2/) }]);
  });
  it('USB debugging not authorised → blocked 52, a person taps 允许; no adb kill-server anywhere', () => {
    const f = base();
    f.devices[0].state = 'unauthorized';
    const d = diagnose(f);
    expect(d).toMatchObject({ conclusion: 'blocked', code: 'ENV_OFFLINE' });
    expect(d.next[0]).toMatchObject({ kind: 'human', text: expect.stringMatching(/允许 USB 调试/) });
    expect(JSON.stringify(d)).not.toMatch(/kill-server/);
  });
  it('no model configured → degraded (runs still possible), next = configure .env (presence only, no values)', () => {
    const f = base();
    f.model = { text: false, vision: false };
    const d = diagnose(f);
    expect(d).toMatchObject({ conclusion: 'degraded', code: 'OK' });
    expect(d.next[0]).toMatchObject({ kind: 'human', text: expect.stringMatching(/MIDSCENE_MODEL_API_KEY/) });
  });
  it('platform down → blocked 54 with the start command', () => {
    const f = base();
    f.platform.up = false;
    const d = diagnose(f);
    expect(d).toMatchObject({ conclusion: 'blocked', code: 'PLATFORM_DOWN' });
    expect(d.next).toEqual([{ kind: 'run', text: expect.any(String), cmd: 'pnpm platform' }]);
  });
  it('next steps follow dependency order (device before platform before model)', () => {
    const f = base();
    f.devices[0].locked = true;
    f.platform.up = false;
    f.model.vision = false;
    const d = diagnose(f);
    expect(d.code).toBe('ENV_LOCKED');
    expect(d.next.map((x) => x.cmd ?? x.kind)).toEqual(['human', 'pnpm platform', 'human']);
  });
  it('one of two phones locked → degraded, not blocked', () => {
    const f = base();
    f.devices.push({ udid: 'b2', state: 'device', declared: true, locked: true, backend: 'uiautomator' });
    expect(diagnose(f).conclusion).toBe('degraded');
  });
  it('tree service declared but not answering → degraded with the fallback said', () => {
    const f = base();
    f.devices[0].backend = 'a11y-service';
    f.devices[0].a11y = { installed: true, enabled: true, responding: false, detail: '已启用但不响应' };
    const d = diagnose(f);
    expect(d.conclusion).toBe('degraded');
    expect(doctorText(d)).toMatch(/退回 uiautomator/);
  });
  it('stale leftovers → suggest doctor --fix', () => {
    const f = base();
    f.stale.locks = ['env-x.lock'];
    expect(diagnose(f).next).toEqual([expect.objectContaining({ cmd: 'pnpm autotest doctor --fix' })]);
  });
});

describe('platform/doctor --fix (local side only)', () => {
  it('removes stale lock files and reports what it did', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'doctor-'));
    process.env.AUTOTEST_STATE_DIR = dir;
    try {
      mkdirSync(join(dir, 'locks'));
      const f = join(dir, 'locks', 'env-x.lock');
      writeFileSync(f, '');
      const old = new Date(Date.now() - 5 * 60_000);
      utimesSync(f, old, old);
      const { fixStale } = await import('./doctor');
      const facts = { ...base(), stale: { locks: ['env-x.lock'], forwards: [], leases: [] } };
      expect(await fixStale(facts)).toEqual(['删除残留锁 env-x.lock']);
      expect(existsSync(f)).toBe(false);
    } finally {
      delete process.env.AUTOTEST_STATE_DIR;
    }
  });
});
