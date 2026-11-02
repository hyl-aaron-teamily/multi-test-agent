// Screen snapshot capture (W2-4 §4.2): wait until the screen is stable (two frames nearly equal; skipped
// when the caller knows nothing changed) → screenshot and hierarchy read in parallel → normalised nodes
// (core/screen-index.ts). Android nodes come from the device's tree backend; web nodes from Playwright
// read-only role locators (nothing evaluated in the page). Outside the action loop only.
import { decodePng, pixelDiff } from '../core/image';
import { normalizeNodes, type ScreenNode, type ScreenSnapshot } from '../core/screen-index';
import { parseNodes, readUiXml } from '../core/ui-tree';
import { AndroidDriver } from '../drivers/android';
import { sleep, type Driver } from '../drivers/types';
import { WebDriver } from '../drivers/web';

export interface SnapshotOptions {
  /** Skip the stability wait (the previous action did not change the screen). */
  skipStable?: boolean;
  /** Keep the screenshot bytes on the snapshot (pre-tap check pixel fallback, doctor --probe). */
  keepPng?: boolean;
  /** Max time spent waiting for a stable screen (ms). */
  stableMaxMs?: number;
  /** Package filter for Android nodes ('' = every window). */
  pkg?: string;
}

/** Pure: two frames count as the same screen when < 0.3% of pixels changed. */
export const STABLE_FRACTION = 0.003;

async function waitStable(d: Driver, maxMs: number): Promise<{ ms: number; last?: Buffer }> {
  const t0 = Date.now();
  let prev = await d.screenshot().catch(() => undefined);
  while (prev && Date.now() - t0 < maxMs) {
    await sleep(300);
    const cur = await d.screenshot().catch(() => undefined);
    if (!cur) break;
    try {
      const a = decodePng(prev);
      const b = decodePng(cur);
      if (a.width === b.width && a.height === b.height && pixelDiff(a, b) / (a.width * a.height) < STABLE_FRACTION) return { ms: Date.now() - t0, last: cur };
    } catch {
      return { ms: Date.now() - t0 };
    }
    prev = cur;
  }
  return { ms: Date.now() - t0 };
}

const WEB_ROLES = ['button', 'link', 'textbox', 'menuitem', 'tab', 'checkbox', 'option', 'listitem'] as const;

async function webNodes(d: WebDriver): Promise<ScreenNode[]> {
  const page = d.p;
  const out: ScreenNode[] = [];
  for (const role of WEB_ROLES) {
    for (const el of (await page.getByRole(role).filter({ visible: true }).all()).slice(0, 150)) {
      const b = await el.boundingBox().catch(() => null);
      if (!b || b.width <= 0 || b.height <= 0) continue;
      const [aria, text] = await Promise.all([el.getAttribute('aria-label', { timeout: 500 }).catch(() => null), el.innerText({ timeout: 500 }).catch(() => '')]);
      const box = [b.x, b.y, b.width, b.height].map(Math.round) as ScreenNode['box'];
      out.push({ text: text.trim().split('\n')[0].slice(0, 200), desc: aria ?? '', rid: role, cls: role, clickable: role !== 'listitem', box, center: { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } });
    }
  }
  return out;
}

/** One snapshot of what the screen shows now. */
export async function snapshot(d: Driver, o: SnapshotOptions = {}): Promise<ScreenSnapshot> {
  const t0 = Date.now();
  const st = o.skipStable ? { ms: 0 } : await waitStable(d, o.stableMaxMs ?? 1500);
  const at = new Date().toISOString();
  if (d instanceof AndroidDriver) {
    const ts = Date.now();
    const [tree, png] = await Promise.all([
      readUiXml(d.o.udid).then((r) => ({ r, ms: Date.now() - ts })),
      (async () => {
        const s = Date.now();
        return { png: await d.screenshot().catch(() => undefined), ms: Date.now() - s };
      })(),
    ]);
    const img = png.png ? (() => { try { return decodePng(png.png!); } catch { return undefined; } })() : undefined;
    return {
      at,
      surface: d.surface,
      source: tree.r.backend,
      ...(tree.r.fallback ? { fallback: tree.r.fallback } : {}),
      ms: { stable: st.ms, tree: tree.ms, shot: png.ms, total: Date.now() - t0 },
      width: img?.width ?? 0,
      height: img?.height ?? 0,
      nodes: normalizeNodes(parseNodes(tree.r.xml, o.pkg ?? d.o.packageName)),
      ...(o.keepPng && png.png ? { png: png.png } : {}),
    };
  }
  if (d instanceof WebDriver && d.page) {
    const ts = Date.now();
    const [nodes, png] = await Promise.all([webNodes(d).then((n) => ({ n, ms: Date.now() - ts })), (async () => ({ png: await d.screenshot().catch(() => undefined), ms: Date.now() - ts }))()]);
    const vp = d.page.viewportSize();
    return { at, surface: d.surface, source: 'playwright', ms: { stable: st.ms, tree: nodes.ms, shot: png.ms, total: Date.now() - t0 }, width: vp?.width ?? 0, height: vp?.height ?? 0, nodes: nodes.n, ...(o.keepPng && png.png ? { png: png.png } : {}) };
  }
  throw new Error(`snapshot: unsupported driver (${d.surface})`);
}
