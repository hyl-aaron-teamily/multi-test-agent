// W2-4.1 T7 (device-free): multi-environment leases (all or none), the v1 task type `sync`, its outcome codes,
// and multi-account Issues planned as multi-role plans.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SyncResult } from '../engine/plan/sync';
import { syncSubcase } from '../issue/planner';
import type { NormalizedIssue } from '../issue/parse';
import { validatePlan } from '../issue/validate';
import { syncCode } from '../scripts/task-exec';
import { apiV1 } from './api-v1';
import { messageBound } from './approval';
import { getEnv, moveEnv, registerEnv } from './lifecycle/env';
import { getTask } from './lifecycle/task';
import { Supervisor } from './lifecycle/supervisor';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w2m41s-'));
  process.env.AUTOTEST_STATE_DIR = dir;
  process.env.AUTOTEST_POLICY_FILE = join(dir, 'no-policy.yaml');
});
afterEach(() => {
  delete process.env.AUTOTEST_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const call = (method: string, path: string, body: any = {}) => apiV1({ method, path: `/api/v1${path}`, query: new URL(`http://x${path}`).searchParams, body, web: false }, {});
const WEB = 'desktop-web:edge@prod';
const APP = 'android-app:p1@prod';
const AWEB = 'android-web:p1@prod';
const ready = (id: string, surface: string, udid?: string) => {
  registerEnv({ id, surface: surface as any, serviceEnv: 'prod', device: udid ?? 'edge', udid, configItems: [] });
  moveEnv(id, 'checking', { by: 't', basis: 'x' });
  moveEnv(id, 'ready', { by: 't', basis: 'x' });
};

/** A supervisor whose phone pool is a stub and whose launches are recorded (no process is spawned). */
function supervisor() {
  const held = new Map<string, string>();
  const devices = { refresh: async () => {}, get: (u: string) => ({ udid: u, status: held.has(u) ? 'busy' : 'idle' }), acquire: (t: string, u: string) => void held.set(u, t), release: () => {} } as any;
  const sup = new Supervisor(devices, {} as any);
  const launched: string[] = [];
  (sup as any).launch = (id: string) => launched.push(id);
  (sup as any).lastRecheck = Date.now() + 3_600_000; // no real environment checks in a unit test
  return { sup, launched };
}

describe('W2-4.1 T7 multi-client sync', () => {
  it('--sync: every environment of the task or none', async () => {
    ready(WEB, 'desktop-web');
    ready(APP, 'android-app', 'p1');
    expect((await call('POST', '/tasks', { sync: 'desktop-web' })).code).toBe('BAD_INPUT');
    expect((await call('POST', '/tasks', { sync: 'desktop-web,desktop-web' })).code).toBe('BAD_INPUT');
    expect((await call('POST', '/tasks', { sync: 'desktop-web,mobile-web' })).code).toBe('ENV_OFFLINE');
    expect((await call('POST', '/tasks', { sync: 'desktop-web,android-app', rounds: 60 })).code).toBe('APPROVAL_REQUIRED'); // > 50 messages, full access off
    expect((await call('POST', '/tasks', { sync: 'desktop-web,android-app', dryRun: true })).code).toBe('OK');
    const a = await call('POST', '/tasks', { sync: 'desktop-web,android-app', rounds: 4 });
    expect(a.code).toBe('ACCEPTED');
    const id = (a.data as any).id;
    expect(getTask(id)).toMatchObject({ kind: 'sync', envId: WEB, envIds: [APP], sync: { rounds: 4 }, planId: 'sync:desktop-web+android-app' });
    expect((a.data as any).summary).toMatch(/多端同步 4 轮 @ desktop-web:edge@prod \+ android-app:p1@prod/);

    // The phone environment is busy: nothing is leased, the web one stays ready.
    moveEnv(APP, 'checking', { by: 't', basis: 'x' });
    const { sup, launched } = supervisor();
    await sup.tick();
    expect(launched).toEqual([]);
    expect(getEnv(WEB)!.state).toBe('ready');
    moveEnv(APP, 'ready', { by: 't', basis: 'x' });
    await sup.tick();
    expect(launched).toEqual([id]);
    expect([getEnv(WEB)!.lease?.taskId, getEnv(APP)!.lease?.taskId]).toEqual([id, id]);
  });

  it('a sync task may hold the App and the browser of one phone; another task on that phone waits', async () => {
    ready(APP, 'android-app', 'p1');
    ready(AWEB, 'android-web', 'p1');
    ready(WEB, 'desktop-web');
    const s = (await call('POST', '/tasks', { sync: `${APP},${AWEB}` })).data as any;
    const { sup, launched } = supervisor();
    await sup.tick();
    expect(launched).toEqual([s.id]);
    // The phone is held: a second task using it is accepted but waits, and none of its environments is leased.
    const s2 = await call('POST', '/tasks', { sync: 'desktop-web,android-app' });
    expect(s2.code).toBe('ACCEPTED');
    await sup.tick();
    expect(launched).toEqual([s.id]);
    expect(getEnv(WEB)!.state).toBe('ready');
    expect(getTask((s2.data as any).id)!.state).toBe('waiting-env');
  });

  it('outcome codes: plain check 已实现 / 未实现, multi-role Issue plan 未复现 / 已复现', () => {
    const r = (conclusion: SyncResult['conclusion'], extra: Partial<SyncResult> = {}) => ({ conclusion, roles: [], rounds: [{} as any], ...extra });
    expect(syncCode(r('全部同步'), false)).toBe('IMPLEMENTED');
    expect(syncCode(r('存在未同步'), false)).toBe('NOT_IMPLEMENTED');
    expect(syncCode(r('全部同步'), true)).toBe('NOT_REPRODUCED');
    expect(syncCode(r('存在未同步'), true)).toBe('REPRODUCED');
    expect(syncCode(r('执行失败', { cancelled: true }), false)).toBe('CANCELLED');
    expect(syncCode(r('执行失败', { rounds: [], roles: [{ id: 'a', surface: 'desktop-web', endpoint: '-', account: 'x', ready: false, error: 'conversation "Bob" is not on the allow list (G3): nothing is sent there' }] }), false)).toBe('PLAN_NOT_EXECUTABLE');
    expect(syncCode(r('执行失败', { rounds: [], roles: [{ id: 'a', surface: 'android-app', endpoint: '-', account: 'x', ready: false, error: 'no free prod account / endpoint slot for a' }] }), false)).toBe('ENV_UNFIT');
    expect(syncCode(r('执行失败'), false)).toBe('TOOL_FAILED');
  });

  it('multi-account Issue → multi-role plan; forwarding (no SKILL Node) → the reason it cannot be planned', () => {
    const i = { id: 'x1', title: 'Web message not on app', summary: 'A message sent from Web does not appear on the Android app of the other account', steps: ['send on web', 'open app'], platforms: ['web', 'android'], frequency: 'Always', expected: '', actual: '', featureArea: '', images: [] } as unknown as NormalizedIssue;
    const c = { category: 'multi-account', reason: 'r', by: 'rules', confidence: 'strong', surfaces: [] } as any;
    const s = syncSubcase(i, c, 'prod');
    if (typeof s === 'string') throw new Error(s);
    expect(s.plan.sync).toEqual({ roles: ['desktop-web', 'android-app'], rounds: 3 });
    expect(s.plan.surface).toBe('desktop-web');
    expect(validatePlan(s.plan).errors).toEqual([]);
    expect(messageBound(s.plan)).toBe(3);
    expect(messageBound(s.plan, 7)).toBe(7);
    expect(syncSubcase({ ...i, summary: 'A forwarded message is missing on Web' }, c, 'prod')).toMatch(/转发/);
    expect(validatePlan({ ...s.plan, sync: { roles: ['desktop-web', 'desktop-web'], rounds: 3 }, surface: 'desktop-web' }).errors.join()).toMatch(/different surfaces/);
  });
});
