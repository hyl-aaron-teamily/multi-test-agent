// W2-5 §9: the platform answers at once after a start; environment checks run in the background and
// submissions in the meantime are queued with a note instead of failing.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let release: () => void = () => {};
vi.mock('./lifecycle/check', async (orig) => ({
  ...(await orig<typeof import('./lifecycle/check')>()),
  checkEnv: vi.fn(() => new Promise((res) => (release = () => res({ env: { state: 'ready' } })))),
}));

const { Supervisor } = await import('./lifecycle/supervisor');
const { getEnv, moveEnv, registerEnv } = await import('./lifecycle/env');
const { checkingNote } = await import('./api-v1');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w2m5-start-'));
  process.env.AUTOTEST_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.AUTOTEST_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('platform start (W2-5 §9)', () => {
  it('start() returns before the environment checks finish; free environments show as checking meanwhile', async () => {
    const ENV = 'desktop-web:edge@prod';
    registerEnv({ id: ENV, surface: 'desktop-web', serviceEnv: 'prod', device: 'edge', configItems: [] });
    moveEnv(ENV, 'checking', { by: 't', basis: 'x' });
    moveEnv(ENV, 'ready', { by: 't', basis: 'x' });
    const devices = { config: { devices: [], hosts: [], maxConcurrent: 1 }, refresh: async () => {}, acquire: () => {} } as any;
    const sup = new Supervisor(devices, { list: () => [] } as any);
    let started = false;
    await Promise.race([sup.start().then(() => (started = true)), new Promise((r) => setTimeout(r, 2000))]);
    expect(started).toBe(true);
    expect(getEnv(ENV)!.state).toBe('checking');
    expect(checkingNote([getEnv(ENV)!])).toBe(`（环境检查中：${ENV}；检查通过后开始）`);
    expect(checkingNote([{ id: 'x', state: 'ready' }])).toBe('');
    release();
    await sup.startupChecks;
    await sup.shutdown();
  });
});
