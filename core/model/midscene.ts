// Midscene vision agent, one per device / page (cached): tier ③ of observation (`ask`) and locate
// (`locateRect`). Every call is counted; failures return null and never throw.
import { countCall } from './llm';

export interface VisionTarget {
  surface: string;
  /** Android: the driver options (udid). */
  o?: { udid?: string };
  /** Web: the Playwright page. */
  page?: unknown;
}

export interface VisionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const visionEnabled = () => process.env.ISSUE_NO_VISION !== '1' && !!process.env.MIDSCENE_MODEL_API_KEY;

const agents = new Map<unknown, Promise<any>>();

function agentFor(t: VisionTarget): Promise<any> {
  const key = t.page ?? t.o?.udid ?? t;
  let a = agents.get(key);
  if (!a) {
    a = (async () => {
      if (t.surface === 'android-app' || t.surface === 'android-web') {
        const { AndroidAgent, AndroidDevice } = await import('@midscene/android');
        const dev = new AndroidDevice(t.o!.udid!);
        await dev.connect();
        return new AndroidAgent(dev, { generateReport: false } as any);
      }
      const { PlaywrightAgent } = await import('@midscene/web/playwright');
      return new PlaywrightAgent(t.page as any, { generateReport: false } as any);
    })();
    a.catch(() => agents.delete(key));
    agents.set(key, a);
  }
  return a;
}

/** Yes/no question about the current screen; null when vision is unavailable or failed. */
export async function visionAsk(t: VisionTarget, q: string, purpose?: string): Promise<boolean | null> {
  if (!visionEnabled()) return null;
  try {
    const agent = await agentFor(t);
    countCall('vision', purpose);
    return Boolean(await agent.aiBoolean(q));
  } catch (err) {
    console.warn(`[vision] ${(err as Error).message.split('\n')[0]}`);
    return null;
  }
}

/** Locate one element on the current screen; null when unavailable or not found. */
export async function visionLocateRect(t: VisionTarget, q: string, purpose?: string): Promise<VisionRect | null> {
  if (!visionEnabled()) return null;
  try {
    const agent = await agentFor(t);
    countCall('vision', purpose);
    const r = await agent.aiLocate(q);
    const rect = r?.rect;
    if (rect) return { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
    if (r?.center) return { x: r.center[0], y: r.center[1], w: 0, h: 0 };
    return null;
  } catch (err) {
    console.warn(`[vision] locate failed: ${(err as Error).message.split('\n')[0]}`);
    return null;
  }
}

/** Drop the cached agent of a page / device (after the page closed). */
export function forgetVision(t: VisionTarget): void {
  agents.delete(t.page ?? t.o?.udid ?? t);
}
