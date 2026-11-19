// W3-7 §4 / §8.1 ⑪: block health per device, the "now fixed" trigger, the block an executor failure names.
import { describe, expect, it } from 'vitest';
import { type BlockHealth, blockOf, foldFails, healthy, type HealthFile, nowFixed } from '../scripts/block-check';

const h = (block: string, ok: number, runs = 20): BlockHealth => ({ block, version: 'v', runs, ok, fails: [], at: '' });

describe('W3-7 block health', () => {
  it('pass mark 19/20; fixed = failed before, passes now, same device only', () => {
    expect(healthy(h('a', 19))).toBe(true);
    expect(healthy(h('a', 18))).toBe(false);
    const before: HealthFile = { schemaVersion: 1, devices: { phone: { 'teamily.openSettings': h('teamily.openSettings', 12) }, emu: { 'teamily.openSettings': h('teamily.openSettings', 3) } } };
    const after: HealthFile = { schemaVersion: 1, devices: { phone: { 'teamily.openSettings': h('teamily.openSettings', 20) }, emu: { 'teamily.openSettings': h('teamily.openSettings', 3) } } };
    expect(nowFixed(before, after, 'phone')).toEqual(['teamily.openSettings']);
    expect(nowFixed(before, after, 'emu')).toEqual([]);
  });

  it('failure texts folded and counted; the block an executor failure names', () => {
    expect(foldFails([{ text: 'menu did not open after 1200 ms' }, { text: 'menu did not open after 900 ms' }, { text: 'other' }])[0]).toEqual({ text: 'menu did not open after # ms', n: 2, kind: undefined });
    expect(blockOf('teamily.openSettings: the ☰ settings entry not on screen')).toBe('teamily.openSettings');
    expect(blockOf('the composer did not take focus (keyboard not up)')).toBe('focusComposer');
    expect(blockOf('boom')).toBeUndefined();
  });
});
