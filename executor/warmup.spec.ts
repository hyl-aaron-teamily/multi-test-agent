import { describe, expect, it } from 'vitest';
import { findByFingerprint } from './heal';
import { expectedEffect } from './warmup';

describe('warm-up gate', () => {
  it('derives the expected effect of a step from the Node table / element self-check / lifecycle', () => {
    expect(expectedEffect({ type: 'node', node: { name: 'teamily.openConversation', input: { target: 'g' } }, delayAfterMs: 0 })).toEqual({ kind: 'region', key: 'chat/composer' });
    expect(expectedEffect({ type: 'node', node: { name: 'teamily.typeMention', input: {} }, delayAfterMs: 0 })).toBeUndefined();
    expect(expectedEffect({ type: 'tap', element: 'chat.back', delayAfterMs: 0 })).toEqual({ kind: 'change' });
    expect(expectedEffect({ type: 'tap', element: 'chat.composer', delayAfterMs: 0 })).toEqual({ kind: 'focus' });
    expect(expectedEffect({ type: 'killApp', delayAfterMs: 0 })).toEqual({ kind: 'process-gone' });
  });
  it('finds a moved element by its fingerprint', () => {
    const nodes = [{ x1: 0, y1: 2000, x2: 200, y2: 2100, text: '', hint: '', desc: '聊天', cls: 'android.widget.Button', clickable: true }];
    expect(findByFingerprint(nodes, { desc: '聊天', cls: 'android.widget.Button' })?.y1).toBe(2000);
    expect(findByFingerprint(nodes, { desc: '我的' })).toBeUndefined();
  });
});
