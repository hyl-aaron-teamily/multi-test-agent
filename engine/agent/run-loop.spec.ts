// W3-3: the exploration loop end to end on fakes (bench mode: no lease, recorders or detectors). The session,
// snapshots, the pre-tap check and the model are replaced; everything in engine/agent runs for real.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodePng } from '../../core/image';
import type { ScreenNode } from '../../core/screen-index';
import { tmpDir } from '../../core/testing/tmp-dir';

const png = (v: number) => encodePng({ width: 40, height: 80, data: Buffer.alloc(40 * 80 * 4, v) });
const field = (text: string): ScreenNode => ({ text, desc: '', rid: 'title', cls: 'android.widget.EditText', clickable: true, focused: true, box: [0, 100, 400, 80], center: { x: 200, y: 140 } });
const save: ScreenNode = { text: 'Save', desc: '', rid: '', cls: 'android.widget.Button', clickable: true, box: [0, 300, 200, 80], center: { x: 100, y: 340 } };

const state = { fieldText: '', frame: 10 };
const prompts: string[] = [];
const answers: unknown[] = [];
const keys: string[] = [];

vi.mock('../snapshot', () => ({
  snapshot: async () => ({ at: '', surface: 'android-app', source: 'fake', ms: { stable: 0, tree: 0, shot: 0, total: 0 }, width: 40, height: 80, nodes: [field(state.fieldText), save], png: png(state.frame) }),
}));
vi.mock('../pretap', () => ({ PreTapGuard: class { async check(p: { x: number; y: number }) { return { kind: 'pass', point: p }; } } }));
vi.mock('../session', () => ({
  openBenchSession: async () => ({
    surface: 'android-app',
    profile: { viewport: { width: 0, height: 0 }, skillVersion: '-', name: 'fake', packageName: '' },
    inner: { surface: 'android-app', screenshot: async () => png(state.frame) },
    d: {
      step: 0, round: 0, label: '', ops: [], inputMode: 'direct',
      tap: async () => void (state.frame += 40),
      longPress: async () => {},
      key: async (k: string) => void keys.push(k),
      typeText: async (t: string) => void (state.fieldText = t),
      swipe: async () => {}, back: async () => {}, launch: async () => {},
      keyboardShown: async () => false,
      drainAnomalies: () => [],
    },
  }),
  closeSession: async () => {},
  enterApp: async () => {},
  openSession: async () => { throw new Error('not in bench'); },
  packageOf: () => '',
}));
vi.mock('../../core/context/assemble', async (orig) => ({
  ...(await orig<typeof import('../../core/context/assemble')>()),
  modelCall: async (req: { purpose: string; slots: { name: string; content: unknown }[] }) => {
    prompts.push(req.slots.filter((s) => s.name !== 'role' && typeof s.content === 'string').map((s) => s.content).join('\n---\n'));
    const v = answers.shift();
    return { ok: true, value: v, raw: JSON.stringify(v), usage: { input: 0, output: 0, cached: 0 }, ms: 1, requests: 1, manifest: {} };
  },
}));

const env0 = { ...process.env };
beforeEach(() => {
  Object.assign(process.env, { MIDSCENE_MODEL_BASE_URL: 'http://m', MIDSCENE_MODEL_API_KEY: 'k', MIDSCENE_MODEL_NAME: 'm' });
  for (const k of ['ISSUE_NO_VISION', 'EVIDENCE_VISION_MODEL']) delete process.env[k];
  state.fieldText = '';
  state.frame = 10;
  prompts.length = 0;
  keys.length = 0;
  answers.length = 0;
});
afterEach(() => {
  process.env = { ...env0 };
});

describe('exploration loop (W3-3, fakes)', () => {
  it('unusable answer → asked again with the reason → a turn; typed text read back; note kept; review not passed → continue; passed → done', async () => {
    const { runAgent } = await import('./run');
    answers.push(
      // step 1: an index that is not on the screen, twice → one "no usable action" turn
      { thought: 'a', action: { type: 'tap', target: 99 } },
      { thought: 'a', action: { type: 'tap', target: 99 } },
      // step 2: a note rides along; type into the focused field (no tap), replacing what is there
      { thought: 'b', plan: '- [x] title set\n- [ ] save', action: { type: 'type', target: 1, text: 'Caprese', at: 'replace' }, then: [{ type: 'note', key: 'recipe', content: 'Caprese, 2 servings', mode: 'save' }] },
      // step 3: done → the review does not pass
      { thought: 'c', action: { type: 'done', status: 'completed', summary: 'saved' } },
      { verdicts: [{ item: 'the recipe is saved', status: 'failed', evidence: 'Save was never tapped', suggestion: 'tap Save' }], unmet: ['title set'] },
      // step 4: tap Save
      { thought: 'd', action: { type: 'tap', target: 2 } },
      // step 5: done → the review passes
      { thought: 'e', action: { type: 'done', status: 'completed', summary: 'saved' } },
      { verdicts: [{ item: 'the recipe is saved', status: 'passed', evidence: 'list shows Caprese' }], unmet: [] },
    );
    const runDir = tmpDir('w3m3-loop-');
    const r = await runAgent({ goal: 'add the recipe Caprese', mode: 'task', surface: 'android-app', env: 'prod', runDir, bench: { udid: 'emu', act: async () => {} }, maxSteps: 10 });
    expect(r.status).toBe('completed');
    expect(r.unusable).toBe(1);
    expect(r.steps.map((s) => s.result.split(';')[0])).toEqual(['no usable action', '#1 ok', 'done (completed) → final review not passed', 'ok', 'done (completed)']);
    // F2: the second call carries the reason
    expect(prompts[1]).toContain('Your previous answer could not be used: Invalid target index 99. Active index range is 1 to 2.');
    // F7: the next turn opens with it
    expect(prompts[2]).toMatch(/^You did not give a usable action last turn \(Invalid target index 99/);
    // F9: focused field not tapped; cursor to the end, select all, 21 deletes; read back
    expect(keys.slice(0, 2)).toEqual(['ctrlend', 'selectall']);
    expect(keys.filter((k) => k === 'del')).toHaveLength(21);
    expect(r.steps[1]).toMatchObject({ typed: ['Caprese'], readback: ['Caprese'], notes: ['recipe'] });
    expect(r.notes).toEqual({ recipe: 'Caprese, 2 servings' });
    // F6: the review's reasons at the top of the next prompt, the plan item reverted
    expect(prompts[5]).toMatch(/^--- Final review \(not passed\) ---\n- \[verify failed\] 'the recipe is saved': Save was never tapped Suggestion: tap Save/);
    expect(prompts[5]).toContain('- [/] title set');
    expect(r.checks?.map((c) => c.passed)).toEqual([false, true]);
    expect(r.usage.checkCalls).toBe(2);
    // F5: notes in every prompt after they were written; F8: typed text verbatim in the history
    expect(prompts[3]).toContain('Notes (yours, verbatim):\n## recipe\nCaprese, 2 servings');
    expect(prompts[3]).toContain(`type #1 "" "Caprese" (at replace) → note save 'recipe' -> #1 ok; field now: "Caprese"; #2 Saved note 'recipe'.`);
    expect(readFileSync(join(runDir, 'notes', 'recipe.md'), 'utf8')).toBe('Caprese, 2 servings');
    expect(readFileSync(join(runDir, 'report.md'), 'utf8')).toContain('结束复核：2 次，通过 1，不通过 1');
  }, 30_000);

  it('the same unusable answer twice in a row ends the run as failed; the same review failure without a screen change stops too', async () => {
    const { runAgent } = await import('./run');
    const bad = { thought: 'x', action: { type: 'fly' } };
    answers.push(bad, bad, bad, bad);
    const r1 = await runAgent({ goal: 'g', mode: 'task', surface: 'android-app', env: 'prod', runDir: tmpDir('w3m3-loop-'), bench: { udid: 'emu', act: async () => {} }, maxSteps: 10 });
    expect(r1.status).toBe('failed');
    expect(r1.summary).toMatch(/模型重复给出同一个不可用的回答/);
    expect(r1.steps).toHaveLength(1);

    const fail = { verdicts: [{ item: 'saved', status: 'failed', evidence: 'not in the list' }], unmet: [] };
    answers.push({ thought: '', action: { type: 'done', status: 'completed', summary: 's' } }, fail, { thought: '', action: { type: 'wait', ms: 1 } }, { thought: '', action: { type: 'done', status: 'completed', summary: 's' } }, fail);
    const r2 = await runAgent({ goal: 'g', mode: 'task', surface: 'android-app', env: 'prod', runDir: tmpDir('w3m3-loop-'), bench: { udid: 'emu', act: async () => {} }, maxSteps: 10 });
    expect(r2.status).toBe('failed');
    expect(r2.summary).toMatch(/^复核两次结论相同、其间画面没有变化：saved（not in the list）/);
    // the wait between did not change the screen
    expect(r2.steps[1]).toMatchObject({ changed: false });
  }, 30_000);
});
