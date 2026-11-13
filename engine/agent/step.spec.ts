import { describe, expect, it } from 'vitest';
import type { ScreenNode } from '../../core/screen-index';
import { toNorm, toPx } from './coords';
import { elementList, fingerprint, loopHint, occlusions, parseAnswer, planState, readAction, readAnswer, readTarget, type StepRecord, visibleElements } from './step';

const n = (text: string, clickable = true, desc = '', box: [number, number, number, number] = [0, 0, 10, 10]): ScreenNode => ({ text, desc, rid: '', cls: 'android.widget.Button', clickable, box, center: { x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 } });
const SIZE = { width: 1000, height: 2000 };

describe('exploration tier step', () => {
  it('parses the actions, tap by index first; rejects unusable answers', () => {
    expect(parseAnswer({ thought: 't', action: { type: 'tap', target: 3 } })?.action).toEqual({ type: 'tap', target: 3 });
    expect(parseAnswer({ action: { type: 'tap', x: 10, y: '20', description: 'icon' } })?.action).toMatchObject({ x: 10, y: 20, description: 'icon' });
    expect(parseAnswer({ action: { type: 'tap' } })).toBeUndefined();
    expect(parseAnswer({ action: { type: 'report_issue', description: ' ' } })).toBeUndefined();
    expect(parseAnswer({ action: { type: 'wait', ms: 99999 } })?.action).toEqual({ type: 'wait', ms: 3000 });
    expect(parseAnswer({ action: { type: 'done', status: 'nope' } })?.action).toMatchObject({ status: 'completed' });
    expect(parseAnswer({ action: { type: 'fly' } })).toBeUndefined();
    expect(parseAnswer('x')).toBeUndefined();
  });

  it('W3-3 F4: every unusable answer says why (the reason goes back to the model)', () => {
    const err = (raw: unknown, els?: number) => {
      const r = readAnswer(raw, false, els);
      return 'error' in r ? r.error : undefined;
    };
    expect(err({ action: { type: 'tap', target: 93 } }, 41)).toBe('Invalid target index 93. Active index range is 1 to 41. Use an index shown in the Visible elements list, or normalized [x, y] coordinates with a description.');
    expect(err({ action: { type: 'fly' } })).toMatch(/^Unknown action type 'fly'\. Allowed: tap, longPress, type/);
    expect(err({ action: { type: 'tap', x: 500, y: 280 } })).toBe("Coordinate target requires 'description' (what the element is, in a few words).");
    expect(err({ action: { type: 'tap', x: 1500, y: 280, description: 'x' } })).toMatch(/outside the 0-1000 scale/);
    expect(err({ thought: 'no action' })).toBe("The answer has no 'action' object.");
    expect(err('text')).toBe('The answer is not one JSON object.');
    expect(err({ action: { type: 'type', target: 2, text: 'a', at: 'middle' } })).toMatch(/'at' must be end, start or replace/);
    expect(err({ action: { type: 'note', key: 'k', content: 'c', mode: 'update' } })).toMatch(/needs 'target'/);
  });

  it('W3-3 F4: lenient targets and action names from other vocabularies', () => {
    expect(readTarget(3)).toEqual({ index: 3 });
    expect(readTarget('3')).toEqual({ index: 3 });
    expect(readTarget([500, 280])).toEqual({ point: { x: 500, y: 280 } });
    expect(readTarget('[500, 280]')).toEqual({ point: { x: 500, y: 280 } });
    expect(readTarget('500, 280')).toEqual({ point: { x: 500, y: 280 } });
    expect(readTarget('the button')).toBeUndefined();
    const act = (raw: Record<string, unknown>, bench = false) => {
      const r = readAction(raw, bench);
      return 'action' in r ? r.action : r.error;
    };
    expect(act({ type: 'click', target: '[500, 280]', target_description: 'play' })).toEqual({ type: 'tap', x: 500, y: 280, description: 'play' });
    expect(act({ type: 'input_text', target: '2', text: 'hi' })).toEqual({ type: 'type', target: 2, text: 'hi' });
    expect(act({ type: 'scroll', direction: 'down' })).toEqual({ type: 'swipe', direction: 'down' });
    expect(act({ type: 'navigate_back' })).toEqual({ type: 'back' });
    expect(act({ type: 'long_press', target: 4 })).toEqual({ type: 'longPress', target: 4 });
    expect(act({ type: 'status', status: 'complete', summary: 's' })).toEqual({ type: 'done', status: 'completed', summary: 's' });
    expect(act({ type: 'type', target: 1, text: 'x', clear: true })).toEqual({ type: 'type', target: 1, text: 'x', at: 'replace' });
    expect(act({ type: 'type', target: 1, text: 'x', at: 'start' })).toEqual({ type: 'type', target: 1, text: 'x', at: 'start' });
    expect(act({ type: 'note', key: 'prices', content: '3.99', mode: 'append' })).toEqual({ type: 'note', key: 'prices', content: '3.99', mode: 'append' });
    expect(act({ type: 'search_history', query: 'caprese', from: 3 })).toEqual({ type: 'search_history', query: 'caprese', from: 3 });
  });

  it('fingerprint ignores changing numbers; element list keeps labelled or clickable nodes', () => {
    expect(fingerprint([n('聊天 3'), n('我')])).toBe(fingerprint([n('我'), n('聊天 12')]));
    expect(fingerprint([n('聊天')])).not.toBe(fingerprint([n('发现')]));
    expect(visibleElements([n('', false), n('', true), n('标题', false)])).toHaveLength(2);
  });

  it('W3-3 F4: no element cap; the same text within 8 px is listed once', () => {
    const many = Array.from({ length: 150 }, (_, i) => n(`row ${i}`, true, '', [0, i * 20, 100, 18]));
    expect(visibleElements(many)).toHaveLength(150);
    expect(visibleElements([n('OK', true, '', [0, 0, 100, 40]), n('OK', true, '', [3, 2, 100, 40]), n('OK', true, '', [0, 100, 100, 40])])).toHaveLength(2);
  });

  it('W3-3 F4: full texts JSON-quoted, 0–1000 bounds, focus, overlap warnings', () => {
    const long = 'x'.repeat(200);
    const list = elementList([{ ...n('', true, '', [0, 0, 500, 200]), cls: 'android.widget.EditText', hint: 'Phone', focused: true }, n(`${long}\n"quoted"`, false, '', [0, 400, 1000, 200]), { ...n('', true, '', [0, 800, 100, 100]), rid: 'com.android.contacts:id/menu_save' }], SIZE);
    expect(list).toContain('[1] input "" hint "Phone" focused | Bounds: [0,0][500,100]');
    expect(list).toContain(`[2] Button ${JSON.stringify(`${long}\n"quoted"`)} | Bounds: [0,200][1000,300]`);
    expect(list).toContain('\\n\\"quoted\\"');
    expect(list).toContain('[3] button "" id "menu_save" | Bounds: [0,400][100,450]');
    // A floating button over the right end of a list row overlaps it; a parent around its child does not.
    const row = n('Alice', true, '', [0, 0, 1000, 100]);
    const fab = n('+', true, '', [800, 0, 200, 100]);
    const child = n('Alice', false, '', [400, 25, 200, 50]);
    expect([...occlusions([row, fab]).keys()]).toEqual([1, 2]);
    expect(occlusions([row, child]).size).toBe(0);
    expect(elementList([row, fab], SIZE)).toContain('[1] button "Alice" | Bounds: [0,0][1000,50] (WARNING: may overlap with [2], possible occlusion)');
  });

  it('W3-3 F3: 0–1000 coordinates convert both ways and stay on the screen', () => {
    expect(toPx({ x: 500, y: 280 }, 1080, 2400)).toEqual({ x: 540, y: 672 });
    expect(toPx({ x: 1000, y: 1000 }, 1080, 2400)).toEqual({ x: 1079, y: 2399 });
    expect(toNorm({ x: 540, y: 672 }, 1080, 2400)).toEqual({ x: 500, y: 280 });
    expect(toNorm({ x: 5000, y: -3 }, 1080, 2400)).toEqual({ x: 1000, y: 0 });
  });

  it('plan checklist state', () => {
    expect(planState('- [x] open chat\n- [/] scroll\n- [ ] back\n- [!] search')).toEqual({ todo: 2, done: 1, failed: 1 });
  });
  it('loop hint: one pair three times, or two pairs alternating', () => {
    const st = (screen: string, action: string, step = 0): StepRecord => ({ step, screen, action, result: 'ok' });
    expect(loopHint([st('a', 'tap #9 ""'), st('b', 'tap #9 "Close"'), st('a', 'tap #9 ""'), st('b', 'tap #9 "Close"')])).toMatch(/^LOOP: the last 4 steps repeated tap #9 "" \/ tap #9 "Close"/);
    expect(loopHint([st('a', 'swipe up'), st('a', 'swipe up'), st('a', 'swipe up')])).toMatch(/last 3 steps/);
    expect(loopHint([st('a', 'tap #1'), st('b', 'tap #2'), st('c', 'tap #3'), st('b', 'tap #2')])).toBeUndefined();
    expect(loopHint([st('a', 'swipe up'), st('b', 'swipe up'), st('c', 'swipe up')])).toBeUndefined();
  });

  it('bursts, replace and drag; a note rides along; a bad burst action is dropped with its reason', () => {
    const r = readAnswer({ thought: '', action: { type: 'type', target: 3, text: 'Ann', clear: true }, then: [{ type: 'type', target: 4, text: '123' }, { type: 'enter' }, { type: 'done', status: 'completed', summary: '' }, { type: 'tap', target: 1 }] }, true);
    if (!('answer' in r)) throw new Error(r.error);
    expect(r.answer.action).toEqual({ type: 'type', target: 3, text: 'Ann', at: 'replace' });
    // the burst stops before an action that must end a turn on its own
    expect(r.answer.then).toEqual([{ type: 'type', target: 4, text: '123' }, { type: 'enter' }]);
    expect(r.dropped).toMatch(/stopped at 'done'/);
    expect(parseAnswer({ thought: '', action: { type: 'done', status: 'completed', summary: '' }, then: [{ type: 'tap', target: 1 }] })!.then).toBeUndefined();
    expect(parseAnswer({ thought: '', action: { type: 'tap', target: 1 }, then: Array.from({ length: 9 }, () => ({ type: 'back' })) })!.then).toHaveLength(3);
    expect(parseAnswer({ thought: '', action: { type: 'tap', target: 1 }, then: [{ type: 'note', key: 'k', content: 'v', mode: 'save' }] })!.then).toEqual([{ type: 'note', key: 'k', content: 'v', mode: 'save' }]);
    expect(parseAnswer({ thought: '', action: { type: 'drag', x1: 1, y1: 2, x2: 3, y2: 4 } })!.action).toEqual({ type: 'drag', x1: 1, y1: 2, x2: 3, y2: 4 });
    expect(parseAnswer({ thought: '', action: { type: 'drag', x1: 1 } })).toBeUndefined();
  });

  it('loop hint: a cycle of 3–4 actions run twice is a loop too (2026-11-03 rewrite task)', () => {
    const st = (screen: string, action: string): StepRecord => ({ step: 0, screen, action, result: 'ok' });
    const cyc = ['type #52 "x" (clear)', 'tap #44 "用记忆强化 prompt"', 'tap #69 "强化"'];
    const steps = [...cyc, ...cyc].map((a, i) => st(`s${i}`, a));
    expect(loopHint(steps)).toMatch(/last 6 steps repeated/);
    expect(loopHint([...cyc, 'back', ...cyc].map((a, i) => st(`s${i}`, a)))).toBeUndefined();
  });
});
