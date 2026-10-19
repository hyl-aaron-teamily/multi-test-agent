// Pure-function checks for the explorer (no device / model needed).
import { describe, expect, it } from 'vitest';
import { DEFAULT_AVOID, isUnsafe, scoreElement } from './explore-loop';
import { normaliseElements } from './page-observer';
import { isStableTitle, screenshotFingerprint } from './state-tracker';

describe('explore pure helpers', () => {
  it('normalises and de-duplicates aiQuery output', () => {
    const els = normaliseElements([
      { type: 'button', label: 'Me', description: 'open profile' },
      { type: 'button', label: 'me', description: 'dup' },
      { type: 'weird', label: 'X' },
      { label: '' },
      null,
    ]);
    expect(els).toEqual([
      { type: 'button', label: 'Me', description: 'open profile' },
      { type: 'unknown', label: 'X', description: '' },
    ]);
    expect(normaliseElements('nope')).toEqual([]);
  });

  it('blocks payment / send / destructive / input elements', () => {
    expect(isUnsafe({ type: 'button', label: '发送', description: '' }, DEFAULT_AVOID, false)).toBe(true);
    expect(isUnsafe({ type: 'button', label: 'Top up', description: 'recharge balance' }, DEFAULT_AVOID, false)).toBe(true);
    expect(isUnsafe({ type: 'button', label: 'Log out', description: '' }, DEFAULT_AVOID, false)).toBe(true);
    expect(isUnsafe({ type: 'input', label: 'Message', description: '' }, DEFAULT_AVOID, false)).toBe(true);
    expect(isUnsafe({ type: 'switch', label: '免打扰', description: '' }, /$^/, false)).toBe(true);
    expect(isUnsafe({ type: 'button', label: '添加成员', description: '' }, DEFAULT_AVOID, true)).toBe(true);
    for (const label of ['套餐与账单', '创作赚钱', '更改语言', 'Monthly review template']) {
      expect(isUnsafe({ type: 'list-item', label, description: label.includes('template') ? 'prompt template' : '' }, DEFAULT_AVOID, false)).toBe(true);
    }
    expect(isUnsafe({ type: 'tab', label: '收藏', description: '查看收藏' }, DEFAULT_AVOID, false)).toBe(false);
    expect(isUnsafe({ type: 'tab', label: 'Agents', description: 'open agent list' }, DEFAULT_AVOID, false)).toBe(false);
  });

  it('prefers focus terms, then navigation hints', () => {
    const focus = ['profile', 'agent'];
    const a = scoreElement({ type: 'tab', label: 'Agent', description: '' }, focus);
    const b = scoreElement({ type: 'button', label: 'Help', description: 'view help page' }, focus);
    const c = scoreElement({ type: 'button', label: 'Like', description: '' }, focus);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it('fingerprints', () => {
    expect(isStableTitle('Profile')).toBe(true);
    expect(isStableTitle('')).toBe(false);
    expect(isStableTitle('unknown')).toBe(false);
    const fp = screenshotFingerprint(Buffer.from('png'), [
      { type: 'button', label: 'a', description: '' },
      { type: 'tab', label: 'b', description: '' },
    ]);
    expect(fp).toMatch(/^s-[0-9a-f]{12}-button1tab1$/);
  });
});
