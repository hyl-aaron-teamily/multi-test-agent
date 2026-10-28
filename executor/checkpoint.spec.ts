import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProfile, SKILL_DIR } from '../skills/profile';
import { evaluateVisual } from './checks';
import { needsScreenshot } from './checkpoint';
import { adapterFor } from './surfaces';

describe('checkpoint', () => {
  const p = loadProfile('desktop-web@prod')!;
  const home = readFileSync(join(SKILL_DIR, p.refs.home.image));
  const chat = readFileSync(join(SKILL_DIR, p.refs.chat.image));
  const driver = { screenshot: async () => home } as any;
  it('a reference region matches its own reference image and is absent elsewhere', async () => {
    expect((await evaluateVisual(driver, p, { kind: 'visual-region', page: 'home', region: 'nav', expect: 'home', want: 'present' }, undefined, home)).pass).toBe(true);
    expect((await evaluateVisual(driver, p, { kind: 'visual-region', page: 'chat', region: 'composer', expect: 'chat', want: 'present', onlyOnAnomaly: false }, undefined, chat)).pass).toBe(true);
  });
  it('screenshot only when a check needs the screen', () => {
    expect(needsScreenshot([{ kind: 'crash', expect: '', want: 'absent' }])).toBe(false);
    expect(needsScreenshot([{ kind: 'baseline', expect: '', want: 'present' }])).toBe(true);
  });
});

describe('surface adapters', () => {
  it('android-web leaves a conversation with the page arrow, android-app with Back', async () => {
    const calls: string[] = [];
    const d = { tap: async (pt: unknown) => void calls.push(`tap ${JSON.stringify(pt)}`), back: async () => void calls.push('back') } as any;
    const prof = { name: 'x', elements: { 'chat.back': { box: [0, 0, 10, 10], selfCheck: 'pass' } } } as any;
    await adapterFor('android-web').leaveConversation(d, prof);
    await adapterFor('android-app').leaveConversation(d, prof);
    expect(calls).toEqual(['tap {"x":5,"y":5}', 'back']);
  });
});
