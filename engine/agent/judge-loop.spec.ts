// W3-4: the exploration loop with its judgment on fakes (no device, no model): the checklist of the page in the
// prompt, a 不符合 that becomes an `expectation` finding reviewed against the entry, D10 after `input not
// committed`, and the same finding in a second run counted as a known issue (R7 / R8 logic; the real-phone
// acceptance is separate).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodePng } from '../../core/image';
import type { ScreenNode } from '../../core/screen-index';
import { tmpDir } from '../../core/testing/tmp-dir';
import type { Expectation } from '../explore/expectations';
import { readKnown } from '../explore/known';

// A noisy frame (not blank for the detectors); `v` shifts it so frames differ.
const png = (v: number) => {
  const w = 40;
  const h = 80;
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.writeUInt32BE((((i * 2654435761 + v * 97) >>> 0) | 0xff) >>> 0, i * 4);
  return encodePng({ width: w, height: h, data });
};
const chat: ScreenNode[] = JSON.parse(readFileSync('fixtures/pages/chat-images.json', 'utf8')).nodes;
const search = (text: string): ScreenNode => ({ text, desc: '搜索', rid: 'search', cls: 'android.widget.EditText', clickable: true, focused: true, hint: '搜索', box: [0, 100, 400, 80], center: { x: 200, y: 140 } });

const state = { fieldText: '', frame: 10 };
const prompts: string[] = [];
const answers: unknown[] = [];
const reviews: { expected: string; actual: string }[] = [];

vi.mock('../snapshot', () => ({
  snapshot: async () => ({ at: '', surface: 'android-app', source: 'fake', ms: { stable: 0, tree: 0, shot: 0, total: 0 }, width: 40, height: 80, nodes: [search(state.fieldText), ...chat], png: png(state.frame) }),
}));
vi.mock('../pretap', () => ({ PreTapGuard: class { async check(p: { x: number; y: number }) { return { kind: 'pass', point: p }; } } }));
vi.mock('../lease', () => ({ leaseFor: async () => ({ lease: {}, account: { id: 'acc' }, udid: 'u1' }), preflightFor: async () => undefined }));
vi.mock('../recorder/android-recorder', () => ({ AndroidFlightRecorder: class { onLog = () => {}; clockOffsetMs = 0; async start() {} async stop() {} async capture() { return undefined; } } }));
vi.mock('../recorder/bundle', async (orig) => ({ ...(await orig<typeof import('../recorder/bundle')>()), writeIncident: async () => '' }));
vi.mock('../recorder/evidence-review', async (orig) => ({
  ...(await orig<typeof import('../recorder/evidence-review')>()),
  reviewIncident: async (_dir: string, issue: { expected: string; actual: string }) => (reviews.push(issue), { verdict: 'consistent' }),
}));
vi.mock('../session', () => ({
  openSession: async () => ({
    surface: 'android-app',
    profile: { viewport: { width: 0, height: 0 }, skillVersion: '-', name: 'fake', packageName: 'ai.teamily.mobile' },
    inner: { surface: 'android-app', screenshot: async () => png(state.frame) },
    d: {
      step: 0, round: 0, label: '', ops: [], inputMode: 'direct',
      tap: async () => void (state.frame += 40),
      longPress: async () => void (state.frame += 40),
      key: async () => {},
      // The IME swallows the text: nothing reaches the field (D10's case).
      typeText: async () => {},
      swipe: async () => {}, back: async () => void (state.frame += 40), launch: async () => {},
      keyboardShown: async () => false,
      drainAnomalies: () => [],
    },
  }),
  closeSession: async () => {},
  enterApp: async () => {},
  openBenchSession: async () => { throw new Error('not bench'); },
  packageOf: () => 'ai.teamily.mobile',
}));
vi.mock('../../core/context/assemble', async (orig) => ({
  ...(await orig<typeof import('../../core/context/assemble')>()),
  modelCall: async (req: { slots: { name: string; content: unknown }[] }) => {
    prompts.push(req.slots.filter((s) => s.name === 'step').map((s) => s.content).join(''));
    const v = answers.shift();
    return { ok: true, value: v, raw: JSON.stringify(v), usage: { input: 0, output: 0, cached: 0 }, ms: 1, requests: 1, manifest: {} };
  },
}));

const env0 = { ...process.env };
beforeEach(() => {
  Object.assign(process.env, { MIDSCENE_MODEL_BASE_URL: 'http://m', MIDSCENE_MODEL_API_KEY: 'k', MIDSCENE_MODEL_NAME: 'm' });
  state.fieldText = '';
  state.frame = 10;
  prompts.length = 0;
  answers.length = 0;
  reviews.length = 0;
});
afterEach(() => {
  process.env = { ...env0 };
});

const E2063: Expectation = { id: 'issue-2063', page: '聊天页', trigger: '在一条纯 link 消息上长按', expect: '弹出消息动作面板，含 回复 / 转发 / 复制', source: 'issue#2063', enabled: true };
const pool = { ownContent: () => [], release: () => {} } as never;

describe('exploration judgment in the loop (W3-4, fakes)', () => {
  it('checklist per page → 不符合 = an expectation finding reviewed against the entry; D10; a second run counts the same issue as known', async () => {
    const { runAgent } = await import('./run');
    const knownFile = join(tmpDir('w3m4-judge-'), 'known.json');
    const run = (taskId: string, withD10: boolean) => {
      answers.push(
        // step 1: long-press the link message (element 2 = first chat element after the search box)
        { thought: 'try the menu', action: { type: 'longPress', target: 2 } },
        // step 2: the menu did not open
        { thought: 'no menu', action: { type: 'back' }, verify: { id: 'issue-2063', result: '不符合', evidence: '长按后没有任何菜单弹出' } },
        ...(withD10
          ? [
              // step 3: type into the search box — never reaches the field
              { thought: 'search', action: { type: 'type', target: 1, text: 'aaron' } },
              // step 4: the model reports the empty search box
              { thought: 'empty', action: { type: 'report_issue', description: '搜索框里不显示输入的文字' } },
            ]
          : []),
        { thought: 'done', action: { type: 'done', status: 'completed', summary: 'explored' } },
      );
      return runAgent({ goal: '探索消息模块', mode: 'explore', surface: 'android-app', env: 'prod', pool, runDir: tmpDir('w3m4-loop-'), taskId, maxSteps: 10, judge: { expectations: [E2063], knownFile } });
    };

    const r1 = await run('t1', true);
    expect(r1.status).toBe('completed');
    // the chat page's entry is in the first prompt, under its title; the page is on every step
    expect(prompts[0]).toContain('本页待核对的预期 (expectations for this page, 聊天页)');
    expect(prompts[0]).toContain('- [issue-2063] 在一条纯 link 消息上长按 → 弹出消息动作面板，含 回复 / 转发 / 复制');
    expect(r1.steps.every((s) => s.page === 'chat')).toBe(true);
    // 不符合 → finding of type expectation, the review judged against this entry
    const f1 = r1.findings.find((f) => f.source === 'expectation')!;
    expect(f1).toMatchObject({ kind: 'check-failed', counted: true, page: 'chat', step: 2, expectation: { id: 'issue-2063' }, known: { count: 1, isNew: true } });
    expect(reviews[0]).toEqual(expect.objectContaining({ expected: E2063.expect, actual: '长按后没有任何菜单弹出' }));
    expect(r1.expectations).toEqual([expect.objectContaining({ id: 'issue-2063', result: '不符合', checks: [{ step: 2, result: '不符合', evidence: '长按后没有任何菜单弹出' }], finding: f1.n })]);
    expect(r1.steps[1].verified).toEqual(['issue-2063 不符合']);
    expect(prompts[2]).toMatch(/^Checklist: issue-2063: 不符合 recorded as finding #1/);
    // once checked, the entry is marked so the model does not redo it
    expect(prompts[2]).toContain('(already checked: 不符合)');
    // D10: typed text never reached the field → the report after it does not count
    expect(r1.steps[2].readback).toEqual(['input not committed']);
    const d10 = r1.findings.find((f) => f.source === 'reported')!;
    expect(d10).toMatchObject({ counted: false });
    expect(d10.excluded).toMatch(/input not committed/);
    expect(r1.steps[3].result).toBe('issue not counted');
    expect(readFileSync(join(r1.runDir, 'report.md'), 'utf8')).toContain('## 预期核对');

    const r2 = await run('t2', false);
    // the known issue of this page is in the prompt; the same 不符合 bumps it instead of making a new one
    expect(prompts.find((p) => p.includes('已记录的问题'))).toContain('不符合预期「弹出消息动作面板，含 回复 / 转发 / 复制」：长按后没有任何菜单弹出 (seen 1×)');
    expect(r2.findings[0].known).toEqual({ id: 'K001', count: 2, isNew: false });
    const known = readKnown(knownFile);
    expect(known).toHaveLength(1);
    expect(known[0]).toMatchObject({ id: 'K001', page: 'chat', type: 'expectation:issue-2063', count: 2 });
    expect(known[0].runs.map((x) => x.run)).toEqual(['t1', 't2']);
  }, 60_000);
});
