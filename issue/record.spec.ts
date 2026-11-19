// W6-R6: the plan record — errors kept on their paths, patches applied and checked, rev / history / migration,
// rollback, diff, executor fields refused (R1 on the real 2730 delivery: only expect.check was wrong).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyOps, asRecord, compileRecord, contextOf, diffRevs, errorPath, patchRecord, type PlanRecord, revOf, rollbackRecord, stateOf } from './record';

const draft = () => JSON.parse(readFileSync('fixtures/w3m6/2730.draft.json', 'utf8'));
// issues/ is private (not in git): the delivery's verbatim quotes stand in for the Issue text (R12 checks them).
const raw = (draft().envelope.quotes as { text: string }[]).map((q) => q.text).join('\n');
const load = (): PlanRecord => asRecord(draft());
const textCheck = (expect: string, contains: string) => ({ kind: 'text', expect, match: { contains }, scope: 'screen' });

describe('W3-6 plan record', () => {
  it('error texts → paths', () => {
    expect(errorPath('main', 'subcases[main].plan actions.1.expect.check: expect.check must be a ① observation')).toMatchObject({ path: '/subcases/main/plan/actions/1/expect/check' });
    expect(errorPath('main', 'subcases[main] R5 baseline[0]: kind crash is not a ① state read')).toMatchObject({ path: '/subcases/main/plan/baseline/0' });
    expect(errorPath('c', 'subcases[c] R4 oracle.at "actions[2]" is not an action with expect')).toMatchObject({ path: '/subcases/c/oracle/at' });
    expect(errorPath('main', 'subcases[main] R2 targets.msg: needs must')).toMatchObject({ path: '/subcases/main/plan/targets/msg' });
    expect(errorPath('main', 'something odd')).toMatchObject({ path: '/subcases/main/plan' });
  });

  it('a delivery that fails validation is kept, with each error on its path (R1, §5 ③)', () => {
    const r = load();
    const f = compileRecord(r, r.envelope!, contextOf(r, 7, raw));
    expect(f.status).toBe('unplannable');
    expect(stateOf({ ...r, ...f })).toBe('校验未过');
    expect(f.partial!.map((p) => p.sub)).toEqual(['main', 'control']);
    expect(f.partial![0].errors.map((e) => e.path)).toEqual(['/subcases/main/plan/actions/1/expect/check', '/subcases/main/plan/actions/2/expect/check', '/subcases/main/plan/actions/3/expect/check']);
    expect(f.envelope!.understanding.phenomenon).toBeTruthy();
  });

  it('migration: a draft from before W3-6 becomes rev = its version with one history entry', () => {
    const r = load();
    expect(revOf(r)).toBe(6);
    expect(r.revs).toEqual([expect.objectContaining({ rev: 6, source: 'model' })]);
  });

  it('patches go through the same validation; rev +1 each, history keeps source, paths, reason; plan ids follow rev', () => {
    const r0 = load();
    const r = { ...r0, ...compileRecord(r0, r0.envelope!, contextOf(r0, 7, raw)) };
    const ops1 = r.partial!.flatMap((p) => p.errors.map((e) => ({ op: 'replace' as const, path: e.path, value: textCheck('设置列表滚到了偏好与安全分组', '偏好与安全') })));
    const r7 = patchRecord(r, ops1, { source: 'human', reason: 'expect.check 改成 ① 观察', raw });
    expect(r7.rev).toBe(7);
    expect(stateOf(r7)).toBe('校验未过');
    // the next layer (R-rules run once the schema passes): baseline reads
    expect(r7.partial!.flatMap((p) => p.errors.map((e) => e.path))).toEqual(['/subcases/main/plan/baseline/0', '/subcases/main/plan/baseline/1', '/subcases/control/plan/baseline/0', '/subcases/control/plan/baseline/1']);
    const ops2 = r7.partial!.flatMap((p) => p.errors.map((e) => ({ op: 'replace' as const, path: e.path, value: textCheck('设置页可见', '设置') })));
    const r8 = patchRecord(r7, ops2, { source: 'human', reason: 'baseline 改成 ① 读数', raw });
    expect(stateOf(r8)).toBe('可运行');
    expect(r8.version).toBe(8);
    expect(r8.subcases.map((s) => s.plan.id)).toEqual(['2730-android-app-v8', '2730-control-android-app-v8']);
    expect(r8.revs!.map((x) => [x.rev, x.source])).toEqual([[6, 'model'], [7, 'human'], [8, 'human']]);
    expect(r8.revs![1].paths).toHaveLength(6);
    expect(r8.hash).toBeTruthy();

    // diff by step; rollback makes a new rev with the old content, nothing deleted
    const d = diffRevs(r8, 6, 8);
    expect(d.changes.some((c) => c.path === '/subcases/main/plan/actions/1/expect/check/kind' && c.a === 'ai' && c.b === 'text')).toBe(true);
    const r9 = rollbackRecord(r8, 6, { raw });
    expect(r9.rev).toBe(9);
    expect(stateOf(r9)).toBe('校验未过');
    expect(r9.revs!.at(-1)).toMatchObject({ rev: 9, source: 'rollback', reason: '回退到 rev 6' });
    expect(r9.revs).toHaveLength(4);
  });

  it('refuses executor fields, bad paths, an empty reason', () => {
    const r = load();
    expect(() => applyOps(r.envelope!, [{ op: 'replace', path: '/subcases/main/plan/surface', value: 'desktop-web' }])).toThrow(/执行器负责/);
    expect(() => applyOps(r.envelope!, [{ op: 'replace', path: '/subcases/nope/plan/actions/0', value: {} }])).toThrow(/没有子用例/);
    expect(() => applyOps(r.envelope!, [{ op: 'replace', path: '/subcases/main/plan/actions/99', value: {} }])).toThrow(/越界/);
    expect(() => applyOps(r.envelope!, [{ op: 'replace', path: '/subcases/main/plan/nofield', value: 1 }])).toThrow(/新增用 add/);
    expect(() => patchRecord(r, [{ op: 'remove', path: '/risks/0' }], { source: 'human', reason: ' ', raw })).toThrow(/原因/);
    const added = applyOps(r.envelope!, [{ op: 'add', path: '/subcases/main/plan/actions/-', value: { type: 'wait', value: '300' } }, { op: 'remove', path: '/subcases/main/plan/actions/0' }]);
    expect(added.subcases[0].plan.actions).toHaveLength((r.envelope!.subcases[0].plan.actions as unknown[]).length);
  });
});
