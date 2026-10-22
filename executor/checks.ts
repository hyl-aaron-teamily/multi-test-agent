// Checkpoint evaluation. Cheap first: region perceptual hash against the SKILL reference; only a
// mismatch (or an explicit ai check) goes to the vision model — and every vision call is counted.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Box, decodePng, dHash, hamming, type Rgba, regionDiffFraction, scaleBox } from '../core/image';
import type { Driver } from '../drivers/types';
import { modelCalls } from '../issue/llm';
import type { CheckPoint } from '../platform/schema/test-plan';
import { type Profile, SKILL_DIR, SkillStaleError } from '../skills/profile';
import { onAndroid } from '../platform/accounts/types';

export const MATCH_DISTANCE = 12;
/** Region counts as matching the reference when fewer than this fraction of its pixels differ. */
export const MATCH_FRACTION = 0.12;
/** Regions whose vertical position depends on content (the picker grows with the member count). */
const SLIDING: Record<string, number> = { 'mention-picker/picker': 520, 'chat/composer': 1000 };
/** Regions whose horizontal position depends on content (right-aligned toolbars that gain icons while loading). */
const SLIDING_X: Record<string, number> = { 'clouddoc/element:clouddoc.bell': 160 };

export interface CheckResult {
  check: CheckPoint;
  pass: boolean | null;
  detail: string;
  distance?: number;
  vision?: boolean;
}

export function dprOf(p: Profile, img: Rgba): number {
  return img.width / p.viewport.width;
}

/** Pure: best hash distance of a reference region in a screenshot (optionally sliding vertically). */
export function regionDistance(img: Rgba, box: Box, hash: string, dpr: number, slide = 0): number {
  let best = 64;
  const step = Math.max(2, Math.round(4 * dpr));
  const px = scaleBox(box, dpr);
  const lo = Math.max(0, px[1] - Math.round(slide * dpr));
  const hi = Math.min(img.height - px[3], px[1] + Math.round(slide * 0.3 * dpr));
  for (let y = slide ? lo : px[1]; y <= (slide ? hi : px[1]); y += step) {
    best = Math.min(best, hamming(dHash(img, [px[0], y, px[2], px[3]]), hash));
    if (best === 0) break;
  }
  return best;
}

const refImages = new Map<string, Rgba>();
function refImage(p: Profile, page: string): Rgba | undefined {
  const f = p.refs[page]?.image;
  if (!f) return undefined;
  if (!refImages.has(f)) refImages.set(f, decodePng(readFileSync(join(SKILL_DIR, f))));
  return refImages.get(f);
}

/** Pure: smallest differing-pixel fraction of the reference region within a vertical search window. */
export function regionMatch(img: Rgba, ref: Rgba, box: Box, dpr: number, slide = 0, slideX = 0): { fraction: number; dy: number; dx?: number } {
  if (slideX) {
    // Horizontal search: compare the reference crop against shifted windows of the screenshot.
    let best = { fraction: 1, dy: 0, dx: 0 };
    const stepX = Math.max(2, Math.round(2 * dpr));
    for (let dx = -Math.round(slideX * dpr); dx <= Math.round(slideX * dpr); dx += stepX) {
      const shifted = shiftX(img, dx);
      const m = regionMatch(shifted, ref, box, dpr, slide);
      if (m.fraction < best.fraction) best = { ...m, dx };
      if (m.fraction === 0) break;
    }
    return best;
  }
  const px = scaleBox(box, dpr);
  const step = Math.max(2, Math.round(4 * dpr));
  let best = { fraction: 1, dy: 0 };
  const lo = slide ? -Math.round(slide * dpr) : 0;
  const hi = slide ? Math.round(slide * 0.3 * dpr) : 0;
  // Search outward from the calibrated position so dy = 0 is always tried first.
  for (let k = 0; k * step <= Math.max(-lo, hi); k++) {
    for (const dy of k ? [k * step, -k * step] : [0]) {
      if (dy < lo || dy > hi) continue;
      const f = regionDiffFraction(img, ref, px, dy);
      if (f < best.fraction) best = { fraction: f, dy };
      if (f === 0) return best;
    }
  }
  return best;
}

/** View of `img` moved left by dx (pixel x+dx shown at x); out-of-range columns are white. */
function shiftX(img: Rgba, dx: number): Rgba {
  const out = new Uint8Array(img.data.length).fill(255);
  for (let y = 0; y < img.height; y++) {
    const row = y * img.width * 4;
    const from = Math.max(0, dx);
    const to = Math.min(img.width, img.width + dx);
    out.set(img.data.subarray(row + from * 4, row + to * 4), row + (from - dx) * 4);
  }
  return { width: img.width, height: img.height, data: out };
}

/** Element regions ("element:<id>") are hashed lazily from the page reference image. */
export function refFor(p: Profile, page: string, region: string): { box: Box; hash: string } | undefined {
  const r = p.refs[page];
  if (!r) return undefined;
  if (region.startsWith('element:')) {
    const el = p.elements[region.slice(8)];
    const key = Object.keys(r.regions).find((k) => k === 'bell' || k === region.slice(8).split('.')[1]);
    if (el && key) return { box: r.regions[key], hash: r.hashes[key] };
    return undefined;
  }
  return r.regions[region] ? { box: r.regions[region], hash: r.hashes[region] } : undefined;
}

export type VisionAsk = (question: string) => Promise<boolean | null>;

export async function evaluateVisual(driver: Driver, p: Profile, c: CheckPoint, ask?: VisionAsk, shot?: Buffer): Promise<CheckResult> {
  const ref = refFor(p, c.page ?? '', c.region ?? '');
  if (!ref) return { check: c, pass: null, detail: `no reference for ${c.page}/${c.region} (calibrate first)` };
  const img = decodePng(shot ?? (await driver.screenshot()));
  const refImg = refImage(p, c.page ?? '');
  if (!refImg) return { check: c, pass: null, detail: `reference image of ${c.page} missing` };
  const m = regionMatch(img, refImg, ref.box, dprOf(p, img), SLIDING[`${c.page}/${c.region}`] ?? 0, SLIDING_X[`${c.page}/${c.region}`] ?? 0);
  const dist = Math.round(m.fraction * 100);
  const present = m.fraction <= MATCH_FRACTION;
  const pass = c.want === 'absent' ? !present : present;
  if (pass || !ask || c.onlyOnAnomaly === false) return { check: c, pass, detail: `region ${c.page}/${c.region} ${present ? 'matches' : 'differs'} (diff ${dist}%)`, distance: dist };
  // Anomaly: ask the vision model once to tell real problem / transient / operation drift.
  const v = await ask(`${c.expect}. Answer true if this is the case on the screen now.`);
  if (v === null) return { check: c, pass, detail: `region differs (diff ${dist}%); vision unavailable → counted as observed`, distance: dist };
  return { check: c, pass: v, detail: `region differs (diff ${dist}%); vision says ${v ? 'expected state present (hash false alarm)' : 'expected state absent'}`, distance: dist, vision: true };
}

export async function evaluateAi(c: CheckPoint, ask?: VisionAsk, votes = 3): Promise<CheckResult> {
  if (!ask) return { check: c, pass: null, detail: 'vision model not available — 未验证' };
  // One-off acceptance judgements: majority of `votes` independent answers (single answers flip).
  const answers: (boolean | null)[] = [];
  for (let i = 0; i < votes; i++) {
    answers.push(await ask(c.expect));
    const yes = answers.filter((x) => x === true).length;
    const no = answers.filter((x) => x === false).length;
    if (yes > votes / 2 || no > votes / 2) break;
  }
  const yes = answers.filter((x) => x === true).length;
  const no = answers.filter((x) => x === false).length;
  if (!yes && !no) return { check: c, pass: null, detail: 'vision call failed — 未验证', vision: true };
  const v = yes > no;
  return { check: c, pass: c.want === 'absent' ? !v : v, detail: `vision: ${v} (votes yes ${yes} / no ${no})`, vision: true };
}

/** SKILL staleness: the home navigation region must still match the reference. */
export async function assertSkillFresh(driver: Driver, p: Profile, page = 'home', region = 'nav'): Promise<number> {
  const r = refFor(p, page, region);
  const refImg = refImage(p, page);
  if (!r || !refImg) return -1;
  const img = decodePng(await driver.screenshot());
  const m = regionMatch(img, refImg, r.box, dprOf(p, img));
  if (m.fraction > 0.35) throw new SkillStaleError(page, `region ${region} differs from the reference (${Math.round(m.fraction * 100)}% of its marks missing)`);
  return m.fraction;
}

/** Midscene vision ask bound to a driver (web: PlaywrightAgent, android: AndroidAgent). */
export async function visionAsker(driver: Driver & { page?: unknown; o?: any }): Promise<VisionAsk | undefined> {
  if (process.env.ISSUE_NO_VISION === '1' || !process.env.MIDSCENE_MODEL_API_KEY) return undefined;
  let agent: { aiBoolean(q: string): Promise<boolean> } | undefined;
  return async (q) => {
    try {
      if (!agent) {
        if (onAndroid(driver.surface)) {
          const { AndroidAgent, AndroidDevice } = await import('@midscene/android');
          const dev = new AndroidDevice(driver.o.udid);
          await dev.connect();
          agent = new AndroidAgent(dev, { generateReport: false } as any) as any;
        } else {
          const { PlaywrightAgent } = await import('@midscene/web/playwright');
          agent = new PlaywrightAgent(driver.page as any, { generateReport: false } as any) as any;
        }
      }
      modelCalls.vision++;
      return await agent!.aiBoolean(q);
    } catch (err) {
      console.warn(`[vision] ${(err as Error).message.split('\n')[0]}`);
      return null;
    }
  };
}

/** Poll the screen until one of the reference regions shows (page/region keys), or time out.
 *  Returns the first key that matched, or undefined. One screenshot per poll, no model. */
export async function waitForRegion(driver: Driver, p: Profile, keys: string[], ms = 30_000, every = 1500, tolerance = 0.35): Promise<string | undefined> {
  const t0 = Date.now();
  for (;;) {
    const img = decodePng(await driver.screenshot());
    for (const k of keys) {
      const [page, region] = k.split('/');
      const r = refFor(p, page, region);
      const refImg = refImage(p, page);
      if (!r || !refImg) continue;
      const m = regionMatch(img, refImg, r.box, dprOf(p, img), SLIDING[k] ?? 0);
      if (m.fraction <= tolerance) return k;
    }
    if (Date.now() - t0 > ms) return undefined;
    await new Promise((res) => setTimeout(res, every));
  }
}
