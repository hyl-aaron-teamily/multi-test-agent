// W3-7 P0 (E): a read that throws is recorded with its own message — not 「cannot be read」, which looked like a plan
// that asks for something unreadable (2730 `text cannot be read on android-app`).
import { describe, expect, it, vi } from 'vitest';

vi.mock('./checkpoint', () => ({
  observeCheck: vi.fn(async () => {
    throw new Error('uiautomator dump failed: ERROR: null root node returned by UiTestAutomationBridge.\nstack…');
  }),
}));

const { readBaseline, readExpect } = await import('./expect');

const ctx = (): any => ({ plan: { surface: 'android-app', baseline: [{ kind: 'text', expect: '设置页可见', match: { contains: '设置' }, scope: 'screen' }] }, res: {} });

describe('W3-7 P0: read exceptions keep their text', () => {
  it('baseline', async () => {
    const c = ctx();
    const r = await readBaseline(c, 0);
    expect(r).toMatchObject({ at: 'baseline[0]', pass: null });
    expect(r!.detail).toMatch(/read failed: uiautomator dump failed: ERROR: null root node/);
    expect(r!.detail).not.toMatch(/cannot be read|stack/);
    expect(c.res.expectLog).toHaveLength(1);
  });

  it('expect', async () => {
    const r = await readExpect(ctx(), { type: 'tap', element: 'chat.composer', delayAfterMs: 300, expect: { role: 'precondition', check: { kind: 'text', expect: 'x', match: { contains: 'x' }, want: 'present' } } } as any, 'actions[0]', 0);
    expect(r!.detail).toMatch(/^read failed: uiautomator dump failed/);
  });
});
