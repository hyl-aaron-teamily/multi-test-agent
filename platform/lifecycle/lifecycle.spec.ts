// W2-3 T1–T3 (device-free): environment / task state machines and persistence, the baseline walk and
// recovery with a simulated phone, the watchdog and the cross-checks with a simulated process table.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AndroidBaselineDriver, touchedConversations } from './baseline';
import { closeTask, judge, offlineEnv, onlineEnv, orphanSweep, startupCrossCheck, watchdogTick } from './crosscheck';
import { canMove, consentConfig, endLease, type EnvRecord, getEnv, leaseEnv, moveEnv, registerEnv, unconsented } from './env';
import type { ProcProbe } from './proc';
import { checkEnv, type DriverFactory, recoverEnv } from './recover';
import { CancelledError, effectOf, TaskRuntime } from './runtime';
import { codeOfConclusion, codeOfRuns, STATUS } from './status';
import { readAudit } from './store';
import { createTask, getTask, ledgerFile, moveTask, readLedger, TASK_FLOW, type TaskRecord } from './task';
import { appendLine } from './store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w2m3-'));
  process.env.AUTOTEST_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.AUTOTEST_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const ENV = 'android-app:4f2ebdf2@prod';
const env = (state: EnvRecord['state'] = 'ready') => {
  registerEnv({ id: ENV, surface: 'android-app', serviceEnv: 'prod', device: '4f2ebdf2', udid: '4f2ebdf2', package: 'ai.teamily.mobile', configItems: [{ id: 'taplus', what: 'taplus blacklist', why: 'long press', restore: 'remove' }] });
  // walk the legal path to the wanted state
  const path: Record<string, EnvRecord['state'][]> = { offline: [], checking: ['checking'], ready: ['checking', 'ready'], unfit: ['checking', 'unfit'], quarantined: ['checking', 'quarantined'], recovering: ['checking', 'recovering'], leased: ['checking', 'ready'] };
  for (const s of path[state] ?? []) moveEnv(ENV, s, { by: 'test', basis: 'setup' });
  return getEnv(ENV)!;
};
const task = (id = 't1') => createTask({ id, kind: 'issue', issue: '2010', planId: '2010/main:android-app@v1', planHash: 'h', envId: ENV, options: {} });
const toRunning = (id: string) => {
  for (const s of ['waiting-env', 'preflight', 'running'] as const) moveTask(id, s, 'test', 'setup');
};

/** A simulated phone: a dirty state the recovery has to fix. */
class FakePhone implements AndroidBaselineDriver {
  online_ = true;
  awake = true;
  locked = false;
  screen_: 'home' | 'chat' | 'popup' | 'foreign' = 'chat';
  composers: Record<string, string> = { 'aaron+test1’s Personal AI': 'autotest-2010 rX 3' };
  open?: string;
  kb = true;
  imeNow = 'com.iflytek/.Ime';
  taplus = false;
  residualProcs = ['1234 yadb'];
  /** Throw on the n-th call of any method (a recovery cut short). */
  failAt = -1;
  calls = 0;
  stuckComposer = false;
  private tick() {
    if (++this.calls === this.failAt) throw new Error('adb: device lost (simulated)');
  }
  async online() {
    this.tick();
    return this.online_;
  }
  async screen() {
    this.tick();
    return { awake: this.awake, locked: this.locked };
  }
  async wake() {
    this.awake = true;
  }
  async where() {
    this.tick();
    return this.screen_;
  }
  async back() {
    this.tick();
    if (this.screen_ !== 'home') this.screen_ = this.screen_ === 'popup' ? 'chat' : 'home';
    this.open = undefined;
  }
  async restartApp() {
    this.screen_ = 'home';
  }
  async openConversation(name: string) {
    this.tick();
    if (!(name in this.composers)) return false;
    this.open = name;
    this.screen_ = 'chat';
    return true;
  }
  async composer() {
    return this.open ? this.composers[this.open] : null;
  }
  async clearComposer() {
    this.tick();
    if (this.open && !this.stuckComposer) this.composers[this.open] = '';
  }
  async keyboard() {
    return this.kb;
  }
  async hideKeyboard() {
    this.kb = false;
  }
  async ime() {
    return this.imeNow;
  }
  async setIme(id: string) {
    this.imeNow = id;
  }
  async configOk() {
    return { ok: this.taplus, detail: `taplus ${this.taplus}` };
  }
  async applyConfig() {
    this.taplus = true;
  }
  async residual() {
    return this.residualProcs;
  }
  async killResidual() {
    this.residualProcs = [];
  }
}

const hostFree = { taskProcesses: async () => [], killTaskProcesses: async () => {} };
const drivers = (ph: FakePhone): DriverFactory => () => ({ android: ph, host: hostFree });

/** A simulated process table. */
class Procs implements ProcProbe {
  live = new Map<number, number>();
  killed: number[] = [];
  startTime(pid: number) {
    return this.live.get(pid);
  }
  kill(pid: number) {
    this.killed.push(pid);
    this.live.delete(pid);
  }
}

describe('W2-3 T1 environment and task objects', () => {
  it('rejects illegal environment transitions; quarantine is left by a person only', () => {
    env('offline');
    expect(() => moveEnv(ENV, 'ready', { by: 'test', basis: 'x' })).toThrow(/not allowed/);
    moveEnv(ENV, 'checking', { by: 'test', basis: 'x' });
    moveEnv(ENV, 'quarantined', { by: 'test', basis: 'x', reason: 'r' });
    expect(() => moveEnv(ENV, 'ready', { by: 'test', basis: 'x' })).toThrow();
    expect(() => moveEnv(ENV, 'checking', { by: 'platform', basis: 'auto' })).toThrow(/person/);
    expect(moveEnv(ENV, 'checking', { by: 'aaron', basis: 'handled' }).state).toBe('checking');
    expect(canMove('leased', 'draining')).toBe(true);
    expect(canMove('offline', 'draining')).toBe(false);
  });

  it('one environment, one lease; only from ready', () => {
    env('ready');
    expect(leaseEnv(ENV, 'a')).toBe(true);
    expect(leaseEnv(ENV, 'b')).toBe(false);
    expect(getEnv(ENV)!.lease!.taskId).toBe('a');
    endLease(ENV, 'a', { by: 'test', basis: 'done' });
    expect(getEnv(ENV)!.state).toBe('recovering');
    expect(getEnv(ENV)!.lastTask).toBe('a');
    expect(leaseEnv(ENV, 'b')).toBe(false); // recovering, not ready
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
    for (const s of ['done', 'failed', 'interrupted', 'cancelled', 'timed-out', 'env-unfit'] as const) expect(TASK_FLOW[s]).toEqual([]);
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
    env('offline');
    expect(unconsented(getEnv(ENV)!)).toEqual([]);
  });

  it('status codes: two digits, tens = class, 1 reserved, unique', () => {
    const exits = Object.values(STATUS).map((s) => s.exit);
    expect(new Set(exits).size).toBe(exits.length);
    expect(exits.every((e) => e === 0 || e === 1 || (e >= 10 && e < 100))).toBe(true);
    expect(codeOfConclusion('已复现')).toBe('REPRODUCED');
    expect(codeOfConclusion('执行失败', 'env')).toBe('ENV_UNFIT');
    expect(codeOfConclusion('执行失败', 'tool')).toBe('TOOL_FAILED');
    expect(codeOfRuns([{ conclusion: '未复现' }, { conclusion: '已复现' }])).toBe('REPRODUCED');
    expect(codeOfRuns([{ conclusion: '已复现' }, { conclusion: 'SKILL 失效' }])).toBe('SKILL_STALE');
  });
});

describe('W2-3 T2 lifecycle: ledger, recovery, idempotence', () => {
  it('ledger: side effects are recorded before they happen; cancel stops at the step boundary', () => {
    env('ready');
    task();
    toRunning('t1');
    const rt = new TaskRuntime('t1', 60_000);
    const target = (id: string) => (id === 'conv' ? 'Group A' : undefined);
    rt.beforeAction({ type: 'node', node: { name: 'teamily.openConversation', input: { target: 'conv' } }, delayAfterMs: 0 }, { round: 0, step: 1, target });
    rt.beforeAction({ type: 'type', value: 'hello', delayAfterMs: 0 }, { round: 1, step: 2, target });
    rt.beforeAction({ type: 'node', node: { name: 'teamily.tapSend', input: {} }, delayAfterMs: 0 }, { round: 1, step: 3, target });
    expect(readLedger('t1').map((l) => [l.kind, l.target, l.state])).toEqual([
      ['enter-conversation', 'Group A', 'intent'],
      ['type', 'Group A', 'intent'],
      ['send', 'Group A', 'intent'],
    ]);
    moveTask('t1', 'running', 'test', 'noop', (t) => void (t.cancelRequested = { at: new Date().toISOString(), by: 'test' }));
    (rt as any).lastPoll = 0;
    expect(() => rt.beforeAction({ type: 'tap', element: 'chat.send', delayAfterMs: 0 }, { round: 1, step: 4, target })).toThrow(CancelledError);
    expect(effectOf({ type: 'wait', value: '100', delayAfterMs: 0 }, 'x', target)).toBeUndefined();
    // a target located by vision has no title: entered without a name (recovery cannot open it by name)
    expect(effectOf({ type: 'node', node: { name: 'teamily.openConversation', input: { target: 'other' } }, delayAfterMs: 0 }, undefined, target)).toMatchObject({ kind: 'enter-conversation', target: undefined, value: expect.stringContaining('标题未知') });
    // clearing the input leaves no draft: not a touched conversation
    expect(touchedConversations([{ kind: 'type', target: 'A', value: 'clearComposer' }, { kind: 'type', target: 'B', value: 'hi' }, { kind: 'send', target: 'C' }])).toEqual(['B', 'C']);
  });

  it('recovery brings a dirty phone back to the baseline (L3) and is idempotent', async () => {
    const ph = new FakePhone();
    env('ready');
    getEnv(ENV);
    leaseEnv(ENV, 't1');
    task();
    appendLine(ledgerFile('t1'), { at: '', seq: 1, kind: 'type', target: 'aaron+test1’s Personal AI', value: 'x', state: 'intent' });
    // declared default IME
    registerEnv({ ...getEnv(ENV)!, ime: 'com.sohu/.Ime' } as any);
    endLease(ENV, 't1', { by: 'test', basis: 'task killed' });
    const r = await recoverEnv(ENV, drivers(ph));
    expect(r.env.state).toBe('ready');
    expect(ph.composers['aaron+test1’s Personal AI']).toBe('');
    expect(ph.kb).toBe(false);
    expect(ph.screen_).toBe('home');
    expect(ph.taplus).toBe(true);
    expect(ph.imeNow).toBe('com.sohu/.Ime');
    expect(ph.residualProcs).toEqual([]);
    expect(r.did.length).toBeGreaterThanOrEqual(5);
    expect(getTask('t1')!.recovery?.result).toBe('recovered');
    // again: nothing to do, still ready
    const again = await recoverEnv(ENV, drivers(ph));
    expect(again.env.state).toBe('ready');
    expect(again.did).toEqual([]);
  });

  it('a recovery cut short is repeated to the same end (G7)', async () => {
    const ph = new FakePhone();
    ph.failAt = 6;
    env('ready');
    leaseEnv(ENV, 't1');
    task();
    appendLine(ledgerFile('t1'), { at: '', seq: 1, kind: 'send', target: 'aaron+test1’s Personal AI', state: 'intent' });
    endLease(ENV, 't1', { by: 'test', basis: 'x' });
    const first = await recoverEnv(ENV, drivers(ph));
    expect(first.env.state).toBe('quarantined');
    expect(first.env.dirty).toBeDefined();
    moveEnv(ENV, 'checking', { by: 'aaron', basis: 'handled' });
    ph.failAt = -1;
    const second = await checkEnv(ENV, drivers(ph), 'aaron');
    expect(second.env.state).toBe('ready');
    expect(second.env.dirty).toBeUndefined();
    expect(ph.composers['aaron+test1’s Personal AI']).toBe('');
  });

  it('locked phone → unfit (needs a person); unfixable item → quarantined with its reason', async () => {
    const ph = new FakePhone();
    ph.locked = true;
    env('recovering');
    expect((await recoverEnv(ENV, drivers(ph))).env).toMatchObject({ state: 'unfit', reason: expect.stringContaining('锁屏') });
    const ph2 = new FakePhone();
    ph2.stuckComposer = true;
    env('ready');
    leaseEnv(ENV, 't2');
    task('t2');
    appendLine(ledgerFile('t2'), { at: '', seq: 1, kind: 'type', target: 'aaron+test1’s Personal AI', state: 'intent' });
    moveEnv(ENV, 'recovering', { by: 'test', basis: 'x' }, (e) => void Object.assign(e, { lease: undefined, lastTask: 't2' }));
    const r = await recoverEnv(ENV, drivers(ph2));
    expect(r.env.state).toBe('quarantined');
    expect(r.env.reason).toMatch(/输入框不为空/);
    expect(getEnv(ENV)!.state).not.toBe('ready'); // never "ready but baseline failed"
  });

  it('the chat left open is checked first, whatever its title', async () => {
    const ph = new FakePhone();
    ph.open = 'some chat';
    ph.composers['some chat'] = 'left behind';
    env('recovering');
    const r = await recoverEnv(ENV, drivers(ph));
    expect(r.env.state).toBe('ready');
    expect(ph.composers['some chat']).toBe('');
    expect(r.did.join(' ')).toMatch(/当前打开会话/);
  });

  it('records the installed app version at every check (approvals bind it)', async () => {
    const ph = Object.assign(new FakePhone(), { appVersion: async () => '2.0.15' });
    env('recovering');
    await recoverEnv(ENV, drivers(ph));
    expect(getEnv(ENV)!.appVersion).toBe('2.0.15');
    ph.appVersion = async () => '2.0.16';
    moveEnv(ENV, 'checking', { by: 'test', basis: 'x' });
    await checkEnv(ENV, drivers(ph));
    expect(getEnv(ENV)!.appVersion).toBe('2.0.16');
  });

  it('android-web: the phone is checked too — keyboard down, browser ended, touched conversations listed', async () => {
    const WEB = 'android-web:4f2ebdf2@prod';
    registerEnv({ id: WEB, surface: 'android-web', serviceEnv: 'prod', device: '4f2ebdf2', udid: '4f2ebdf2', package: 'com.android.browser', configItems: [{ id: 'taplus', what: 'taplus blacklist', why: 'long press', restore: 'remove' }] });
    moveEnv(WEB, 'checking', { by: 'test', basis: 'setup' });
    moveEnv(WEB, 'ready', { by: 'test', basis: 'setup' });
    leaseEnv(WEB, 'tw');
    createTask({ id: 'tw', kind: 'issue', issue: '1329', planId: '1329/s2:android-web@v1', planHash: 'h', envId: WEB, options: {} });
    appendLine(ledgerFile('tw'), { at: '', seq: 1, kind: 'type', target: '测试群', value: 'x', state: 'intent' });
    endLease(WEB, 'tw', { by: 'test', basis: 'task killed' });
    let running = true;
    const ph = Object.assign(new FakePhone(), { appRunning: async () => running, stopApp: async () => void (running = false) });
    const r = await recoverEnv(WEB, () => ({ android: ph, host: hostFree }));
    expect(r.env.state).toBe('ready');
    expect(running).toBe(false);
    expect(ph.kb).toBe(false);
    expect(ph.taplus).toBe(true);
    expect(r.walk!.items.map((i) => i.id)).toEqual(expect.arrayContaining(['online', 'screen', 'residual', 'keyboard', 'browser-closed', 'drafts', 'config:taplus']));
    expect(r.walk!.items.find((i) => i.id === 'drafts')!.detail).toMatch(/测试群.*未逐个打开/);
    // a locked phone blocks the browser environment as well
    const locked = Object.assign(new FakePhone(), { locked: true });
    moveEnv(WEB, 'checking', { by: 'test', basis: 'x' });
    expect((await checkEnv(WEB, () => ({ android: locked, host: hostFree }))).env).toMatchObject({ state: 'unfit', reason: expect.stringContaining('锁屏') });
  });
});

describe('W2-3 T3 cross-check: four corrections', () => {
  const NOW = Date.parse('2026-10-28T12:00:00Z');
  const running = (id: string, pid: number, hbAgoMs: number, progressAgoMs = 1000): TaskRecord => {
    task(id);
    toRunning(id);
    return moveTask(id, 'running', 'test', 'x', (t) => {
      t.proc = { pid, startedAt: 1000 };
      t.startedAt = new Date(NOW - 120_000).toISOString();
      t.heartbeatAt = new Date(NOW - hbAgoMs).toISOString();
      t.progress = { phase: 'loop', round: 3, step: 17, at: new Date(NOW - progressAgoMs).toISOString() };
    });
  };
  const leased = (id: string) => {
    env('ready');
    leaseEnv(ENV, id);
  };

  it('judge: ok / heartbeat-stale / progress-stale / no-process / over-limit', () => {
    const base = { state: 'running' as const, heartbeatAt: new Date(NOW - 1000).toISOString(), progress: { at: new Date(NOW - 1000).toISOString() }, startedAt: new Date(NOW - 60_000).toISOString(), createdAt: '', options: {} };
    expect(judge(base, NOW, true)).toBe('ok');
    expect(judge(base, NOW, false)).toBe('no-process');
    expect(judge({ ...base, heartbeatAt: new Date(NOW - 31_000).toISOString() }, NOW, true)).toBe('heartbeat-stale');
    expect(judge({ ...base, progress: { at: new Date(NOW - 200_000).toISOString(), stepBudgetMs: 20_000 } }, NOW, true)).toBe('progress-stale');
    expect(judge({ ...base, progress: { at: new Date(NOW - 200_000).toISOString(), stepBudgetMs: 600_000 } }, NOW, true)).toBe('ok'); // long idle step
    expect(judge(base, NOW, true, 30_000)).toBe('over-limit');
  });

  it('process alive + fresh heartbeat → adopted, not interrupted', async () => {
    const p = new Procs();
    p.live.set(42, 1000);
    leased('a');
    running('a', 42, 2000);
    const r = await onlineEnv(ENV, { drivers: drivers(new FakePhone()), probe: p, now: () => NOW });
    expect(r.corrections).toMatchObject([{ task: 'a', action: 'adopted' }]);
    expect(getTask('a')!.state).toBe('running');
    expect(getEnv(ENV)!.lease?.taskId).toBe('a');
    expect(p.killed).toEqual([]);
  });

  it('process alive + heartbeat stale → killed, failed (62 stuck), environment recovered', async () => {
    const p = new Procs();
    p.live.set(42, 1000);
    leased('a');
    running('a', 42, 45_000);
    const ph = new FakePhone();
    await onlineEnv(ENV, { drivers: drivers(ph), probe: p, now: () => NOW });
    expect(p.killed).toEqual([42]);
    const t = getTask('a')!;
    expect(t).toMatchObject({ state: 'failed', endedBy: 'stuck', outcome: { code: 'TASK_STUCK' }, endedAt: { phase: 'loop', round: 3, step: 17 } });
    expect(getEnv(ENV)!.state).toBe('ready');
    expect(t.recovery?.result).toBe('recovered');
  });

  it('process gone → interrupted: 72 at platform start, 63 at runtime (watchdog)', async () => {
    const p = new Procs();
    leased('a');
    running('a', 42, 1000);
    await startupCrossCheck({ drivers: drivers(new FakePhone()), probe: p, now: () => NOW });
    expect(getTask('a')).toMatchObject({ state: 'interrupted', endedBy: 'server-restart', outcome: { code: 'INTERRUPTED' } });
    expect(getEnv(ENV)!.state).toBe('ready');
    leaseEnv(ENV, 'b');
    running('b', 43, 1000);
    const fixes = await watchdogTick({ drivers: drivers(new FakePhone()), probe: p, now: () => NOW });
    expect(fixes).toMatchObject([{ task: 'b', endedBy: 'crash' }]);
    expect(getTask('b')).toMatchObject({ state: 'interrupted', outcome: { code: 'TASK_CRASHED' } });
    expect(getEnv(ENV)!.state).toBe('ready');
  });

  it('live state without a lease → corrected (no "running" record with a dead process)', async () => {
    const p = new Procs();
    env('ready');
    running('orphan', 77, 1000);
    const fixes = await orphanSweep({ drivers: drivers(new FakePhone()), probe: p, now: () => NOW }, 'runtime');
    expect(fixes).toMatchObject([{ task: 'orphan', health: 'no-lease', action: 'closed' }]);
    expect(getTask('orphan')!.state).toBe('interrupted');
    // a live process without a lease is killed too
    p.live.set(78, 1000);
    running('orphan2', 78, 1000);
    await orphanSweep({ drivers: drivers(new FakePhone()), probe: p, now: () => NOW }, 'runtime');
    expect(p.killed).toContain(78);
    expect(getTask('orphan2')!.state).toBe('interrupted');
  });

  it('offline: cancel request, kill after the wait, task interrupted (72), environment left clean / dirty', async () => {
    const p = new Procs();
    p.live.set(42, 1000);
    leased('a');
    running('a', 42, 1000);
    const e = await offlineEnv(ENV, { drivers: drivers(new FakePhone()), probe: p, now: Date.now, reachable: async () => true, waitMs: 600 }, 'aaron');
    expect(getTask('a')!.cancelRequested).toBeDefined();
    expect(p.killed).toEqual([42]);
    expect(getTask('a')).toMatchObject({ state: 'interrupted', endedBy: 'env-offline', outcome: { code: 'INTERRUPTED' } });
    expect(e).toMatchObject({ state: 'offline', offlineAs: 'clean' });
    // unreachable at offline → dirty; the next online recovers first
    moveEnv(ENV, 'checking', { by: 'test', basis: 'x' });
    moveEnv(ENV, 'ready', { by: 'test', basis: 'x' });
    const e2 = await offlineEnv(ENV, { drivers: drivers(new FakePhone()), probe: p, reachable: async () => false, waitMs: 0 }, 'aaron');
    expect(e2).toMatchObject({ state: 'offline', offlineAs: 'dirty', dirty: { reason: '下线时不可达' } });
    moveEnv(ENV, 'checking', { by: 'test', basis: 'online' });
    await onlineEnv(ENV, { drivers: drivers(new FakePhone()), probe: p });
    expect(getEnv(ENV)).toMatchObject({ state: 'ready' });
    expect(getEnv(ENV)!.dirty).toBeUndefined();
  });

  it('closeTask records position and partial results; series children close with the parent', () => {
    env();
    task('p');
    toRunning('p');
    createTask({ id: 'p.1', kind: 'issue', issue: '2010', planId: 'x', planHash: 'h', envId: ENV, parent: 'p', options: {} });
    toRunning('p.1');
    const t = closeTask('p', 'cancel', 'test', 'x');
    expect(t.state).toBe('cancelled');
    expect(getTask('p.1')!.state).toBe('cancelled');
  });
});
