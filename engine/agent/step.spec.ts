import { describe, expect, it } from 'vitest';
import type { ScreenNode } from '../../core/screen-index';
import { fingerprint, historyText, KEEP_STEPS, loopHint, parseAnswer, planState, type StepRecord, visibleElements } from './step';

const n = (text: string, clickable = true, desc = ''): ScreenNode => ({ text, desc, rid: '', cls: 'android.widget.Button', clickable, box: [0, 0, 10, 10], center: { x: 5, y: 5 } });

describe('quick tier step', () => {
  it('parses the actions, tap by index first; rejects unusable answers', () => {
    expect(parseAnswer({ thought: 't', action: { type: 'tap', target: 3 } })?.action).toEqual({ type: 'tap', target: 3, x: undefined, y: undefined, description: undefined });
    expect(parseAnswer({ action: { type: 'tap', x: 10, y: '20', description: 'icon' } })?.action).toMatchObject({ x: 10, y: 20 });
    expect(parseAnswer({ action: { type: 'tap' } })).toBeUndefined();
    expect(parseAnswer({ action: { type: 'report_issue', description: ' ' } })).toBeUndefined();
    expect(parseAnswer({ action: { type: 'wait', ms: 99999 } })?.action).toEqual({ type: 'wait', ms: 3000 });
    expect(parseAnswer({ action: { type: 'done', status: 'nope' } })?.action).toMatchObject({ status: 'completed' });
    expect(parseAnswer({ action: { type: 'fly' } })).toBeUndefined();
    expect(parseAnswer('x')).toBeUndefined();
  });

  it('history: the last 12 steps verbatim, older ones compressed per chunk of 12', () => {
    const steps: StepRecord[] = Array.from({ length: 30 }, (_, i) => ({ step: i + 1, screen: `s${i % 3}`, action: `tap #${i}`, result: i === 2 ? 'blocked: 发送' : 'ok' }));
    const h = historyText(steps).split('\n');
    expect(h.filter((l) => l.startsWith('(summary)'))).toHaveLength(2);
    expect(h.filter((l) => l.startsWith('#'))).toHaveLength(KEEP_STEPS);
    expect(h[0]).toMatch(/steps 1–12: 3 screen\(s\).*notable: #3 blocked/);
  });

  it('fingerprint ignores changing numbers; element list keeps labelled or clickable nodes', () => {
    expect(fingerprint([n('聊天 3'), n('我')])).toBe(fingerprint([n('我'), n('聊天 12')]));
    expect(fingerprint([n('聊天')])).not.toBe(fingerprint([n('发现')]));
    expect(visibleElements([n('', false), n('', true), n('标题', false)])).toHaveLength(2);
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
});
