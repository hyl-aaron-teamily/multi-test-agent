// W7-R6: failure point and cause, executor failures cost no version, deterministic fix candidates, R13, the
// judgment guard, stop rules, and the repair loop end to end (fake runs, fake model, real record + validator).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { failurePoint, pathRank, toPointer } from '../engine/plan/failure-point';
import type { RunResult } from '../engine/plan/run';
import { emptyPages } from '../engine/pages';
import { pageTextWarnings } from './page-texts';
import { asRecord, compileRecord, contextOf, type PlanRecord, patchRecord, stateOf } from './record';
import { blockers, deterministicFix, nearCandidates, nextMove, touchesJudgment } from './repair';
import { repairLoop } from './repair-loop';
import { revisionTrigger } from './revise';

const draft = () => JSON.parse(readFileSync('fixtures/w3m6/2730.draft.json', 'utf8'));
const raw = (draft().envelope.quotes as { text: string }[]).map((q) => q.text).join('\n');
const textCheck = (expect: string, contains: string) => ({ kind: 'text', expect, match: { contains }, scope: 'screen' });

/** The 2730 record made runnable (record.spec's two patches): baseline[*] look for 「设置」. */
function runnable(): PlanRecord {
  const r0 = asRecord(draft());
  const r = { ...r0, ...compileRecord(r0, r0.envelope!, contextOf(r0, 7, raw)) };
  const r7 = patchRecord(r, r.partial!.flatMap((p) => p.errors.map((e) => ({ op: 'replace' as const, path: e.path, value: textCheck('设置列表滚到了偏好与安全分组', '偏好与安全') }))), { source: 'human', reason: 'x', raw });
  const r8 = patchRecord(r7, r7.partial!.flatMap((p) => p.errors.map((e) => ({ op: 'replace' as const, path: e.path, value: textCheck('设置页可见', '设置') }))), { source: 'human', reason: 'y', raw });
  expect(stateOf(r8)).toBe('可运行');
  return r8;
}

const run = (x: Partial<RunResult>): RunResult => ({ planId: 'p', issue: '2730', title: '', category: 'bug-always', surface: 'android-app', env: 'prod', conclusion: '执行失败', conclusionDetail: '', startedAt: '', finishedAt: '', stats: {} as RunResult['stats'], hits: [], incidents: [], targets: [], roundLog: [], planVersion: 8, sub: 'main', ...x });
const warmFail = (path: string, observed: string, extra: Record<string, unknown> = {}) => run({ conclusion: '计划不可执行', conclusionDetail: observed, warmup: { steps: [{ step: 0, action: '基线', expected: '基线成立', observed, pass: false, ms: 0, path, ...extra }], checks: [] } });
const passed = () => run({ conclusion: '未复现', executability: { validated: true, warmup: 'passed', driftRate: 0, unstable: false }, attempts: { valid: 30, hits: 0, drift: 0 } as RunResult['attempts'] });

describe('W3-7 failure point and cause (§8.1 ①②)', () => {
  it('warm-up steps carry their path; the cause follows the read', () => {
    expect(failurePoint(warmFail('baseline[0]', 'baseline[0]: 设置页可见 — "PREFERENCES" not on screen (126 nodes)'))).toMatchObject({ phase: 'warmup', path: 'baseline[0]', cause: 'plan' });
    expect(failurePoint(warmFail('baseline[0]', 'baseline[0]: read failed: socket hang up'))).toMatchObject({ cause: 'uncertain' });
    expect(failurePoint(warmFail('actions[1]', 'teamily.openSettings: the ☰ settings entry not on screen', { kind: 'executor' }))).toMatchObject({ path: 'actions[1]', cause: 'executor' });
    expect(failurePoint(warmFail('actions[2]', 'screen Δ0px (min 25920)'))).toMatchObject({ cause: 'uncertain' });
    expect(failurePoint(warmFail('actions[2].expect', 'expect（前置）不成立：「回复」 not on screen'))).toMatchObject({ cause: 'plan' });
  });

  it('preparation: the path the executor was on, the NodeError kind', () => {
    expect(failurePoint(run({ error: 'teamily.sendMessage: the composer did not take focus', at: 'setup[1]', errorKind: 'executor' }))).toMatchObject({ phase: 'prepare', path: 'setup[1]', cause: 'executor' });
    expect(failurePoint(run({ error: '目标核对连续 3 次不通过：msg — sender others', at: 'targets.msg.must' }))).toMatchObject({ path: 'targets.msg.must', cause: 'plan' });
    expect(failurePoint(run({ error: '前置条件未建立（x）— "y" not on screen', at: 'prepareCheck' }))).toMatchObject({ path: 'prepareCheck', cause: 'plan' });
    expect(failurePoint(run({ error: 'freezeMention: "a" not in the @ picker', at: 'prepare[0]', errorKind: 'environment' }))).toMatchObject({ cause: 'environment' });
    expect(failurePoint(run({ error: 'boom', at: 'setup[0]' }))).toMatchObject({ cause: 'uncertain' });
    expect(failurePoint(run({ conclusion: '环境不合格', conclusionDetail: '预检不合格：锁屏' }))).toMatchObject({ cause: 'environment' });
    expect(failurePoint(passed())).toBeUndefined();
  });

  it('an executor failure never triggers a revision (W7-R6 revisionTrigger)', () => {
    expect(revisionTrigger(run({ conclusion: '计划不可执行', warmup: { steps: [{ step: 2, action: 'x', expected: '', observed: 'menu did not open', pass: false, ms: 0, path: 'actions[1]', kind: 'executor' }], checks: [] } }))).toBeUndefined();
    expect(revisionTrigger(warmFail('baseline[0]', '"PREFERENCES" not on screen'))).toBe('warmup');
  });

  it('paths: order and pointers', () => {
    expect(pathRank('baseline[0]')).toBeLessThan(pathRank('actions[0]'));
    expect(pathRank('actions[1]')).toBeLessThan(pathRank('actions[1].expect'));
    expect(pathRank('actions[1].expect')).toBeLessThan(pathRank('afterCheck[0]'));
    expect(toPointer('main', 'actions[2].expect')).toBe('/subcases/main/plan/actions/2/expect');
    expect(toPointer('main', 'targets.msg.must')).toBe('/subcases/main/plan/targets/msg/must');
  });
});

describe('W3-7 deterministic fix, guard, R13 (§8.1 ③½ ⑤, §8.2)', () => {
  it('near candidates: case / width / the other language', () => {
    expect(nearCandidates('PREFERENCES & SECURITY', ['偏好与安全', '账户', 'Preferences & Security '])[0]).toMatchObject({ score: 1 });
    expect(nearCandidates('偏好与安全', ['PREFERENCES & SECURITY', '账户'])[0]).toMatchObject({ text: 'PREFERENCES & SECURITY', score: 0.95 });
  });

  it('one clear candidate → replace the match, source auto-fix; not on the phenomenon check', () => {
    const r = runnable();
    const fp = failurePoint(warmFail('baseline[0]', 'baseline[0]: 设置页可见 — "设置" not on screen'))!;
    const f = deterministicFix(r.envelope!, 'main', fp, { page: 'settings', texts: [{ t: 'Settings' }, { t: 'Account' }] })!;
    expect(f).toMatchObject({ source: 'auto-fix', ops: [{ op: 'replace', path: '/subcases/main/plan/baseline/0/match', value: { contains: 'Settings' } }] });
    // two different near texts: no deterministic choice
    expect(deterministicFix(r.envelope!, 'main', fp, { page: 'settings', texts: [{ t: 'Settings' }, { t: '设 置' }] })).toBeUndefined();
    expect(deterministicFix(r.envelope!, 'main', fp, { page: 'settings', texts: [{ t: 'Account' }] })).toBeUndefined();
    // an executor failure is never patched
    expect(deterministicFix(r.envelope!, 'main', { ...fp, cause: 'executor' }, { page: 'settings', texts: [{ t: 'Settings' }] })).toBeUndefined();
  });

  it('the judgment guard: oracle, understanding, the phenomenon check', () => {
    const env = runnable().envelope!;
    const i = (env.subcases[0].plan.actions as { expect?: { role: string } }[]).findIndex((a) => a.expect?.role === 'phenomenon');
    expect(touchesJudgment(env, { op: 'replace', path: '/understanding/phenomenon', value: 'x' })).toBeTruthy();
    expect(touchesJudgment(env, { op: 'replace', path: '/subcases/main/oracle/hit', value: 'x' })).toBeTruthy();
    if (i >= 0) expect(touchesJudgment(env, { op: 'remove', path: `/subcases/main/plan/actions/${i}/expect` })).toBeTruthy();
    expect(touchesJudgment(env, { op: 'replace', path: '/subcases/main/plan/baseline/0/match', value: {} })).toBeUndefined();
    const b = blockers(env, 'main', 'baseline[0]', { source: 'patch', ops: [{ op: 'replace', path: '/subcases/main/plan/setup/0', value: {} }], reason: 'x', scopeReason: null });
    expect(b.join()).toMatch(/超出可改范围/);
  });

  it('R13: texts never seen on a page are warned about (not errors)', () => {
    const f = emptyPages();
    expect(pageTextWarnings(runnable().subcases[0].plan, f)).toEqual([]); // nothing recorded: no warnings
    f.pages.zh.settings = { name: '设置页', seen: 5, first: '', last: '2026-11-19', surfaces: ['android-app'], texts: { 账户: { v: '账户', n: 5 } }, elements: {} };
    const w = pageTextWarnings(runnable().subcases[0].plan, f);
    expect(w.some((x) => /^R13 baseline\[0\]: 「设置」不在页面实录里/.test(x))).toBe(true);
  });

  it('stop rules: the point moves on → go; same path twice / back to an old rev / moved back → stop', () => {
    const fp = (path: string) => ({ phase: 'warmup' as const, path, expected: '', observed: '', cause: 'plan' as const, basis: '' });
    expect(nextMove([], fp('baseline[0]'), undefined, [])).toEqual({ go: true });
    expect(nextMove([{ rev: 9, path: 'baseline[0]', source: 'auto-fix', reason: '' }], fp('afterCheck[1]'), undefined, [])).toEqual({ go: true });
    expect(nextMove([{ rev: 9, path: 'baseline[0]', source: 'auto-fix', reason: '' }, { rev: 10, path: 'baseline[0]', source: 'patch', reason: '' }], fp('baseline[0]'), undefined, [])).toMatchObject({ go: false });
    expect(nextMove([{ rev: 9, path: 'afterCheck[1]', source: 'patch', reason: '' }], fp('baseline[0]'), undefined, [])).toMatchObject({ go: false });
    expect(nextMove([], fp('baseline[0]'), 'h1', ['h1'])).toMatchObject({ go: false });
    expect(nextMove([], { ...fp('x'), cause: 'executor' }, undefined, [])).toMatchObject({ go: false });
  });
});

describe('W3-7 repair loop (§8.1 ⑥⑦, fake runs)', () => {
  const deps = (rec: { r: PlanRecord }, runs: RunResult[], ask?: (s: string, u: string) => Promise<unknown>) => ({
    run: async () => runs.shift()!,
    load: () => rec.r,
    save: async (n: PlanRecord) => void (rec.r = n),
    raw,
    approve: () => ({ ok: true, why: 'default' }),
    ask: ask ?? (async () => undefined),
    remember: async () => undefined,
  });

  it('deterministic fix → rerun → passes: one rev, source auto-fix, no model call', async () => {
    const rec = { r: runnable() };
    const rev0 = rec.r.rev!;
    let asked = 0;
    const first = { ...warmFail('baseline[0]', 'baseline[0]: 设置页可见 — "设置" not on screen'), evidence: { page: 'settings', texts: [{ t: 'Settings', x: 1, y: 1 }] } };
    const remembered: string[] = [];
    const out = await repairLoop(first, 'main', { ...deps(rec, [passed()], async () => (asked++, undefined)), remember: async (c) => void remembered.push(c.name) });
    expect(asked).toBe(0);
    expect(out.steps).toEqual([expect.objectContaining({ rev: rev0 + 1, path: 'baseline[0]', source: 'auto-fix' })]);
    expect(rec.r.revs!.at(-1)).toMatchObject({ source: 'auto-fix' });
    expect(out.stop).toMatch(/修补后通过/);
    expect(remembered).toEqual(['repair-2730-main-baseline-0']);
  });

  it('executor failure: rerun once as is, then stop as 执行端失败 (plan untouched)', async () => {
    const rec = { r: runnable() };
    const rev0 = rec.r.rev;
    const ex = () => run({ error: 'teamily.openSettings: the ☰ settings entry not on screen', at: 'setup[0]', errorKind: 'executor' });
    const out = await repairLoop(ex(), 'main', deps(rec, [ex()]));
    expect(out.runs).toHaveLength(1);
    expect(out.executor).toMatchObject({ path: 'setup[0]' });
    expect(rec.r.rev).toBe(rev0);
  });

  it('a model patch on the phenomenon check is not applied: handed to a person with the suggestion', async () => {
    const rec = { r: runnable() };
    const env = rec.r.envelope!;
    const i = (env.subcases[0].plan.actions as { expect?: { role: string } }[]).findIndex((a) => a.expect?.role === 'phenomenon');
    if (i < 0) return;
    const first = warmFail(`actions[${i}].expect`, '检查无区分度：触发前就判「通过」');
    const ask = async () => ({ diagnosis: { category: '区分度', text: 'x' }, ops: [{ op: 'replace', path: `/subcases/main/plan/actions/${i}/expect/check/match`, value: { contains: 'y' } }], reason: 'r' });
    const out = await repairLoop(first, 'main', deps(rec, [], ask));
    expect(out.handoff?.why).toMatch(/判定保护/);
    expect(out.handoff?.suggestion).toBeTruthy();
  });
});
