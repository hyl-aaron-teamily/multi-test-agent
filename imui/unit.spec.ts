// Pure checks for imui (ported metrics + token helpers). No device, browser or model.
import { describe, expect, it } from 'vitest';
import { percentile, UiMetrics } from './metrics';
import { bubbleClusters, extractTokens, makeToken } from './tokens';

describe('imui metrics (port of imload/metrics.py)', () => {
  it('percentile uses linear interpolation like imload', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([5], 0.99)).toBe(5);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });

  it('separates echo from delivery, counts per observer, ignores repeats', () => {
    const m = new UiMetrics();
    m.registerSend('t1', 1, 'A', 'text', 1000, ['B', 'C']);
    m.seen('A', 't1', 1200); // echo
    m.seen('B', 't1', 1500);
    m.seen('B', 't1', 1900); // repeat on same client: ignored
    m.registerSend('t2', 2, 'A', 'text', 2000, ['B', 'C']);
    m.seen('A', 't2', 2100);
    m.seen('C', 't1', 3000);
    m.seen('X', 'stale-token', 3000);
    const r = m.report();
    expect(r.ui_echo_ms).toMatchObject({ count: 2, min: 100, max: 200 });
    expect(r.ui_e2e_ms).toMatchObject({ count: 2, min: 500, max: 2000 });
    expect(r.delivery).toEqual({ expected: 4, delivered: 2, lost: 2, lossRatio: 0.5 });
    expect(r.unexpected).toBe(1);
    expect(m.lostTokens()).toEqual([{ token: 't2', missingOn: ['B', 'C'] }]);
  });

  it('flags out-of-order display, duplicates and SLO breaches', () => {
    const m = new UiMetrics();
    m.registerSend('a', 1, 'A', 'text', 0, ['B']);
    m.registerSend('b', 2, 'A', 'text', 10, ['B']);
    m.seen('A', 'a', 50);
    m.seen('A', 'b', 60);
    m.seen('B', 'b', 100);
    m.seen('B', 'a', 120);
    m.countDuplicates(1);
    expect(m.outOfOrder()).toBe(1);
    const f = m.checkSlo({ e2eP99Ms: 50, maxLossRatio: 0 });
    expect(f.join('\n')).toMatch(/ui_e2e p99/);
    expect(f.join('\n')).toMatch(/duplicate/);
    expect(f.join('\n')).toMatch(/out-of-order/);
  });

  it('discarded sends are neither sent nor lost', () => {
    const m = new UiMetrics();
    m.registerSend('x', 1, 'A', 'text', 0, ['B']);
    m.discard('x', 'input failed');
    expect(m.report().messagesSent).toBe(0);
    expect(m.delivery().expected).toBe(0);
    expect(m.checkSlo({})).toEqual(['send errors: {"input failed":1}']);
  });
});

describe('imui tokens', () => {
  it('makes typeable, extractable tokens', () => {
    const t = makeToken('r7k2', 12);
    expect(t).toMatch(/^imui-r7k2-12$/);
    expect(extractTokens(`hi ${t} and imui-r7k2-3x imui-zz-4 `, 'r7k2')).toEqual(['imui-r7k2-12']);
  });

  it('collapses nested accessibility nodes of one bubble', () => {
    // Same bubble reported by a container and its TextView (nested bounds) + a second real bubble.
    const nodes = [
      { x1: 100, y1: 500, x2: 900, y2: 600 },
      { x1: 120, y1: 510, x2: 880, y2: 590 },
      { x1: 100, y1: 800, x2: 900, y2: 900 },
    ];
    expect(bubbleClusters(nodes)).toBe(2);
  });
});
