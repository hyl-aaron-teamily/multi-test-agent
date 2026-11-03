import { describe, expect, it } from 'vitest';
import { expectedEffect } from './warmup';

describe('warm-up gate', () => {
  it('derives the expected effect of a step from the Node table / element self-check / lifecycle', () => {
    expect(expectedEffect({ type: 'node', node: { name: 'teamily.openConversation', input: { target: 'g' } }, delayAfterMs: 0 })).toEqual({ kind: 'region', key: 'chat/composer' });
    expect(expectedEffect({ type: 'node', node: { name: 'teamily.typeMention', input: {} }, delayAfterMs: 0 })).toBeUndefined();
    expect(expectedEffect({ type: 'tap', element: 'chat.back', delayAfterMs: 0 })).toEqual({ kind: 'navigate' });
    expect(expectedEffect({ type: 'tap', element: 'chat.composer', delayAfterMs: 0 })).toEqual({ kind: 'focus' });
    expect(expectedEffect({ type: 'killApp', delayAfterMs: 0 })).toEqual({ kind: 'process-gone' });
    expect(expectedEffect({ type: 'tap', element: 'target.link', delayAfterMs: 0 })).toEqual({ kind: 'soft-change' });
  });
});
