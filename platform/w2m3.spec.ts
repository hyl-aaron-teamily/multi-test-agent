// W2-3 T5–T7 (device-free): approval policy and binding (31 / 32 / 33 / 30), view models (PlanView
// snapshots of 2010 / 1903 / 2044 / 1329, ResultView consistency), the v1 API envelope and `help --json`.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunResult } from '../executor/run';
import { attemptsOf } from '../executor/stats';
import { apiV1 } from './api-v1';
import { approve, classifyPlan, getApproval, messageBound, reject, setFullAccess, useApproval } from './approval';
import { consentConfig, getEnv, moveEnv, registerEnv, updateEnv } from './lifecycle/env';
import { CodedError, STATUS } from './lifecycle/status';
import { createTask, moveTask } from './lifecycle/task';
import { planHash, resolvePlan, savedDraft, staleFacts, versionFacts } from './plans-v1';
import { type TestPlan, TestPlanZ } from './schema/test-plan';
import { planText, planView, resultText, resultView, stepText } from './views';
import { COMMANDS, helpDoc } from '../scripts/cli-v1';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w2m3v-'));
  process.env.AUTOTEST_STATE_DIR = dir;
  process.env.AUTOTEST_POLICY_FILE = join(dir, 'no-policy.yaml'); // full access off unless a test turns it on
});
afterEach(() => {
  delete process.env.AUTOTEST_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const plan = (f: string): TestPlan => TestPlanZ.parse(JSON.parse(readFileSync(resolve('platform/plans', `${f}.json`), 'utf8')));
const ALLOW = ['黄悦龙Aaron, 黄悦龙-AgentEval, aaron+test2'];
const FACTS = { skillVersion: 's1', profileHash: 'p1', appVersion: '1.0', issueHash: 'i1' };

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof CodedError ? e.code : String(e);
  }
  return 'none';
};

describe('W2-3 T5 approval policy', () => {
  it('classifies: in-app plans default, big series / many messages sensitive, hard rules refused', () => {
    const p2010 = plan('2010-android-app-v1');
    const p1903 = plan('1903-android-app-v1');
    expect(classifyPlan(p2010, { allow: ALLOW }).category).toBe('default');
    expect(classifyPlan(p2010, { allow: ALLOW }).messages).toBe(0);
    expect(classifyPlan(p1903, { allow: ALLOW })).toMatchObject({ category: 'default', messages: 18 }); // 1 send × (6 + 11 drift + 1 warm-up)
    expect(classifyPlan(p2010, { series: 21 }).category).toBe('sensitive');
    expect(classifyPlan(p1903, { maxRounds: 60, allow: ALLOW })).toMatchObject({ category: 'sensitive' });
    expect(messageBound(p1903, 60)).toBeGreaterThan(50);
    const del = { ...p2010, actions: [...p2010.actions, { type: 'node' as const, node: { name: 'teamily.deleteMessage', input: {} }, delayAfterMs: 0 }] };
    expect(classifyPlan(del).category).toBe('refused');
    const out = { ...p1903, targets: [{ id: 'conv', kind: 'group-conversation', guidance: 'the conversation titled "Some customer group"' }] };
    expect(classifyPlan(out, { allow: ALLOW }).category).toBe('refused');
    const home = { ...p2010, actions: [...p2010.actions, { type: 'key' as const, value: 'home', delayAfterMs: 0 }] };
    expect(classifyPlan(home).category).toBe('sensitive');
  });

  it('approve: default by policy; sensitive needs the Web (30) unless full access; refused never; hash must match (31)', () => {
    const p = plan('2010-android-app-v1');
    const h = planHash(p);
    const def = classifyPlan(p);
    expect(approve({ planId: 'x/main:android-app@v1', planHash: h, confirmedHash: h, facts: FACTS, classified: def, via: 'cli' }).by).toBe('cli');
    expect(approve({ planId: 'x/main:android-app@v1', planHash: h, confirmedHash: h, facts: FACTS, classified: def, via: 'cli', auto: true }).by).toBe('policy');
    expect(code(() => approve({ planId: 'x', planHash: h, confirmedHash: 'zzz', facts: FACTS, classified: def, via: 'cli' }))).toBe('PLAN_HASH_MISMATCH');
    const sens = classifyPlan(p, { series: 21 });
    expect(code(() => approve({ planId: 'y', planHash: h, confirmedHash: h, facts: FACTS, classified: sens, series: 21, via: 'cli' }))).toBe('APPROVAL_REQUIRED');
    expect(approve({ planId: 'y', planHash: h, confirmedHash: h, facts: FACTS, classified: sens, series: 21, via: 'web', reviewer: 'aaron' })).toMatchObject({ by: 'aaron', runsAllowed: 21 });
    setFullAccess(true, 'aaron');
    expect(approve({ planId: 'z', planHash: h, confirmedHash: h, facts: FACTS, classified: sens, series: 21, via: 'cli' }).by).toMatch(/^full-access/);
    const refused = { category: 'refused' as const, reasons: ['x'], messages: 0 };
    expect(code(() => approve({ planId: 'r', planHash: h, confirmedHash: h, facts: FACTS, classified: refused, via: 'web' }))).toBe('PLAN_NOT_EXECUTABLE');
  });

  it('use: hash mismatch 31, changed versions 32, run count 33, rejected / missing 30', () => {
    const p = plan('2010-android-app-v1');
    const h = planHash(p);
    expect(code(() => useApproval('a', h, FACTS, 1))).toBe('APPROVAL_REQUIRED');
    approve({ planId: 'a', planHash: h, confirmedHash: h, facts: FACTS, classified: classifyPlan(p), runs: 2, via: 'cli' });
    expect(code(() => useApproval('a', 'other', FACTS, 1))).toBe('PLAN_HASH_MISMATCH');
    expect(code(() => useApproval('a', h, { ...FACTS, skillVersion: 's2' }, 1))).toBe('PLAN_STALE');
    expect(code(() => useApproval('a', h, { ...FACTS, appVersion: '1.1' }, 1))).toBe('PLAN_STALE');
    expect(code(() => useApproval('a', h, { ...FACTS, appVersion: undefined }, 1))).toBe('none'); // unknown now ≠ changed
    expect(code(() => useApproval('a', h, FACTS, 1))).toBe('none');
    expect(code(() => useApproval('a', h, FACTS, 1))).toBe('APPROVAL_EXHAUSTED');
    expect(getApproval('a')!.runsUsed).toBe(2);
    expect(code(() => reject('a', '  ', 'aaron'))).toBe('BAD_INPUT');
    reject('a', '步骤不对', 'aaron');
    expect(code(() => useApproval('a', h, FACTS, 1))).toBe('APPROVAL_REQUIRED');
    expect(staleFacts({ skillVersion: 'a', issueHash: 'x' }, { skillVersion: 'a', issueHash: 'y' })).toEqual(['issueHash: x → y']);
  });
});

describe('W2-3 T6 view models', () => {
  for (const f of ['2010-android-app-v1', '1903-android-app-v1', '2044-android-app-v1', '1329-s1-android-app-v1', '1329-s2-mobile-web-v1']) {
    it(`PlanView snapshot: ${f}`, () => {
      const p = plan(f);
      const v = planView({ id: f, hash: planHash(p), plan: p, classified: classifyPlan(p, { allow: ALLOW }), envConfig: ['Taplus 黑名单（已同意）'], history: [] });
      expect(v.steps.length).toBeGreaterThan(0);
      expect(v.steps.every((s) => !/teamily\./.test(s.text))).toBe(true); // plain Chinese, no Node names
      expect(v).toMatchSnapshot();
      expect(planText(v)).toContain(v.purpose);
    });
  }

  it('PlanView answers the six questions for 2010 and 1903', () => {
    for (const f of ['2010-android-app-v1', '1903-android-app-v1']) {
      const p = plan(f);
      const v = planView({ id: f, hash: planHash(p), plan: p, classified: classifyPlan(p, { allow: ALLOW }), history: [] });
      expect(typeof v.impact.messagesMax).toBe('number'); // how many messages (upper bound)
      expect(v.impact.conversations.length).toBe(1); // which conversation
      expect(v.impact.extraSettings).toEqual([]); // which phone settings
      expect(v.verdict[0]).toMatch(/命中/); // what counts as reproduced
      expect(v.uncertain.length).toBeGreaterThan(0); // what is uncertain
      expect(v.estimate.maxSec).toBeGreaterThan(v.estimate.minSec); // how long
    }
    const v1903 = planView({ id: 'x', hash: 'h', plan: plan('1903-android-app-v1'), classified: classifyPlan(plan('1903-android-app-v1'), { allow: ALLOW }), history: [] });
    expect(v1903.impact.conversations).toEqual(['黄悦龙Aaron, 黄悦龙-AgentEval, aaron+test2']);
  });

  it('estimate: history → median ~ max; first estimate labelled', () => {
    const p = plan('2010-android-app-v1');
    const v = planView({ id: 'x', hash: 'h', plan: p, classified: classifyPlan(p), history: [200, 240, 300] });
    expect(v.estimate).toMatchObject({ basis: 'history', samples: 3, minSec: 170, maxSec: 384 });
    expect(planView({ id: 'x', hash: 'h', plan: p, classified: classifyPlan(p), history: [] }).estimate.text).toMatch(/首次估算/);
  });

  it('report lead reuses the plan-view step rendering (leadOf)', async () => {
    const { leadOf } = await import('../executor/run');
    const p = plan('2010-android-app-v1');
    const lead = leadOf(p, { hits: [], runTag: 'r1', attempts: attemptsOf(6, 0, 0) });
    expect(lead.trigger).toBe(p.actions.map((a) => stepText(a, p, true).text.replace(/\{token\}/g, 'r1').replace(/\{round\}/g, '<轮号>')).join(' → '));
    expect(lead.trigger).toContain('r1');
  });

  it('ResultView: one sentence and the same numbers in text and JSON', () => {
    const r = { planId: '2010-android-app-v1', issue: '2010', title: 't', category: 'bug-always', surface: 'android-app', env: 'prod', substitution: { from: 'ios', to: 'android-app', reason: '' }, conclusion: '未复现', conclusionDetail: 'd', startedAt: '', finishedAt: '', stats: { durationSec: 200 } as RunResult['stats'], hits: [], incidents: [], targets: [], roundLog: [], attempts: attemptsOf(6, 1, 0), runTag: 'rabc' } as unknown as RunResult;
    const t = { id: 't1', state: 'done', endedBy: 'normal', recovery: { result: 'recovered', at: '' } } as any;
    const v = resultView(t, [r], 'NOT_REPRODUCED');
    expect(v.sentence).toBe(v.runs[0].sentence);
    expect(v.sentence).toMatch(/^未复现：6 次有效尝试未复现/);
    const txt = resultText(v);
    expect(txt).toContain(v.sentence);
    expect(txt).toContain(`有效尝试 ${v.runs[0].attempts!.valid}，命中 ${v.runs[0].attempts!.hits}`);
    const cut = resultView({ ...t, state: 'interrupted', endedBy: 'stuck', endedAt: { phase: 'loop', round: 3, step: 17 } }, [{ ...r, cancelled: true }], 'TASK_STUCK');
    expect(cut.complete).toBe(false);
    expect(cut.sentence).toMatch(/不完整，不给结论（停在循环 第 3 轮 第 17 步）；环境已恢复/);
  });
});

const EnvelopeZ = z.object({ status: z.number().int(), code: z.enum(Object.keys(STATUS) as [string, ...string[]]), exit: z.number().int(), summary: z.string(), data: z.unknown().optional(), text: z.string().optional(), error: z.object({ status: z.number(), code: z.string(), message: z.string(), hint: z.string().optional(), retryable: z.boolean(), kind: z.enum(['env', 'tool', 'input', 'policy']) }).optional() });

describe('W2-3 T7 API envelope and CLI help', () => {
  const call = (method: string, path: string, body: any = {}, web = false) => apiV1({ method, path: `/api/v1${path}`, query: new URL(`http://x${path}`).searchParams, body, web }, {});
  const ENV = 'android-app:4f2ebdf2@prod';
  const ready = () => {
    registerEnv({ id: ENV, surface: 'android-app', serviceEnv: 'prod', device: '4f2ebdf2', udid: '4f2ebdf2', package: 'ai.teamily.mobile', configItems: [{ id: 'taplus', what: 'taplus', why: 'w', restore: 'r' }] });
    moveEnv(ENV, 'checking', { by: 't', basis: 'x' });
    moveEnv(ENV, 'ready', { by: 't', basis: 'x' });
  };
  const pid2010 = () => `2010/main:android-app@v${savedDraft('2010')?.version ?? 1}`;

  it('every answer is a valid envelope whose exit matches its code', async () => {
    ready();
    const answers = [await call('GET', '/issues'), await call('GET', '/issues/2010'), await call('GET', '/issues/nope'), await call('GET', `/plans/${encodeURIComponent(pid2010())}`), await call('GET', '/plans/bad-id'), await call('GET', '/envs'), await call('GET', `/envs/${encodeURIComponent(ENV)}`), await call('GET', '/tasks'), await call('GET', '/tasks/none'), await call('GET', '/nothing')];
    for (const a of answers) {
      expect(EnvelopeZ.safeParse(a).success).toBe(true);
      expect(a.exit).toBe(STATUS[a.code].exit);
      expect(a.status).toBe(STATUS[a.code].status);
    }
    expect(answers.map((a) => a.code)).toEqual(['OK', 'OK', 'NOT_FOUND', 'OK', 'BAD_INPUT', 'OK', 'OK', 'OK', 'NOT_FOUND', 'NOT_FOUND']);
  });

  it('task run: consent first (30), then accepted (20) with the plan frozen; hash 31; series > 20 → 30 until the Web agrees', async () => {
    ready();
    const id = pid2010();
    expect((await call('POST', '/tasks', { planId: id })).code).toBe('APPROVAL_REQUIRED'); // env config item not consented
    consentConfig(ENV, 'taplus', 'aaron');
    expect((await call('POST', '/tasks', { planId: id, hash: 'deadbeefdeadbeef' })).code).toBe('PLAN_HASH_MISMATCH');
    expect((await call('POST', '/tasks', { planId: id, dryRun: true })).code).toBe('OK');
    const a = await call('POST', '/tasks', { planId: id, idempotencyKey: 'k1' });
    expect(a.code).toBe('ACCEPTED');
    expect((a.data as any).state).toBe('queued');
    expect((await call('POST', '/tasks', { planId: id, idempotencyKey: 'k1' })).data).toMatchObject({ id: (a.data as any).id });
    expect(getApproval(id)!.by).toBe('policy');
    const s = await call('POST', '/tasks', { planId: id, series: 21 });
    expect(s.code).toBe('APPROVAL_REQUIRED');
    expect(s.error?.hint).toMatch(/plan\.html/);
    const h = resolvePlan(id).hash;
    expect((await call('POST', `/plans/${encodeURIComponent(id)}/approve`, { hash: h, series: 21 })).code).toBe('APPROVAL_REQUIRED'); // CLI cannot
    expect((await call('POST', `/plans/${encodeURIComponent(id)}/approve`, { hash: h, series: 21 }, true)).code).toBe('OK'); // the Web can
    expect((await call('POST', '/tasks', { planId: id, series: 21 })).code).toBe('ACCEPTED');
    expect((await call('POST', '/full-access', { on: true })).code).toBe('APPROVAL_REQUIRED'); // Web only
  });

  it('full access (default from platform/policy.yaml) approves sensitive plans and consents configuration items', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.AUTOTEST_POLICY_FILE!, 'fullAccessDefault: true\n');
    ready();
    const id = pid2010();
    const s = await call('POST', '/tasks', { planId: id, series: 21 });
    expect(s.code).toBe('ACCEPTED');
    expect(getApproval(id)!.by).toMatch(/^full-access/);
    expect(getEnv(ENV)!.configItems[0].consentedBy).toMatch(/^full-access/);
    expect((await call('POST', '/full-access', { on: false }, true)).code).toBe('OK'); // the Web switch overrides the default
    expect((await call('POST', '/tasks', { planId: id, series: 22 })).code).toBe('APPROVAL_REQUIRED');
  });

  it('app version binding: an explicit approval goes stale (32) on an App update; a full-access approval is renewed', async () => {
    ready();
    consentConfig(ENV, 'taplus', 'aaron');
    updateEnv(ENV, (e) => void (e.appVersion = '2.0.15'));
    const id = pid2010();
    const h = resolvePlan(id).hash;
    expect((await call('POST', `/plans/${encodeURIComponent(id)}/approve`, { hash: h, runs: 3 }, true)).code).toBe('OK'); // a person, 3 runs
    expect(getApproval(id)!.facts.appVersion).toBe('2.0.15');
    updateEnv(ENV, (e) => void (e.appVersion = '2.0.16'));
    expect((await call('POST', '/tasks', { planId: id })).code).toBe('PLAN_STALE');
    // Full access approved it for 3 runs; the App updates; the next run is approved again, not refused.
    setFullAccess(true, 'test');
    approve({ planId: id, planHash: h, confirmedHash: h, facts: versionFacts(resolvePlan(id).plan, '4f2ebdf2', '2.0.16'), classified: { category: 'sensitive', reasons: ['x'], messages: 0 }, runs: 3, via: 'cli' });
    expect(getApproval(id)!.by).toMatch(/^full-access/);
    updateEnv(ENV, (e) => void (e.appVersion = '2.0.17'));
    expect((await call('POST', '/tasks', { planId: id })).code).toBe('ACCEPTED');
    expect(getApproval(id)!.facts.appVersion).toBe('2.0.17');
  });

  it('environment states map to 50–53', async () => {
    ready();
    consentConfig(ENV, 'taplus', 'aaron');
    moveEnv(ENV, 'unfit', { by: 't', basis: 'x', reason: 'screen: 锁屏（有 PIN，需人工解锁）' });
    expect((await call('POST', '/tasks', { planId: pid2010() })).code).toBe('ENV_LOCKED');
    moveEnv(ENV, 'checking', { by: 't', basis: 'x' });
    moveEnv(ENV, 'quarantined', { by: 't', basis: 'x', reason: 'composer' });
    expect((await call('POST', '/tasks', { planId: pid2010() })).code).toBe('ENV_QUARANTINED');
  });

  it('results: running → 21, finished → the outcome code', async () => {
    ready();
    createTask({ id: 'tt', kind: 'issue', issue: '2010', planId: 'p', planHash: 'h', envId: ENV, options: {} });
    expect((await call('GET', '/results/tt')).code).toBe('STILL_RUNNING');
    for (const s of ['waiting-env', 'preflight', 'running', 'finishing'] as const) moveTask('tt', s, 't', 'x');
    moveTask('tt', 'done', 't', 'x', (t) => void Object.assign(t, { outcome: { code: 'NOT_REPRODUCED', summary: '未复现' }, endedBy: 'normal' }));
    const r = await call('GET', '/results/tt');
    expect(r).toMatchObject({ code: 'NOT_REPRODUCED', exit: 10 });
    expect(getEnv(ENV)!.state).toBe('ready');
  });

  it('docs/cli-reference.md is generated from help --json (up to date)', async () => {
    const { cliReference } = await import('../scripts/cli-ref');
    // Line endings follow git's autocrlf on Windows checkouts.
    expect(readFileSync(resolve('docs/cli-reference.md'), 'utf8').replace(/\r\n/g, '\n')).toBe(cliReference());
  });

  it('help --json lists every command with an argument schema and the full status table', () => {
    const h = helpDoc();
    expect(h.commands.map((c) => c.command)).toEqual(expect.arrayContaining(['issue list', 'draft create', 'plan explain', 'plan approve', 'env recover', 'task run', 'task wait', 'result show', 'help']));
    for (const c of COMMANDS) for (const code of c.codes) expect(STATUS[code]).toBeDefined();
    expect(h.statusCodes.length).toBe(Object.keys(STATUS).length);
    expect(h.commands.find((c) => c.command === 'plan approve')!.args.find((a) => a.name === 'hash')!.required).toBe(true);
  });
});
