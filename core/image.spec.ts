// Region matcher (ink comparison): a dark screen must not match a light reference region (2026-10-30: the
// launcher over a dark wallpaper passed the SKILL check after the app had been left).
import { describe, expect, it } from 'vitest';
import { type Rgba, regionDiffFraction } from './image';

const img = (w: number, h: number, px: (x: number, y: number) => number): Rgba => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const g = px(x, y);
      data.set([g, g, g, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
};

// Light background with a dark bar of "text" in the middle.
const ref = img(100, 40, (x, y) => (y >= 15 && y < 25 && x >= 20 && x < 80 ? 30 : 245));
const box: [number, number, number, number] = [0, 0, 100, 40];

describe('regionDiffFraction', () => {
  it('the same screen matches, a blank one does not', () => {
    expect(regionDiffFraction(ref, ref, box)).toBe(0);
    expect(regionDiffFraction(img(100, 40, () => 245), ref, box)).toBe(1);
  });
  it('a dark screen (ink everywhere) does not match a light reference', () => {
    expect(regionDiffFraction(img(100, 40, () => 20), ref, box)).toBe(1);
  });
  it('a little extra ink (a badge) still matches', () => {
    const badge = img(100, 40, (x, y) => (y >= 15 && y < 25 && x >= 20 && x < 80 ? 30 : x >= 90 && y < 10 ? 40 : 245));
    expect(regionDiffFraction(badge, ref, box)).toBe(0);
  });
});
