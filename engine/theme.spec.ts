// W2-5 §8.1: reference regions per light / dark theme — a check passes when any variant matches.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodePng, type Rgba } from '../core/image';
import { cacheDir, type Profile } from '../skills/profile';
import { regionShows, themeOf, withThemeVariant } from './checks';

const W = 200;
const H = 300;
/** A "nav bar": background `bg` with dark or light marks (text) on it. */
const screen = (bg: number, ink: number): Rgba => {
  const img: Rgba = { width: W, height: H, data: new Uint8Array(W * H * 4).fill(bg) };
  for (let y = 210; y < 230; y++) for (let x = 20; x < 180; x += 10) for (let k = 0; k < 5; k++) img.data.fill(ink, ((y * W) + x + k) * 4, ((y * W) + x + k) * 4 + 3);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  return img;
};
const light = screen(245, 20);
const dark = screen(20, 235);
const BOX: [number, number, number, number] = [0, 200, W, 40];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w2m5-theme-'));
  process.env.AUTOTEST_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.AUTOTEST_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const profile = (refs: Profile['refs']): Profile => ({ surface: 'android-app', name: 'android-app@prod@1@200x300', skillVersion: '-', env: 'prod', viewport: { width: W, height: H }, elements: {}, refs });

describe('theme variants of reference regions (W2-5 §8.1)', () => {
  it('tells light from dark by the region’s luminance', () => {
    expect(themeOf(light, BOX)).toBe('light');
    expect(themeOf(dark, BOX)).toBe('dark');
  });

  it('a capture after a theme switch keeps the old one as the other theme’s variant (one per theme)', () => {
    const renamed: [string, string][] = [];
    const next = withThemeVariant({ box: BOX, image: 'ref-home-nav.png' }, { box: BOX, image: 'ref-home-nav.prev.png' }, 'light', 'dark', (a, b) => void renamed.push([a, b]));
    expect(next).toEqual({ box: BOX, image: 'ref-home-nav.png', theme: 'dark', alts: [{ box: BOX, image: 'ref-home-nav.prev.light.png', theme: 'light' }] });
    expect(renamed).toEqual([['ref-home-nav.prev.png', 'ref-home-nav.prev.light.png']]);
    // switching back: the dark capture becomes the variant, the stale light variant is dropped
    const back = withThemeVariant({ box: BOX, image: 'ref-home-nav.png' }, { ...next, image: 'ref-home-nav.prev.png' }, 'dark', 'light', () => {});
    expect(back.alts).toEqual([{ box: BOX, image: 'ref-home-nav.prev.dark.png', theme: 'dark' }]);
    expect(back.theme).toBe('light');
  });

  it('a region check passes in either theme once both are captured; one theme alone fails in the other', () => {
    const p = profile({});
    mkdirSync(cacheDir(p.name), { recursive: true });
    writeFileSync(join(cacheDir(p.name), 'ref-home-nav.png'), encodePng(light));
    writeFileSync(join(cacheDir(p.name), 'ref-home-nav.dark.png'), encodePng(dark));
    p.refs = { home: { nav: { box: BOX, image: 'ref-home-nav.png', theme: 'light' } } };
    expect(regionShows(light, p, 'home/nav')).toBe(true);
    expect(regionShows(dark, p, 'home/nav')).toBe(false);
    p.refs.home.nav.alts = [{ box: BOX, image: 'ref-home-nav.dark.png', theme: 'dark' }];
    expect(regionShows(dark, p, 'home/nav')).toBe(true);
    expect(regionShows(light, p, 'home/nav')).toBe(true);
  });
});
