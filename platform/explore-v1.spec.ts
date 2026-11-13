// W3-4 §8.5 ②⑤ (device-free): people's marks on a finished exploration through /api/v1 — 「这是问题」 on a step
// (a finding with the step's screenshot), 「不是问题」 on a finding (triage.json + the known issue), the
// checklist API, focus modules into the goal; the result view counts what people marked.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodePng } from '../core/image';
import type { AgentResult } from '../engine/agent/run';
import { readKnown, readTriage } from '../engine/explore/known';
import { apiV1 } from './api-v1';
import { createTask, readResult, writeResult } from './lifecycle/task';
import { exploreSummary, exploreSentence } from './views';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w3m4p-'));
  process.env.AUTOTEST_STATE_DIR = join(dir, 'state');
  process.env.AUTOTEST_EXPLORE_DIR = join(dir, 'explore');
  process.env.AUTOTEST_POLICY_FILE = join(dir, 'no-policy.yaml');
});
afterEach(() => {
  for (const k of ['AUTOTEST_STATE_DIR', 'AUTOTEST_EXPLORE_DIR', 'AUTOTEST_POLICY_FILE']) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

const call = (method: string, path: string, body: unknown = {}) => apiV1({ method, path: `/api/v1${path}`, query: new URLSearchParams(), body, web: true }, {});

function finishedRun(id: string): AgentResult {
  const runDir = join(dir, 'run');
  mkdirSync(join(runDir, 'steps'), { recursive: true });
  writeFileSync(join(runDir, 'steps', '0002.png'), encodePng({ width: 4, height: 4, data: Buffer.alloc(64, 200) }));
  const r = {
    schemaVersion: 1, kind: 'agent', goal: '探索', mode: 'explore', surface: 'android-app', env: 'prod', writable: false, startedAt: '', finishedAt: '', status: 'completed', summary: 'done',
    findings: [{ n: 1, source: 'reported', kind: 'visual-anomaly', description: '骨架屏一直不消失', step: 1, screen: 's1', incident: join(runDir, 'incidents', '1-visual-anomaly'), counted: true, path: [], page: 'home', review: 'consistent' }],
    blocked: [], coverage: { screens: 1, actions: 2, byScreen: {} }, usage: { steps: 2, seconds: 60, modelCalls: 2 },
    steps: [{ step: 1, screen: 's1', action: 'swipe up', result: 'ok', page: 'home' }, { step: 2, screen: 's2', action: 'tap #3 "未读"', result: 'ok', thumb: 'steps/0002.png', page: 'home' }],
    runDir,
  } as unknown as AgentResult;
  createTask({ id, kind: 'explore', issue: 'explore', planId: 'explore:explore', planHash: '-', envId: 'android-app:x@prod', options: {}, explore: { goal: '探索', mode: 'explore', writable: false } });
  writeResult(id, { schemaVersion: 1, taskId: id, code: 'EXPLORE_FINDINGS', agent: r, runDir });
  return r;
}

describe('marks on a finished exploration (W3-4 §8.5 ②)', () => {
  it('这是问题 on a step → a human finding with the step’s screenshot; 不是问题 on a finding → triage.json and the known issue; the view stops counting it', async () => {
    finishedRun('T1');
    const m = await call('POST', '/explore/T1/mark', { step: 2, note: '「未读」筛选下同时出现会话和「没有未读会话」' });
    expect(m.code).toBe('OK');
    const r = readResult<{ agent: AgentResult }>('T1')!.agent;
    const h = r.findings[1];
    expect(h).toMatchObject({ n: 2, source: 'human', counted: true, step: 2, page: 'home', triage: { verdict: 'issue' }, known: { isNew: true } });
    expect(existsSync(join(h.incident, 'step.png'))).toBe(true);
    expect(readFileSync(join(h.incident, 'index.html'), 'utf8')).toContain('没有未读会话');

    const t = await call('POST', '/explore/T1/triage', { n: 1, verdict: 'env', note: '测试账号数据问题' });
    expect(t.code).toBe('OK');
    const r2 = readResult<{ agent: AgentResult }>('T1')!.agent;
    expect(r2.findings[0].triage).toMatchObject({ verdict: 'env', note: '测试账号数据问题' });
    expect(readTriage().map((x) => [x.n, x.verdict])).toEqual([[2, 'issue'], [1, 'env']]);
    const k = readKnown();
    expect(k.find((x) => x.sample === '骨架屏一直不消失')?.triage?.verdict).toBe('env');
    // the run dir's own result follows
    expect(JSON.parse(readFileSync(join(r2.runDir, 'result.json'), 'utf8')).findings[0].triage.verdict).toBe('env');
    const v = exploreSummary(r2);
    expect(v.findings.map((f) => f.state)).toEqual(['人工标注：环境问题（测试账号数据问题）', '人工标注：是问题（「未读」筛选下同时出现会话和「没有未读会话」）']);
    expect(exploreSentence(v)).toMatch(/^探索完成：1 个发现/);
    // a second triage of the same finding replaces the first
    await call('POST', '/explore/T1/triage', { n: 1, verdict: 'not-issue' });
    expect(readTriage().filter((x) => x.n === 1).map((x) => x.verdict)).toEqual(['not-issue']);

    expect((await call('POST', '/explore/T1/mark', { step: 9, note: 'x' })).code).toBe('NOT_FOUND');
    expect((await call('POST', '/explore/T1/mark', { step: 2, note: '' })).code).toBe('BAD_INPUT');
    expect((await call('POST', '/explore/T1/triage', { n: 1, verdict: 'maybe' })).code).toBe('BAD_INPUT');
  });

  it('checklist API: add, change, disable, delete; an unknown page is refused; extract from the drafts keeps people’s edits', async () => {
    expect((await call('POST', '/explore/expectations/msg-longpress-menu', { page: '聊天页', trigger: '长按一条链接消息', expect: '弹出菜单，含 回复 / 复制 / 转发' })).code).toBe('OK');
    expect((await call('POST', '/explore/expectations/x', { page: '火星页', trigger: 't', expect: 'e' })).code).toBe('BAD_INPUT');
    expect((await call('POST', '/explore/expectations/msg-longpress-menu', { enabled: false })).data).toMatchObject({ enabled: false, trigger: '长按一条链接消息', source: 'manual' });
    // a draft in the current format (the committed fixture drafts predate `understanding`)
    const drafts = join(dir, 'drafts');
    mkdirSync(drafts);
    writeFileSync(join(drafts, '2063.json'), JSON.stringify({ issue: { id: '2063' }, subcases: [{ surface: 'android-app', plan: { understanding: { subject: '纯 link 消息', trigger: '在这条纯 link 消息上长按', expected: '弹出消息动作面板' } } }] }));
    process.env.AUTOTEST_DRAFTS_DIR = drafts;
    const ex = await call('POST', '/explore/expectations/extract');
    process.env.AUTOTEST_DRAFTS_DIR = 'issue/__fixtures__/drafts';
    expect(ex.code).toBe('OK');
    const list = (await call('GET', '/explore/expectations')).data as { items: { id: string; enabled: boolean; page: string }[] };
    expect(list.items.find((e) => e.id === 'msg-longpress-menu')?.enabled).toBe(false);
    expect(list.items.find((e) => e.id === 'issue-2063')).toMatchObject({ enabled: true, page: 'chat' });
    expect((await call('DELETE', '/explore/expectations/msg-longpress-menu')).code).toBe('OK');
    expect((await call('DELETE', '/explore/expectations/msg-longpress-menu')).code).toBe('NOT_FOUND');
  });

  it('focus modules: ranked list; unknown ids refused on submit', async () => {
    const m = (await call('GET', '/explore/modules')).data as { id: string; issues: number }[];
    expect(m.length).toBeGreaterThan(5);
    expect(m[0].issues).toBeGreaterThanOrEqual(m.at(-1)!.issues);
    const bad = await call('POST', '/tasks', { explore: '看看', focus: ['nope'], dryRun: true });
    expect(bad.code).toBe('BAD_INPUT');
    expect(bad.summary).toMatch(/不认识的模块 nope/);
  });
});
