// Tiered locate (W2-1 §4.2), outside the loop only (preparation, calibration, dialogs, re-resolve):
//   ① literal text: Android accessibility tree / Playwright getByText (exact, then substring) — the centre of
//     the clickable ancestor (Android) or of the element (web)
//   ② ranker slot (empty this milestone)
//   ③ Midscene aiLocate on the screenshot
// Every call records its tier and time (locateTally → report).
import type { Page } from 'playwright';
import { clickableAncestor, dumpTree, findByText, nodeCenter } from '../core/ui-tree';
import { visionLocateRect } from '../core/model/midscene';
import { AndroidDriver } from '../drivers/android';
import type { Driver, Point } from '../drivers/types';
import { WebDriver } from '../drivers/web';
import { noRanker, type Ranker, type Tier } from './observe';
import { addTier } from './stats';

export interface Located {
  point: Point;
  tier: Tier;
  ms: number;
  how: string;
}

/** Process-wide tally of locate tiers (merged into run stats). */
export const locateTally: Record<string, { n: number; ms: number }> = {};

/** Locate by literal text (① only). */
export async function locateText(d: Driver, texts: string[], newest = false): Promise<Located | undefined> {
  const t0 = Date.now();
  if (d instanceof AndroidDriver) {
    const nodes = await dumpTree(d.o.udid, d.o.packageName, 3);
    for (const t of texts) {
      const f = findByText(nodes, t, undefined, { newest });
      if (!f) continue;
      const target = clickableAncestor(nodes, f.node) ?? f.node;
      return { point: nodeCenter(target), tier: '①', ms: Date.now() - t0, how: `accessibility ${f.how} "${t}"` };
    }
  } else if (d instanceof WebDriver && d.page) {
    for (const t of texts) {
      const b = (await boxOf(d.page, t, true)) ?? (await boxOf(d.page, t, false));
      if (b) return { point: { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }, tier: '①', ms: Date.now() - t0, how: `page text "${t}"` };
    }
  }
  return undefined;
}

async function boxOf(page: Page, text: string, exact: boolean) {
  try {
    return await page.getByText(text, { exact }).filter({ visible: true }).first().boundingBox({ timeout: 1000 });
  } catch {
    return null;
  }
}

export interface LocateOptions {
  /** Literal texts the target shows (tier ①); none = straight to ②/③. */
  texts?: string[];
  ranker?: Ranker;
  purpose?: string;
  /** Prefer the bottom-most match outside quote blocks (the newest message). */
  newest?: boolean;
}

/** ① → ② → ③. undefined when nothing found. */
export async function locate(d: Driver, description: string, o: LocateOptions = {}): Promise<Located | undefined> {
  const t0 = Date.now();
  let r = o.texts?.length ? await locateText(d, o.texts, o.newest) : undefined;
  if (!r && (o.ranker ?? noRanker) !== noRanker) {
    /* ② slot: rankers rank accessibility texts; none is configured this milestone. */
  }
  if (!r) {
    const v = await visionLocateRect(d as any, description, o.purpose ?? 'locate');
    if (v) r = { point: { x: Math.round(v.x + v.w / 2), y: Math.round(v.y + v.h / 2) }, tier: '③', ms: Date.now() - t0, how: 'vision' };
  }
  addTier(locateTally, r ? r.tier : 'miss', Date.now() - t0);
  return r;
}

/** Pure: literal texts embedded in a description ("…the "忽略" (Ignore) button…" → ['忽略', 'Ignore']). */
export function literalsOf(description: string): string[] {
  return [...description.matchAll(/["“「]([^"”」]{1,30})["”」]|\(([^()]{1,30})\)/g)].map((m) => (m[1] ?? m[2]).trim()).filter(Boolean);
}
