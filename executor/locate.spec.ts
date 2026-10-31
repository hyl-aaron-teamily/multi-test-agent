import { describe, expect, it, vi } from 'vitest';

const XML = `<hierarchy>
<node text="" content-desc="" class="android.view.ViewGroup" package="p" clickable="true" bounds="[0,1000][1080,1200]">
<node text="发送消息" content-desc="" class="android.widget.TextView" package="p" clickable="false" bounds="[100,1050][500,1150]" />
</node>
</hierarchy>`;

vi.mock('../core/tree-backend', async (orig) => ({ ...(await orig<typeof import('../core/tree-backend')>()), readTree: vi.fn(async () => ({ xml: XML, backend: 'uiautomator', t0: 0, t1: 1 })) }));
vi.mock('../core/model/midscene', () => ({ visionLocateRect: vi.fn(async () => undefined), visionAsk: vi.fn(async () => null) }));

const { locate, locateTally } = await import('./locate');
const { AndroidDriver } = await import('../drivers/android');

describe('executor/locate tiers', () => {
  const d = new AndroidDriver({ udid: 'x', packageName: 'p' });
  it('① exact text wins', async () => {
    const r = await locate(d, 'the 发送消息 row', { texts: ['发送消息'] });
    expect(r?.tier).toBe('①');
  });
  it('② fuzzy ranker catches wording drift and is tallied; ③ is not called', async () => {
    const r = await locate(d, 'the 发送 消息 row', { texts: ['发送-消息!'] });
    expect(r?.tier).toBe('②');
    expect(r?.point).toEqual({ x: 540, y: 1100 });
    expect(r?.how).toMatch(/fuzzy "发送消息"/);
    expect(locateTally['②']?.n).toBe(1);
  });
  it('miss when nothing is close and vision has no answer', async () => {
    expect(await locate(d, 'x', { texts: ['完全不同'] })).toBeUndefined();
    expect(locateTally.miss?.n).toBe(1);
  });
});
