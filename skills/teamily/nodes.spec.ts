// tapRewrite and the rewrite confirmation dialog (Teamily 2.0.20, 2026-10-30): a calibrated dialog seen after
// the tap = 「有确认」 → 取消 is tapped and the node returns (the draft stays; not a hit, W2-2 §5.2).
import { describe, expect, it } from 'vitest';
import { encodePng, type Rgba } from '../../core/image';
import type { Point } from '../../drivers/types';
import type { Profile } from '../profile';
import { type NodeContext, runNode } from './nodes';

const W = 10;
const frame = (g: number): Buffer => encodePng({ width: W, height: W, data: new Uint8Array(W * W * 4).fill(g) } as Rgba);
const profile = (withCancel: boolean): Profile =>
  ({
    name: 'android-test@prod',
    viewport: { width: W, height: W },
    refs: {},
    elements: {
      'chat.rewrite': { page: 'chat', box: [1, 8, 2, 2] },
      'chat.composer': { page: 'chat', box: [0, 6, 10, 2] },
      ...(withCancel ? { 'chat.rewriteCancel': { page: 'rewrite-confirm', box: [6, 4, 2, 2] } } : {}),
    },
  }) as unknown as Profile;

/** Fake phone: the dialog (a dark frame) shows after tapping rewrite and goes away after tapping 取消. */
function ctx(withCancel: boolean) {
  const taps: Point[] = [];
  let dialog = false;
  const driver = {
    surface: 'android-app',
    keyboardShown: async () => false,
    screenshot: async () => frame(dialog ? 0 : 255),
    tap: async (p: Point) => {
      taps.push(p);
      dialog = p.x === 2 && p.y === 9; // rewrite centre
    },
  };
  const c = { driver, profile: profile(withCancel), targets: {}, regionShows: (img: Rgba, key: string) => key === 'rewrite-confirm/dialog' && img.data[0] === 0 } as unknown as NodeContext;
  return { c, taps };
}

describe('teamily.tapRewrite confirmation dialog', () => {
  it('dialog seen → 取消 tapped, 有确认 reported', async () => {
    const { c, taps } = ctx(true);
    expect(await runNode('teamily.tapRewrite', { timeoutMs: 3000 }, c)).toMatch(/^有确认/);
    expect(taps).toEqual([
      { x: 2, y: 9 },
      { x: 7, y: 5 },
    ]);
  });
  it('no calibrated dialog (older app) → never tapped, no start = drift', async () => {
    const { c, taps } = ctx(false);
    await expect(runNode('teamily.tapRewrite', { timeoutMs: 1200 }, c)).rejects.toThrow(/did not start/);
    expect(taps).toHaveLength(1);
  });
});
