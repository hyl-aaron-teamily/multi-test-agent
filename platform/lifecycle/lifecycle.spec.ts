// Lifecycle (device-free, refactor P2): environment / task state machines and persistence, the environment
// check with a simulated phone, side-effect records and cancel, closing tasks, and the platform-start
// reconciliation of leases by process liveness.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { androidConfigItems } from './android-ops';
import { checkEnv, type CheckDrivers, type PhoneDriver, runCheck } from './check';
import { canMove, consentConfig, type ConfigItem, endLease, type EnvRecord, getEnv, leaseEnv, moveEnv, registerEnv, unconsented } from './env';
import { notificationsFile } from './notify';
import type { ProcId } from './proc';
import { CancelledError, effectOf, TaskRuntime } from './runtime';
import { codeOfConclusion, codeOfRuns, STATUS } from './status';
import { readAudit, writeJsonAtomic } from './store';
import { reconcile } from './supervisor';
import { closeTask, createTask, getTask, moveTask, readLedger, TASK_FLOW, taskDir, updateTask } from './task';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lifecycle-'));
  process.env.AUTOTEST_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.AUTOTEST_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const ENV = 'android-app:4f2ebdf2@prod';
const env = (state: EnvRecord['state'] = 'ready', configItems: ConfigItem[] = [{ id: 'taplus', what: 'taplus blacklist', why: 'long press', restore: 'remove' }]) => {
  registerEnv({ id: ENV, surface: 'android-app', serviceEnv: 'prod', device: '4f2ebdf2', udid: '4f2ebdf2', package: 'ai.teamily.mobile', configItems });
  const path: Record<string, EnvRecord['state'][]> = { offline: [], checking: ['checking'], ready: ['checking', 'ready'], unfit: ['checking', 'unfit'], leased: ['checking', 'ready'] };
  for (const s of path[state] ?? []) moveEnv(ENV, s, { by: 'test', basis: 'setup' });
  if (state === 'leased') leaseEnv(ENV, 'holder');
  return getEnv(ENV)!;
};
const task = (id = 't1', parent?: string) => createTask({ id, kind: 'issue', issue: '2010', planId: '2010/main:android-app@v1', planHash: 'h', envId: ENV, options: {}, ...(parent ? { parent } : {}) });
const toRunning = (id: string) => {
  for (const s of ['waiting-env', 'preflight', 'running'] as const) moveTask(id, s, 'test', 'setup');
};

/** A simulated phone for the environment check. */
class FakePhone implements PhoneDriver {
  online_ = true;
  awake = true;
  locked = false;
  version = '2.0.20';
  met: Record<string, boolean> = { taplus: false, stayon: true, 'a11y-service': false };
  applyThrows = new Set<string>();
  applied: string[] = [];
  async online() {
    return this.online_;
  }
  async screen() {
    return { awake: this.awake, locked: this.locked };
  }
  async wake() {
    this.awake = true;
  }
  async appVersion() {
    return this.version;
  }
  async configOk(c: ConfigItem) {
    return { ok: !!this.met[c.id], detail: `${c.id} ${this.met[c.id] ? 'ok' : 'unmet'}` };
  }
  async applyConfig(c: ConfigItem) {
    if (this.applyThrows.has(c.id)) throw new Error('INSTALL_FAILED_USER_RESTRICTED');
    this.applied.push(c.id);
    this.met[c.id] = true;
  }
}
const drivers = (d: CheckDrivers) => () => d;

describe('environment and task objects', () => {
  it('rejects illegal environment transitions; a lease ends in checking', () => {
    env('offline');
    expect(() => moveEnv(ENV, 'ready', { by: 'test', basis: 'x' })).toThrow(/not allowed/);
    expect(canMove('leased', 'ready')).toBe(false);
    expect(canMove('leased', 'checking')).toBe(true);
    expect(canMove('unfit', 'checking')).toBe(true);
  });

  it('one environment, one lease; only from ready', () => {
    env('ready');
    expect(leaseEnv(ENV, 'a')).toBe(true);
    expect(leaseEnv(ENV, 'b')).toBe(false);
    expect(getEnv(ENV)!.lease!.taskId).toBe('a');
    endLease(ENV, 'a', { by: 'test', basis: 'done' });
    expect(getEnv(ENV)!.state).toBe('checking');
    expect(getEnv(ENV)!.lease).toBeUndefined();
    expect(leaseEnv(ENV, 'b')).toBe(false); // checking, not ready
  });

  it('records written before P2 (recovering / quarantined) are mapped on registration', () => {
    env('ready');
    const f = join(dir, 'envs', `${ENV.replace(/[^\w.@-]/g, '_')}.json`);
    writeJsonAtomic(f, { ...getEnv(ENV)!, state: 'quarantined' });
    expect(env('offline').state).toBe('unfit');
  });

  it('task state machine: illegal moves throw, terminal records are never rewritten', () => {
    env();
    task();
    expect(() => moveTask('t1', 'running', 'test', 'x')).toThrow(/not allowed/);
    toRunning('t1');
    expect(() => moveTask('t1', 'done', 'test', 'x')).toThrow(); // running → done skips finishing
    moveTask('t1', 'finishing', 'test', 'x');
    moveTask('t1', 'done', 'test', 'x');
    expect(() => moveTask('t1', 'failed', 'test', 'x')).toThrow();
    for (const s of ['done', 'failed', 'interrupted', 'cancelled', 'env-unfit'] as const) expect(TASK_FLOW[s]).toEqual([]);
  });

  it('audits every transition and lease; consent is recorded once', () => {
    env('ready');
    leaseEnv(ENV, 'x');
    const a = readAudit();
    expect(a.some((e) => e.action === 'env.register')).toBe(true);
    expect(a.filter((e) => e.action === 'env.move').map((e) => e.after)).toEqual(['checking', 'ready']);
    expect(a.some((e) => e.action === 'env.lease' && e.basis === 'task x')).toBe(true);
    expect(unconsented(getEnv(ENV)!).map((c) => c.id)).toEqual(['taplus']);
    consentConfig(ENV, 'taplus', 'aaron');
    expect(unconsented(getEnv(ENV)!)).toEqual([]);
    // re-registration keeps the consent while the item text is unchanged
    registerEnv({ id: ENV, surface: 'android-app', serviceEnv: 'prod', device: '4f2ebdf2', udid: '4f2ebdf2', package: 'ai.teamily.mobile', configItems: [{ id: 'taplus', what: 'taplus blacklist', why: 'long press', restore: 'remove' }] });
    expect(unconsented(getEnv(ENV)!)).toEqual([]);
  });

  it('status codes: two digits, tens = class, 1 reserved, unique; removed codes are gone', () => {
    const exits = Object.values(STATUS).map((s) => s.exit);
    expect(new Set(exits).size).toBe(exits.length);
    expect(exits.every((e) => e === 0 || e === 1 || (e >= 10 && e < 100))).toBe(true);
    expect(Object.keys(STATUS)).not.toContain('ENV_QUARANTINED');
    expect(Object.keys(STATUS)).not.toContain('TIMED_OUT');
    expect(codeOfConclusion('已复现')).toBe('REPRODUCED');
    expect(codeOfConclusion('执行失败', 'env')).toBe('ENV_UNFIT');
    expect(codeOfConclusion('执行失败', 'tool')).toBe('TOOL_FAILED');
    expect(codeOfRuns([{ conclusion: '未复现' }, { conclusion: '已复现' }])).toBe('REPRODUCED');
    expect(codeOfRuns([{ conclusion: '已复现' }, { conclusion: 'SKILL 失效' }])).toBe('SKILL_STALE');
  });
});

describe('environment check', () => {
  it('passes → ready; records the app version and applies an unmet configuration item', async () => {
    env('offline');
    const p = new FakePhone();
    const r = await checkEnv(ENV, drivers({ phone: p }), 'test');
    expect(r.env).toMatchObject({ state: 'ready', appVersion: '2.0.20', check: { ok: true } });
    expect(p.applied).toEqual(['taplus']);
    expect(r.env.check!.did[0]).toMatch(/taplus/);
  });

  it('locked → unfit with the unlock suggestion; offline → unfit; a dark screen is woken', async () => {
    env('offline');
    const p = new FakePhone();
    p.locked = true;
    let r = await checkEnv(ENV, drivers({ phone: p }), 'test');
    expect(r.env).toMatchObject({ state: 'unfit', reason: expect.stringMatching(/锁屏/), suggestion: expect.stringMatching(/PIN/) });
    p.locked = false;
    p.online_ = false;
    r = await checkEnv(ENV, drivers({ phone: p }), 'test');
    expect(r.env).toMatchObject({ state: 'unfit', reason: expect.stringMatching(/不在线/) });
    p.online_ = true;
    p.awake = false;
    r = await checkEnv(ENV, drivers({ phone: p }), 'test');
    expect(r.env.state).toBe('ready');
    expect(r.result!.did).toContain('唤醒屏幕');
  });

  it('a leased environment is never checked', async () => {
    env('leased');
    const r = await checkEnv(ENV, drivers({ phone: new FakePhone() }), 'test');
    expect(r.error).toMatch(/占用/);
    expect(getEnv(ENV)!.state).toBe('leased');
  });

  it('optional tree service: not applied before consent; failing to apply still passes (falls back)', async () => {
    const items = androidConfigItems('ai.teamily.mobile', 'a11y-service');
    expect(items.map((c) => c.id)).toEqual(['a11y-service', 'taplus', 'stayon']);
    expect(androidConfigItems('p').map((c) => c.id)).toEqual(['taplus', 'stayon']);
    const svc = items.filter((c) => c.id === 'a11y-service');
    const p = new FakePhone();
    let r = await runCheck({ surface: 'android-app', configItems: svc }, { phone: p });
    expect(r.ok).toBe(true);
    expect(p.applied).toEqual([]);
    expect(r.items[2].detail).toMatch(/待同意/);
    const consented = svc.map((c) => ({ ...c, consentedAt: '2026-11-02T00:00:00Z' }));
    p.applyThrows.add('a11y-service');
    r = await runCheck({ surface: 'android-app', configItems: consented }, { phone: p });
    expect(r.ok).toBe(true);
    expect(r.items[2].detail).toMatch(/应用失败.*退回 uiautomator/);
    p.applyThrows.clear();
    r = await runCheck({ surface: 'android-app', configItems: consented }, { phone: p });
    expect(p.applied).toEqual(['a11y-service']);
  });

  it('web: the session file decides', async () => {
    expect((await runCheck({ surface: 'desktop-web', configItems: [] }, { sessionOk: async () => ({ ok: false, detail: '没有登录态' }) })).ok).toBe(false);
    expect((await runCheck({ surface: 'desktop-web', configItems: [] }, { sessionOk: async () => ({ ok: true, detail: 'ok' }) })).ok).toBe(true);
  });
});

describe('task process: side effects, cancel, close', () => {
  it('side effects are recorded before they happen; cancel stops at the step boundary', () => {
    env('ready');
    task();
    toRunning('t1');
    const rt = new TaskRuntime('t1');
    const target = (id: string) => (id === 'conv' ? 'Group A' : undefined);
    rt.beforeAction({ type: 'node', node: { name: 'teamily.openConversation', input: { target: 'conv' } }, delayAfterMs: 0 }, { round: 0, step: 1, target });
    rt.beforeAction({ type: 'type', value: 'hello', delayAfterMs: 0 }, { round: 1, step: 2, target });
    rt.beforeAction({ type: 'node', node: { name: 'teamily.tapSend', input: {} }, delayAfterMs: 0 }, { round: 1, step: 3, target });
    expect(readLedger('t1').map((l) => [l.kind, l.target])).toEqual([
      ['enter-conversation', 'Group A'],
      ['type', 'Group A'],
      ['send', 'Group A'],
    ]);
    updateTask('t1', (t) => void (t.cancelRequested = { at: new Date().toISOString(), by: 'test' }));
    (rt as any).lastPoll = 0;
    expect(() => rt.beforeAction({ type: 'tap', element: 'chat.send', delayAfterMs: 0 }, { round: 1, step: 4, target })).toThrow(CancelledError);
    // phase boundaries inside the executor are cancel points too (not the preflight, which runs outside it)
    expect(() => rt.phase('preflight')).not.toThrow();
    expect(() => rt.phase('prepare')).toThrow(CancelledError);
    expect(effectOf({ type: 'wait', value: '100', delayAfterMs: 0 }, 'x', target)).toBeUndefined();
    expect(effectOf({ type: 'node', node: { name: 'teamily.openConversation', input: { target: 'other' } }, delayAfterMs: 0 }, undefined, target)).toMatchObject({ kind: 'enter-conversation', target: undefined, value: expect.stringContaining('标题未知') });
  });

  it('closeTask records position and partial results; series children close with the parent', () => {
    env();
    task('p');
    toRunning('p');
    updateTask('p', (t) => void (t.progress = { phase: 'loop', round: 3, step: 17 }));
    writeJsonAtomic(join(taskDir('p'), 'result.json'), { runs: [{ attempts: { valid: 2, hits: 0 } }] });
    task('p.1', 'p');
    toRunning('p.1');
    const t = closeTask('p', 'crash', 'test', 'x');
    expect(t).toMatchObject({ state: 'interrupted', endedBy: 'crash', outcome: { code: 'TASK_CRASHED', summary: expect.stringMatching(/循环 第 3 轮 第 17 步/) }, partial: { valid: 2, hits: 0, note: '不完整，不给结论' } });
    expect(getTask('p.1')!.state).toBe('interrupted');
    task('q');
    expect(closeTask('q', 'cancel', 'test', 'before start').state).toBe('cancelled');
  });

  it('one notification line per finished top-level task; series children are reported by their parent', () => {
    task('p1');
    task('c1', 'p1');
    for (const id of ['p1', 'c1']) {
      for (const s of ['waiting-env', 'preflight', 'running', 'finishing'] as const) moveTask(id, s, 't', 'x');
      moveTask(id, 'done', 't', 'x', (t) => void Object.assign(t, { outcome: { code: 'NOT_REPRODUCED', summary: '未复现' }, endedBy: 'normal' }));
    }
    const lines = readFileSync(notificationsFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([expect.objectContaining({ task: 'p1', issue: '2010', state: 'done', code: 'NOT_REPRODUCED', summary: '未复现', endedBy: 'normal' })]);
  });
});

describe('platform start: leases decided by the task process alone', () => {
  const me: ProcId = { pid: 1001, startedAt: 1 };
  const dead: ProcId = { pid: 2002, startedAt: 2 };
  const isAlive = (p: ProcId | undefined) => p?.pid === me.pid;

  it('alive → adopted (lease kept); gone → interrupted (72), lease released, environment to checking', () => {
    env('leased');
    // the lease holder is task 'holder'
    createTask({ id: 'holder', kind: 'issue', issue: '2010', planId: 'x', planHash: 'h', envId: ENV, options: {} });
    toRunning('holder');
    updateTask('holder', (t) => void (t.proc = me));
    expect(reconcile(isAlive, () => {})).toEqual([{ task: 'holder', env: ENV, action: 'adopted' }]);
    expect(getEnv(ENV)!.lease?.taskId).toBe('holder');
    updateTask('holder', (t) => void (t.proc = dead));
    expect(reconcile(isAlive, () => {})).toEqual([{ task: 'holder', env: ENV, action: 'closed' }]);
    expect(getTask('holder')).toMatchObject({ state: 'interrupted', endedBy: 'server-restart', outcome: { code: 'INTERRUPTED' } });
    expect(getEnv(ENV)!.state).toBe('checking');
    expect(getEnv(ENV)!.lease).toBeUndefined();
  });

  it('a lease whose task never started is released and the task stays queued', () => {
    env('leased');
    createTask({ id: 'holder', kind: 'issue', issue: '2010', planId: 'x', planHash: 'h', envId: ENV, options: {} });
    moveTask('holder', 'waiting-env', 'test', 'x');
    expect(reconcile(isAlive, () => {})).toEqual([{ task: 'holder', env: ENV, action: 'requeued' }]);
    expect(getTask('holder')!.state).toBe('waiting-env');
  });

  it('a live-state task without a lease is closed; its process is killed if it still runs', () => {
    env('ready');
    task('orphan');
    toRunning('orphan');
    updateTask('orphan', (t) => void (t.proc = me));
    const killed: number[] = [];
    expect(reconcile(isAlive, (pid) => killed.push(pid))).toEqual([{ task: 'orphan', env: ENV, action: 'closed' }]);
    expect(killed).toEqual([me.pid]);
    expect(getTask('orphan')!.state).toBe('interrupted');
  });
});
