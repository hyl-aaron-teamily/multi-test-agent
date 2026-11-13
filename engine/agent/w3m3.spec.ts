// W3-3 (§8.6) exploration executor: notes (F5), final review (F6), incidents and screen change (F7), ledger and
// search (F8), typing and read-back (F9), focus (F10).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Rgba } from '../../core/image';
import { normalizeNodes, type ScreenNode } from '../../core/screen-index';
import { parseNodes } from '../../core/ui-tree';
import { escapeAdbText, AndroidDriver, keyable, textLines } from '../../drivers/android';
import { tmpDir } from '../../core/testing/tmp-dir';
import { checkerPrompt, failureKey, feedbackBlock, normalizeReport, passes, revertPlan } from './checker';
import { historyText, KEEP_STEPS, ledgerLine, newScreenText, offset, searchHistory } from './history';
import { categoryOf, Incidents, ScreenMemory, screenChanged } from './incident';
import { cleanLine, fuzzyMatch, Notes, relaxedMatch, similarity, updateText } from './notes';
import { describe as describeAction, fieldAfterTyping, landed, readbackOf } from './run';
import type { StepRecord } from './step';
import type { AgentResult } from './run';

const node = (o: Partial<ScreenNode> & { text?: string }): ScreenNode => ({ text: '', desc: '', rid: '', cls: 'android.widget.TextView', clickable: false, box: [0, 0, 100, 40], center: { x: 50, y: 20 }, ...o });

describe('W3-3 F5 notes', () => {
  it('similarity is difflib ratio', () => {
    expect(similarity('abcd', 'abcd')).toBe(1);
    expect(similarity('abcd', 'bcde')).toBeCloseTo(0.75);
    expect(similarity('', 'x')).toBe(0);
  });

  it('update: exact, then relaxed (case, quotes, bullets, spaces), then fuzzy ≥ 0.9; ambiguity is an error', () => {
    const note = '- [ ] Caprese salad: 2 servings\n- [x] Pasta: 4 servings\n';
    expect(updateText(note, 'r', 'Pasta: 4', 'Pasta: 3')).toEqual({ content: '- [ ] Caprese salad: 2 servings\n- [x] Pasta: 3 servings\n' });
    const relaxed = updateText(note, 'r', '* "pasta: 4 servings"', '- [x] Pasta: 5 servings');
    expect(relaxed.content).toBe('- [ ] Caprese salad: 2 servings\n- [x] Pasta: 5 servings\n');
    expect(relaxed.warning).toMatch(/did our best/);
    expect(cleanLine('- [x] "Pasta":  4')).toBe('pasta:4');
    expect(relaxedMatch(note, 'caprese salad: 2 servings')).toEqual([0, 32]);
    expect(fuzzyMatch(note, 'Caprese salad: 2 serving')).toEqual([0, 32]);
    expect(() => updateText('a\na\n', 'r', 'a', 'b')).toThrow(/not unique/);
    expect(() => updateText(note, 'r', 'Lasagne', 'x')).toThrow(/not found in note 'r'/);
  });

  it('notes go to files and to every prompt verbatim; append adds a newline', () => {
    const dir = tmpDir('w3m3-notes-');
    const nt = new Notes(dir);
    expect(nt.apply({ key: 'receipt', content: 'Milk 2.99', mode: 'save' })).toBe("Saved note 'receipt'.");
    expect(nt.apply({ key: 'receipt', content: 'Bread 1.50', mode: 'append' })).toBe("Appended to note 'receipt'.");
    expect(nt.apply({ key: 'receipt', content: 'Milk 3.09', mode: 'update', target: 'Milk 2.99' })).toBe("Updated note 'receipt'.");
    expect(readFileSync(join(dir, 'receipt.md'), 'utf8')).toBe('Milk 3.09\nBread 1.50');
    expect(nt.text()).toBe('## receipt\nMilk 3.09\nBread 1.50');
    expect(() => nt.apply({ key: 'none', content: 'x', mode: 'update', target: 'y' })).toThrow(/not found/);
  });
});

describe('W3-3 F8 ledger and search', () => {
  const st = (i: number, o: Partial<StepRecord> = {}): StepRecord => ({ step: i, screen: 's', action: `tap #${i}`, result: 'ok', at: i * 1000, thought: `t${i}`, ...o });

  it('one line per step, typed text in full, read-backs and unchanged marks; offsets as T+mm:ss', () => {
    expect(offset(75_000)).toBe('T+01:15');
    const long = 'Line one of a long note that used to be cut at forty characters\nline two';
    expect(ledgerLine(st(3, { action: `type #2 "Body" ${JSON.stringify(long)}`, readback: [long], changed: false }), true)).toBe(`#3 (T+00:03) [screen s] type #2 "Body" ${JSON.stringify(long)} -> ok; screen unchanged; field now '${long}' | thought: t3`);
  });

  it('older steps stay as ledger lines (identical neighbours merged); the last 12 carry the thought', () => {
    const steps = [...Array.from({ length: 5 }, (_, i) => st(i + 1, { action: 'swipe up' })), ...Array.from({ length: 15 }, (_, i) => st(i + 6))];
    const h = historyText(steps).split('\n');
    expect(h[0]).toBe('#1–#5 (T+00:01) ×5 [screen s] swipe up -> ok');
    expect(h.filter((l) => l.includes('| thought:'))).toHaveLength(KEEP_STEPS);
    expect(h).toHaveLength(1 + 3 + KEEP_STEPS);
  });

  it('screen text delta and search over ledger, screen text and notes', () => {
    expect(newScreenText([node({ text: 'A' })], [node({ text: 'A' }), node({ text: 'Total 42.10' })])).toBe('Total 42.10');
    const steps = [st(1, { newText: 'Caprese salad | 2 servings' }), st(2), st(3, { newText: 'Caprese salad' })];
    const out = searchHistory(steps, [['menu', 'caprese on day 2']], { query: 'Caprese servings' });
    expect(out.split('\n')[1]).toMatch(/^- step 1: /);
    expect(out).toContain('notes: note');
    expect(searchHistory(steps, [], { query: 'caprese', from: 3 })).not.toContain('step 1:');
    expect(searchHistory(steps, [], { query: 'lasagne' })).toMatch(/no matches/);
  });
});

describe('W3-3 F7 incidents and screen change', () => {
  it('an incident stays at the top until an action goes through, then shows once as closed', () => {
    const inc = new Incidents();
    inc.afterTurn(4, { action: 'tap #3 "Save"', reason: 'pre-tap check: target disappeared (gone) — not tapped', category: categoryOf('pre-tap check: target disappeared (gone)'), index: 0, burst: 1 }, { action: 'tap #9 "Menu"', step: 3 });
    expect(inc.block()).toContain('--- Execution Incident (OPEN) ---\nOpened at Step 4; consecutive failed turns: 1.');
    expect(inc.block()).toContain('Your last dispatched action was `tap #9 "Menu"` (Step 3)');
    inc.afterTurn(5, { action: 'tap #3 "Save"', reason: 'error: adb', category: 'driver_error', index: 1, burst: 3 });
    expect(inc.block()).toMatch(/consecutive failed turns: 2[\s\S]*action 2 of your 3-action burst[\s\S]*The 1 action\(s\) after it were NOT executed/);
    inc.afterTurn(6, undefined);
    expect(inc.block()).toMatch(/^--- Execution Incident \(CLOSED at Step 6\) ---/);
    expect(inc.block()).toBe('');
    expect(categoryOf('x', true)).toBe('blocked');
    expect(categoryOf('pre-tap check: target occupied (a dialog)')).toBe('target_occupied');
  });

  it('changed = more than 0.3 % of pixels; "like after step N" by dHash', () => {
    const img = (v: number, w = 100, h = 100): Rgba => ({ width: w, height: h, data: Buffer.alloc(w * h * 4, v) });
    const a = img(0);
    const b = img(0);
    b.data.fill(255, 0, 4 * 20); // 20 of 10 000 pixels = 0.2 %
    expect(screenChanged(a, b)).toBe(false);
    b.data.fill(255, 0, 4 * 50); // 0.5 %
    expect(screenChanged(a, b)).toBe(true);
    expect(screenChanged(a, img(0, 50, 50))).toBeUndefined();
    const m = new ScreenMemory();
    m.remember(2, 'ffff0000ffff0000');
    m.remember(5, '0000ffff0000ffff');
    expect(m.sameAs('ffff0000ffff0001', 6)).toBe(2);
    expect(m.sameAs('0000ffff0000ffff', 5)).toBeUndefined();
  });
});

describe('W3-3 F6 final review', () => {
  it('failed without evidence is inconclusive; passes only with no failed item, nothing unmet, a backed answer', () => {
    const r = normalizeReport({ verdicts: [{ item: 'two recipes', status: 'failed', evidence: '' }, { item: 'saved', status: 'passed', evidence: 'list shows it' }, { item: 'x', status: 'weird', evidence: 'e' }], unmet_subgoals: [] })!;
    expect(r.verdicts.map((v) => v.status)).toEqual(['inconclusive', 'passed', 'inconclusive']);
    expect(passes(r)).toBe(true);
    expect(passes({ ...r, answer_ok: false })).toBe(false);
    const bad = normalizeReport({ verdicts: [{ item: 'Caprese added once', status: 'failed', evidence: 'the list shows two "Caprese"', suggestion: 'delete one' }], unmet: ['Add Caprese'] })!;
    expect(passes(bad)).toBe(false);
    expect(feedbackBlock(bad)).toBe("--- Final review (not passed) ---\n- [verify failed] 'Caprese added once': the list shows two \"Caprese\" Suggestion: delete one\n- [unmet] 'Add Caprese' is marked done but its result is not there.\nThese are independent judgments; address them, then report done again.");
    expect(failureKey(bad)).toBe(failureKey(normalizeReport({ unmet: ['Add Caprese'], verdicts: [{ item: 'Caprese added once', status: 'failed', evidence: 'other words' }] })!));
    expect(revertPlan('- [x] Add Caprese\n- [x] Open app\n- [ ] Save', bad)).toBe('- [/] Add Caprese\n- [x] Open app\n- [ ] Save');
    expect(normalizeReport('nope')).toBeUndefined();
  });

  it('the reviewer sees the goal, instructions, notes, ledger, read-backs and the final element list', () => {
    const p = checkerPrompt({ goal: 'Add a recipe', instructions: ['use 2 servings'], plan: '- [x] add', notes: '## r\nCaprese', ledger: ['#1 ...'], marks: ['step 1: typed "2" → 2'], answer: '42', elements: '[1] text "Caprese"' });
    for (const s of ['Goal: Add a recipe', '- use 2 servings', 'Caprese', '#1 ...', 'typed "2"', 'Answer the agent handed in: "42"', 'FINAL screen']) expect(p).toContain(s);
  });
});

describe('W3-3 F9 typing and read-back, F10 focus', () => {
  it('escapes for input text; lines split on real and literal \\n; key events only for printable ASCII', () => {
    expect(escapeAdbText(`a b'c"$&|;<>()*?~\\`)).toBe(`a%sb\\'c\\"\\$\\&\\|\\;\\<\\>\\(\\)\\*\\?\\~\\\\`);
    expect(textLines('one\\ntwo\nthree')).toEqual(['one', 'two', 'three']);
    expect(keyable('Hello, world!')).toBe(true);
    expect(keyable('你好')).toBe(false);
  });

  it('typeText: keys mode → input text per line with Enter between; direct mode and non-ASCII → yadb', async () => {
    const d = new AndroidDriver({ udid: 'x', packageName: 'p', inputMode: 'keys' });
    const sh: string[] = [];
    const yadb: string[] = [];
    Object.assign(d as unknown as Record<string, unknown>, { sh: async (c: string) => void sh.push(c), device: { execYadb: async (t: string) => void yadb.push(t) } });
    await d.typeText('Hi there\\n你好');
    expect(sh).toEqual(['input text Hi%sthere', 'input keyevent 66']);
    expect(yadb).toEqual(['你好']);
    sh.length = 0;
    yadb.length = 0;
    await d.typeText('Hi', 'direct');
    expect([sh, yadb]).toEqual([[], ['Hi']]);
    await d.key('ctrlhome');
    await d.key('moveend');
    expect(sh).toEqual(['input keycombination 113 122', 'input keyevent 123']);
    expect(new AndroidDriver({ udid: 'x', packageName: 'p' }).inputMode).toBe('direct');
  });

  it('read-back: replace must equal, end / start must contain; the field is the focused input', () => {
    expect(landed('Hello world', 'world', 'end')).toBe(true);
    expect(landed("a'a'ro'a'a'ron", 'aaron', 'end')).toBe(false);
    expect(landed('new', 'new', 'replace')).toBe(true);
    expect(landed('old new', 'new', 'replace')).toBe(false);
    expect(landed('l1\nl2', 'l1\\nl2', 'end')).toBe(true);
    const input = (o: Partial<ScreenNode>) => node({ cls: 'android.widget.EditText', ...o });
    const a = input({ text: 'A', box: [0, 0, 100, 40], center: { x: 50, y: 20 } });
    const b = input({ text: 'B', box: [0, 200, 100, 40], center: { x: 50, y: 220 }, focused: true });
    expect(fieldAfterTyping([a, b], a)?.text).toBe('B');
    expect(fieldAfterTyping([{ ...a }, { ...b, focused: false }], a)?.text).toBe('A');
    expect(readbackOf('ok; field now: "x\ny"')).toBe('x\ny');
    expect(readbackOf('input not committed; field now: ""')).toBe('input not committed');
    expect(readbackOf('ok; field not readable')).toBe('field not readable');
    expect(readbackOf('ok')).toBeUndefined();
    expect(describeAction({ type: 'type', target: 2, text: 'x'.repeat(80), at: 'start' }, [node({ text: 'a' }), node({ text: 'Body' })])).toBe(`type #2 "Body" "${'x'.repeat(80)}" (at start)`);
  });

  it('F10: focused survives the tree parse', () => {
    const xml = '<hierarchy><node class="android.widget.EditText" package="p" text="" focused="true" clickable="true" bounds="[0,0][100,50]" /></hierarchy>';
    expect(normalizeNodes(parseNodes(xml, 'p'))[0]).toMatchObject({ focused: true });
  });
});

describe('W3-3 F11′ Teamily acceptance suite', () => {
  it('the suite file parses; every placeholder is one the runner fills; ten tasks and one exploration', async () => {
    const yaml = (await import('js-yaml')).default;
    const s = yaml.load(readFileSync('fixtures/explore-suite/teamily.yaml', 'utf8')) as { tasks: { id: string; goal: string; pass: string }[]; explore: { id: string; goal: string }[] };
    expect(s.tasks).toHaveLength(10);
    expect(s.explore).toHaveLength(1);
    expect(new Set(s.tasks.map((t) => t.id)).size).toBe(10);
    const { fill } = await import('../../scripts/explore-suite');
    for (const t of [...s.tasks, ...s.explore]) expect(() => fill(`${t.goal} ${'pass' in t ? t.pass : ''}`, { group: 'G', member: 'M', run: 'r1' })).not.toThrow();
    expect(() => fill('{group}', { group: undefined })).toThrow(/no value/);
  });

  it('rows and the report: attribution from the result, reviews counted apart', async () => {
    const { rowOf, suiteMarkdown } = await import('../../scripts/explore-suite');
    const r = { status: 'completed', summary: 'ok', usage: { steps: 10, seconds: 100, modelCalls: 12, checkCalls: 2 }, checks: [{ step: 5, passed: false, failed: ['x'] }, { step: 9, passed: true, failed: [] }], unusable: 1, inputNotCommitted: 2, steps: [{ step: 1, changed: false }, { step: 2, changed: true }], findings: [], runDir: 'd' } as unknown as AgentResult;
    const row = rowOf({ id: 'send-once', goal: 'g' }, 'task', r, 't-1', '', '只发一次');
    expect(row).toMatchObject({ steps: 10, modelCalls: 12, checkCalls: 2, checksPassed: 1, checksFailed: 1, unusable: 1, inputNotCommitted: 2, unchanged: 1, attribution: '① ② ③' });
    const md = suiteMarkdown([row], { started: 's', run: 'r1' });
    expect(md).toContain('| send-once | task | completed：ok | 10 | 100s | 12（2） | 1/1 | 1 | 2 | 1 | 0 | ① ② ③ | 只发一次 |  |');
    expect(md).toContain('每步 10.0 秒、1.00 次调用');
  });
});

it('W3-3 F12: NOTICE lists the files ported from Artemis', () => {
  const notice = readFileSync('NOTICE', 'utf8');
  for (const f of ['engine/agent/coords.ts', 'engine/agent/notes.ts', 'engine/agent/history.ts', 'engine/agent/incident.ts', 'engine/agent/checker.ts', 'engine/agent/step.ts', 'drivers/android.ts', 'engine/agent/run.ts']) {
    expect(notice, f).toContain(f);
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, 'utf8'), f).toMatch(/ref\/artemis\/artemis\/\S+ L\d+/);
  }
});
