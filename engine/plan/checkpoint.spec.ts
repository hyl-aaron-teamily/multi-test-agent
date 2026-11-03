import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodePng, type Rgba } from '../../core/image';
import { cacheDir, type Profile } from '../../skills/profile';
import { evaluateVisual, regionShows } from '../checks';
import { needsScreenshot } from './checkpoint';
import { adapterFor } from '../surfaces';

/** 100×100 image: white, with a black bar at rows 80–90 when `bar`. */
const img = (bar: boolean): Buffer => {
  const data = new Uint8Array(100 * 100 * 4).fill(255);
  if (bar) for (let y = 80; y < 90; y++) for (let x = 0; x < 100; x++) data.set([0, 0, 0, 255], (y * 100 + x) * 4);
  return encodePng({ width: 100, height: 100, data } as Rgba);
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skillcache-'));
  process.env.AUTOTEST_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.AUTOTEST_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const profile = (refs: Profile['refs'] = {}): Profile => ({ surface: 'android-app', name: 'android-app@prod@2.1.1@100x100', skillVersion: 's', env: 'prod', viewport: { width: 100, height: 100 }, elements: {}, refs });

describe('checkpoint (reference regions from the SKILL cache)', () => {
  it('a captured region matches its own screenshot and is absent on another', async () => {
    const p = profile({ home: { nav: { box: [0, 78, 100, 14], image: 'ref-home-nav.png' } } });
    mkdirSync(cacheDir(p.name), { recursive: true });
    writeFileSync(join(cacheDir(p.name), 'ref-home-nav.png'), img(true));
    const driver = { screenshot: async () => img(true) } as any;
    expect((await evaluateVisual(driver, p, { kind: 'visual-region', page: 'home', region: 'nav', expect: 'home', want: 'present' }, undefined, img(true))).pass).toBe(true);
    expect((await evaluateVisual(driver, p, { kind: 'visual-region', page: 'home', region: 'nav', expect: 'home', want: 'present', onlyOnAnomaly: false }, undefined, img(false))).pass).toBe(false);
  });

  it('no reference yet: captured now outside the loop (present); anchors not on screen = absent; the loop never captures', async () => {
    const calls: string[] = [];
    const p = profile();
    p.resolver = { inLoop: false, element: async () => false, refresh: async () => false, region: async (k) => (calls.push(k), k === 'chat/composer' && ((p.refs.chat = { composer: { box: [0, 0, 10, 10], image: 'x.png' } }), true)) };
    const d = { screenshot: async () => img(false) } as any;
    // anchors not found is not proof of absence: unverified without the vision model, the model's answer with it
    expect((await evaluateVisual(d, p, { kind: 'visual-region', page: 'profile', region: 'element:profile.bell', expect: 'bell', want: 'absent' })).pass).toBe(null);
    // expect describes the state (a bell is there); want absent: the model saying "not the case" passes
    expect((await evaluateVisual(d, p, { kind: 'visual-region', page: 'profile', region: 'element:profile.bell', expect: 'header still has its own bell', want: 'absent' }, async () => false)).pass).toBe(true);
    expect((await evaluateVisual(d, p, { kind: 'visual-region', page: 'profile', region: 'element:profile.bell', expect: 'header still has its own bell', want: 'absent' }, async () => true)).pass).toBe(false);
    expect(calls).toEqual(['profile/element:profile.bell', 'profile/element:profile.bell', 'profile/element:profile.bell']);
    p.resolver.inLoop = true;
    expect(regionShows({ width: 100, height: 100, data: new Uint8Array(40000) } as Rgba, p, 'mention-picker/picker')).toBe(false);
    expect((await evaluateVisual(d, p, { kind: 'visual-region', page: 'mention-picker', region: 'picker', expect: 'picker', want: 'present', onlyOnAnomaly: false })).pass).toBe(null);
    expect(calls).toHaveLength(3);
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
    const prof = { name: 'x', elements: { 'chat.back': { page: 'chat', box: [0, 0, 10, 10] } }, refs: {} } as any;
    await adapterFor('android-web').leaveConversation(d, prof);
    await adapterFor('android-app').leaveConversation(d, prof);
    expect(calls).toEqual(['tap {"x":5,"y":5}', 'back']);
  });
});
