// W2-4.1 T6 (device-free): the v1 task type `explore` — submission rules, outcome codes, the result view
// and finding → Issue through the API.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentResult } from '../engine/agent/run';
import { exploreCode } from '../scripts/task-exec';
import { apiV1 } from './api-v1';
import { setFullAccess } from './approval';
import { consentConfig, moveEnv, registerEnv } from './lifecycle/env';
import { getTask, moveTask, updateTask, writeResult } from './lifecycle/task';
import { exploreSentence, exploreSummary, resultText } from './views';
import { inboxReader } from './lifecycle/inbox';
import { userPrompt } from '../engine/agent/step';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w2m41e-'));
  process.env.AUTOTEST_STATE_DIR = dir;
  process.env.AUTOTEST_POLICY_FILE = join(dir, 'no-policy.yaml');
});
afterEach(() => {
  delete process.env.AUTOTEST_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const call = (method: string, path: string, body: any = {}, web = false) => apiV1({ method, path: `/api/v1${path}`, query: new URL(`http://x${path}`).searchParams, body, web }, {});
const ENV = 'desktop-web:edge@prod';
const ready = () => {
  registerEnv({ id: ENV, surface: 'desktop-web', serviceEnv: 'prod', device: 'edge', configItems: [] });
  moveEnv(ENV, 'checking', { by: 't', basis: 'x' });
  moveEnv(ENV, 'ready', { by: 't', basis: 'x' });
};

const agent = (over: Partial<AgentResult> = {}): AgentResult => ({
  schemaVersion: 1, kind: 'agent', goal: '打开通知铃铛', mode: 'task', surface: 'desktop-web', env: 'prod', writable: false, startedAt: '2026-11-03T02:00:00.000Z', finishedAt: '2026-11-03T02:03:00.000Z',
  status: 'completed', summary: '铃铛面板已打开', findings: [], blocked: [{ step: 3, action: 'tap #4 "Send"', reason: 'send' }], coverage: { screens: 4, actions: 7, byScreen: {} }, usage: { steps: 9, seconds: 180, modelCalls: 9 }, steps: [], runDir: '', ...over,
});

describe('W2-4.1 T6 explore task', () => {
  it('submits a goal as a queued explore task on the surface’s ready environment', async () => {
    ready();
    expect((await call('POST', '/tasks', { explore: '' })).code).toBe('BAD_INPUT');
    expect((await call('POST', '/tasks', { explore: 'x', surface: 'ios' })).code).toBe('BAD_INPUT');
    expect((await call('POST', '/tasks', { explore: 'x', surface: 'desktop-web', maxSteps: 5000 })).code).toBe('BAD_INPUT');
    // Hard limits 500 steps / 30 minutes (W2-5 N2): only tighter values are accepted.
    expect((await call('POST', '/tasks', { explore: 'x', surface: 'desktop-web', maxSteps: 501 })).code).toBe('BAD_INPUT');
    expect((await call('POST', '/tasks', { explore: 'x', surface: 'desktop-web', maxMinutes: 31 })).code).toBe('BAD_INPUT');
    expect((await call('POST', '/tasks', { explore: 'x', surface: 'desktop-web', env: 'test' })).code).toBe('ENV_OFFLINE');
    expect((await call('POST', '/tasks', { explore: 'x', surface: 'desktop-web', dryRun: true })).code).toBe('OK');
    const a = await call('POST', '/tasks', { explore: '打开通知铃铛', mode: 'task', surface: 'desktop-web', maxSteps: 40 });
    expect(a.code).toBe('ACCEPTED');
    const t = getTask((a.data as any).id)!;
    expect(t).toMatchObject({ kind: 'explore', envId: ENV, explore: { goal: '打开通知铃铛', mode: 'task', writable: false }, options: { maxSteps: 40 } });
    expect((a.data as any).summary).toMatch(/任务「打开通知铃铛」/);
  });

  it('instructions reach a running exploration task at the next step; refused once it ended (W2-5 §7.2)', async () => {
    ready();
    const id = ((await call('POST', '/tasks', { explore: '浏览发现页', surface: 'desktop-web' })).data as any).id as string;
    expect((await call('POST', '/explore/nope/inject', { text: 'x' })).code).toBe('NOT_FOUND');
    expect((await call('POST', `/explore/${id}/inject`, { text: '  ' })).code).toBe('BAD_INPUT');
    const read = inboxReader(id);
    expect(read()).toEqual([]);
    const r = await call('POST', `/explore/${id}/inject`, { text: '先看看设置页' });
    expect(r).toMatchObject({ code: 'OK', data: { instructions: 1 } });
    expect(read()).toEqual(['先看看设置页']);
    expect(read()).toEqual([]);
    expect(((await call('GET', `/tasks/${id}`)).data as any).instructions).toMatchObject([{ text: '先看看设置页' }]);
    expect(userPrompt({ goal: 'g', mode: 'explore', history: '', screen: 's', els: [], tried: [], size: { width: 1, height: 1 }, instructions: ['先看看设置页'] })).toContain('- 先看看设置页');
    for (const st of ['waiting-env', 'preflight', 'running', 'finishing', 'done'] as const) moveTask(id, st, 'task', 't');
    expect((await call('POST', `/explore/${id}/inject`, { text: '再看看' })).code).toBe('BAD_INPUT');
  });

  it('writable needs full access; configuration items need consent', async () => {
    registerEnv({ id: ENV, surface: 'desktop-web', serviceEnv: 'prod', device: 'edge', configItems: [{ id: 'c', what: 'cookie', why: 'w', restore: 'r' }] });
    moveEnv(ENV, 'checking', { by: 't', basis: 'x' });
    moveEnv(ENV, 'ready', { by: 't', basis: 'x' });
    expect((await call('POST', '/tasks', { explore: 'x', surface: 'desktop-web' })).code).toBe('APPROVAL_REQUIRED');
    consentConfig(ENV, 'c', 'aaron');
    expect((await call('POST', '/tasks', { explore: 'x', surface: 'desktop-web', writable: true })).code).toBe('APPROVAL_REQUIRED');
    setFullAccess(true, 'aaron');
    expect((await call('POST', '/tasks', { explore: 'x', surface: 'desktop-web', writable: true })).code).toBe('ACCEPTED');
  });

  it('outcome codes: findings 18, none 19, env-unfit / error / cancelled as for plans', () => {
    const f = { n: 1, source: 'hard', kind: 'app-exit', description: 'x', step: 2, screen: 's', incident: 'i', counted: true, path: [] as string[] } as const;
    expect(exploreCode(agent())).toBe('EXPLORE_DONE');
    expect(exploreCode(agent({ findings: [f] }))).toBe('EXPLORE_FINDINGS');
    expect(exploreCode(agent({ findings: [{ ...f, counted: false }] }))).toBe('EXPLORE_DONE');
    expect(exploreCode(agent({ status: 'env-unfit', summary: '环境不合格：锁屏（keyguard true）' }))).toBe('ENV_LOCKED');
    expect(exploreCode(agent({ status: 'error' }))).toBe('TOOL_FAILED');
    expect(exploreCode(agent({ status: 'cancelled' }))).toBe('CANCELLED');
  });

  it('result show: sentence, findings, coverage, blocked and usage; finding → Issue through the API', async () => {
    ready();
    const a = await call('POST', '/tasks', { explore: '打开通知铃铛', mode: 'task', surface: 'desktop-web' });
    const id = (a.data as any).id;
    const runDir = resolve('midscene_run/explore', `spec-${id}`);
    const f = { n: 1, source: 'reported', kind: 'visual-anomaly', description: '铃铛面板空白', step: 5, screen: 's', incident: join(runDir, 'incidents/1'), review: 'consistent', counted: true, path: ['tap #3 "Notifications"'] as string[] } as const;
    const r = agent({ findings: [f], runDir });
    mkdirSync(runDir, { recursive: true });
    try {
      writeFileSync(join(runDir, 'result.json'), JSON.stringify(r));
      updateTask(id, (t) => void (t.runDir = runDir));
      for (const s of ['waiting-env', 'preflight', 'running', 'finishing'] as const) moveTask(id, s, 'task', 't');
      moveTask(id, 'done', 'task', 't', (t) => void Object.assign(t, { outcome: { code: 'EXPLORE_FINDINGS', summary: '1 个发现' }, endedBy: 'normal' }));
      writeResult(id, { schemaVersion: 1, taskId: id, planId: 'explore:task', code: 'EXPLORE_FINDINGS', agent: r, runDir });
      const res = await call('GET', `/results/${id}`);
      expect(res.code).toBe('EXPLORE_FINDINGS');
      expect(res.exit).toBe(18);
      expect(res.summary).toBe('任务完成：1 个发现；9 步，模型调用 9 次');
      expect((res.data as any).explore).toEqual(exploreSummary(r));
      expect((res.data as any).evidence.incidents).toEqual([f.incident]);
      expect(resultText(res.data as any)).toMatch(/发现 #1 模型报告 visual-anomaly：铃铛面板空白；复核 consistent/);
      expect((await call('POST', `/explore/${id}/issue`, { n: 2 })).code).toBe('NOT_FOUND');
      expect((await call('POST', '/explore/..%2F..%2Fetc/issue', { n: 1 })).code).toBe('BAD_INPUT');
      const iss = await call('POST', `/explore/${id}/issue`, { n: 1 });
      expect(iss.code).toBe('OK');
      expect((iss.data as any).issue).toBe('explore-20261103020000-1');
      rmSync((iss.data as any).file, { force: true });
      // Task page steps (§7): thumbnail URL, reasoning, blocked reason, from the trajectory.
      writeFileSync(join(runDir, 'trajectory.jsonl'), [{ t: 'a', step: 1, action: 'tap #3 "Notifications"', thought: 'open it', thumb: 'steps/0001.png', kind: 'agent.step' }, { t: 'b', step: 2, action: 'tap #4 "Like"', thought: 'like', thumb: 'steps/0002.png', kind: 'agent.step' }, { step: 2, reason: 'social', kind: 'blocked' }].map((x) => JSON.stringify(x)).join('\n'));
      const st = await call('GET', `/tasks/${id}/steps`);
      expect((st.data as any).steps.map((s: any) => [s.step, s.blocked ?? null])).toEqual([[1, null], [2, 'social']]);
      expect((st.data as any).steps[0].thumb).toBe(`/files/explore/spec-${id}/steps/0001.png`);
      expect((st.data as any).latest).toBe(`/files/explore/spec-${id}/steps/0002.png`);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('no findings: coverage and blocked count in the sentence', () => {
    expect(exploreSentence(exploreSummary(agent({ mode: 'explore' })))).toBe('探索完成：未发现问题（覆盖 4 个界面、7 个动作，拦截 1 次）；9 步，模型调用 9 次');
    expect(exploreSentence(exploreSummary(agent({ status: 'limit' })))).toMatch(/^任务到达上限/);
  });
});
