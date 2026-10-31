import { describe, expect, it, vi } from 'vitest';
import { normalizeNodes, type ScreenNode } from '../core/screen-index';
import { parseNodes } from '../core/ui-tree';

const ROW = (y: number, title = '自动化测试群') => `<node text="" content-desc="" class="android.view.ViewGroup" package="p" clickable="true" bounds="[0,${y}][1080,${y + 200}]">
<node text="${title}" content-desc="" class="android.widget.TextView" package="p" clickable="false" bounds="[200,${y + 20}][900,${y + 80}]" /></node>`;
const nodesOf = (...xs: string[]) => normalizeNodes(parseNodes(`<hierarchy>${xs.join('')}</hierarchy>`, 'p'));

let current: ScreenNode[] = [];
vi.mock('./snapshot', () => ({ snapshot: vi.fn(async () => ({ nodes: current, width: 1080, height: 2400, ms: {}, source: 'uiautomator' })) }));

const { PreTapBlocked, PreTapGuard, pixelChange, treeVerdict } = await import('./pretap');
const { RecordingDriver } = await import('../incident/recording-driver');

const ref = { purpose: 'target g1', text: '自动化测试群', box: [0, 400, 1080, 200] as [number, number, number, number] };
const P = { x: 540, y: 500 };

describe('executor/pretap treeVerdict', () => {
  it('pass when the target is still at the point', () => {
    expect(treeVerdict(ref, P, nodesOf(ROW(400)))?.kind).toBe('pass');
  });
  it('small drift is corrected to the new centre', () => {
    const r = treeVerdict(ref, P, nodesOf(ROW(460)));
    expect(r?.kind).toBe('corrected');
    expect(r?.point).toEqual({ x: 540, y: 560 });
  });
  it('a 200 px move is classified shifted (not tapped)', () => {
    const r = treeVerdict(ref, P, nodesOf(ROW(600)));
    expect(r?.kind).toBe('shifted');
    expect(r?.detail).toMatch(/moved 200 px/);
  });
  it('a dialog over the point → covered', () => {
    const dialog = `<node text="确定删除？" content-desc="" class="android.widget.Button" package="p" clickable="true" bounds="[300,450][800,560]" />`;
    expect(treeVerdict(ref, P, nodesOf(ROW(400), dialog))?.kind).toBe('covered');
  });
  it('target text not on screen → gone; no fingerprint → undefined (pixel path)', () => {
    expect(treeVerdict(ref, P, nodesOf(ROW(400, '别的会话')))?.kind).toBe('gone');
    expect(treeVerdict({ purpose: 'icon' }, P, nodesOf(ROW(400)))).toBeUndefined();
  });
  it('resource-id weighs in when present', () => {
    const n = nodesOf(`<node text="" content-desc="" resource-id="app:id/send" class="android.widget.ImageView" package="p" clickable="true" bounds="[900,2100][1060,2200]" />`);
    expect(treeVerdict({ purpose: 'send', rid: 'app:id/send' }, { x: 980, y: 2150 }, n)?.kind).toBe('pass');
  });
  it('pixelChange: identical frames 0, fully changed area 1', () => {
    const img = (v: number) => ({ width: 200, height: 200, data: Buffer.alloc(200 * 200 * 4, v) });
    expect(pixelChange(img(0), img(0), { x: 100, y: 100 })).toBe(0);
    expect(pixelChange(img(0), img(255), { x: 100, y: 100 })).toBe(1);
  });
});

describe('executor/pretap guard', () => {
  const taps: { x: number; y: number }[] = [];
  const inner = { surface: 'android-app', tap: async (p: { x: number; y: number }) => void taps.push(p), longPress: async () => {}, screenshot: async () => Buffer.alloc(0) } as any;
  const d = new RecordingDriver(inner);
  const g = new PreTapGuard(inner).attach(d);

  it('off (the loop): no check, taps go through', async () => {
    await g.remember(P, ref);
    current = nodesOf(ROW(600));
    await d.tap(P);
    expect(g.tally.checked).toBe(0);
    expect(taps.at(-1)).toEqual(P);
  });
  it('on: unknown points are not checked; a corrected point is tapped; a shifted target is blocked', async () => {
    await g.during('prepare', async () => {
      await d.tap({ x: 1, y: 1 });
      expect(g.tally.checked).toBe(0);
      current = nodesOf(ROW(460));
      await d.tap(P);
      expect(taps.at(-1)).toEqual({ x: 540, y: 560 });
      current = nodesOf(ROW(800));
      await expect(d.tap({ x: 540, y: 560 })).rejects.toBeInstanceOf(PreTapBlocked);
    });
    expect(g.tally).toMatchObject({ checked: 2, corrected: 1, blocked: 1, byPhase: { prepare: 2 } });
    expect(g.enabled).toBe(false);
    expect(g.reportLines()[0]).toMatch(/校验 2 次：通过 0，修正 1，拦截 1/);
  });
  it('once refs (first tap after a heal) are checked a single time', async () => {
    await g.remember({ x: 10, y: 10 }, { purpose: 'healed x', text: '自动化测试群', once: true });
    current = nodesOf(ROW(400));
    const before = g.tally.checked;
    await g.during('enter', async () => {
      await d.tap({ x: 10, y: 10 }).catch(() => {});
      await d.tap({ x: 10, y: 10 }).catch(() => {});
    });
    expect(g.tally.checked - before).toBe(1);
  });
});

describe('review fixes', () => {
  it('a row with the same resource-id but other text is not the target', () => {
    const row = (y: number, t: string) => `<node text="" content-desc="" resource-id="app:id/row" class="android.view.ViewGroup" package="p" clickable="true" bounds="[0,${y}][1080,${y + 200}]"><node text="${t}" class="android.widget.TextView" package="p" clickable="false" bounds="[200,${y + 20}][900,${y + 80}]" /></node>`;
    const r = treeVerdict({ purpose: 'g', text: '自动化测试群', rid: 'app:id/row', box: [0, 400, 1080, 200] }, P, nodesOf(row(400, '别的会话')));
    expect(r?.kind).toBe('gone');
  });
  it('a failing check is uncertain (tapped, recorded), not a crash', async () => {
    const inner = { surface: 'android-app', tap: async () => {}, longPress: async () => {}, screenshot: async () => Buffer.alloc(0) } as any;
    const d = new RecordingDriver(inner);
    const g = new PreTapGuard(inner).attach(d);
    g.check = async () => {
      throw new Error('adb: device offline');
    };
    await g.remember(P, ref);
    await g.during('prepare', () => d.tap(P));
    expect(g.events.at(-1)).toMatchObject({ kind: 'uncertain', detail: expect.stringMatching(/device offline/) });
  });
});
