// Checkpoint evaluation. Cheap first: region pixels against the reference captured from the live screen
// (SKILL cache, refactor P3); only a mismatch (or an explicit ai check) goes to the vision model — and every
// vision call is counted. A missing reference is captured outside the loop when its anchors are on screen.
import { visionAsk, visionEnabled } from '../core/model/midscene';
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import { type Box, decodePng, type Rgba, regionDiffFraction, scaleBox } from '../core/image';
import type { Driver } from '../drivers/types';
import { majority } from '../core/model/llm';
import type { CheckPoint } from '../platform/schema/test-plan';
import { type Profile, type RegionRef, refImagePath, saveCache, SkillStaleError, type Theme } from '../skills/profile';

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
  /** The check could not apply to this round (e.g. no message of this round on screen): operation drift. */
  drift?: string;
}

export function dprOf(p: Profile, img: Rgba): number {
  return img.width / p.viewport.width;
}

const refImages = new Map<string, Rgba>();
function refImage(p: Profile, image: string): Rgba | undefined {
  const f = refImagePath(p, image);
  // Keyed by modification time too: a reference captured again (theme switch, redesign) rewrites the same file.
  let key: string;
  try {
    key = `${f}@${statSync(f).mtimeMs}`;
  } catch {
    return undefined;
  }
  if (!refImages.has(key)) {
    try {
      refImages.set(key, decodePng(readFileSync(f)));
    } catch {
      return undefined;
    }
  }
  return refImages.get(key);
}

/** Pure: the theme of a region: dark when its mean luminance is low. */
export function themeOf(img: Rgba, box: Box): Theme {
  const [bx, by, bw, bh] = box.map(Math.round);
  let n = 0;
  let sum = 0;
  for (let y = Math.max(0, by); y < Math.min(img.height, by + bh); y += 4) {
    for (let x = Math.max(0, bx); x < Math.min(img.width, bx + bw); x += 4) {
      const o = (y * img.width + x) * 4;
      sum += 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
      n++;
    }
  }
  return n && sum / n < 110 ? 'dark' : 'light';
}

/** The reference and its other-theme variants, decoded (W2-5 §8.1). */
function variants(p: Profile, r: RegionRef): { box: Box; img: Rgba; theme?: Theme }[] {
  return [{ box: r.box, image: r.image, theme: r.theme }, ...(r.alts ?? [])].flatMap((v) => {
    const img = refImage(p, v.image);
    return img ? [{ box: v.box, img, theme: v.theme }] : [];
  });
}

/** Best match of a region over its theme variants: the smallest difference and the theme it came from. */
function bestMatch(img: Rgba, p: Profile, key: string, r: RegionRef): { fraction: number; theme?: Theme } {
  let best: { fraction: number; theme?: Theme } = { fraction: 1 };
  for (const v of variants(p, r)) {
    const m = regionMatch(img, v.img, v.box, dprOf(p, img), SLIDING[key] ?? 0, SLIDING_X[key] ?? 0);
    if (m.fraction < best.fraction) best = { fraction: m.fraction, theme: v.theme ?? themeOf(v.img, v.box) };
  }
  return best;
}

/** Pure: a capture that replaces `old` (outside the loop, after a theme switch): the old one is kept under its
 *  own theme's name as a variant, one per theme. `rename` copies the old screenshot to its variant file name. */
export function withThemeVariant(fresh: RegionRef, old: RegionRef, oldTheme: Theme, freshTheme: Theme, rename: (from: string, to: string) => void): RegionRef {
  const alts = (old.alts ?? []).filter((a) => a.theme !== freshTheme && a.theme !== oldTheme);
  if (oldTheme !== freshTheme) {
    const image = old.image.replace(/\.png$/, `.${oldTheme}.png`);
    rename(old.image, image);
    alts.unshift({ box: old.box, image, theme: oldTheme });
  } else alts.push(...(old.alts ?? []).filter((a) => a.theme === oldTheme && a.theme !== freshTheme));
  return { ...fresh, theme: freshTheme, ...(alts.length ? { alts } : {}) };
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
  // Search outward from the captured position so dy = 0 is always tried first.
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

/** The cached reference of `page/region` (element regions: `element:<id>`). */
export function refFor(p: Profile, page: string, region: string): { box: Box; image: string } | undefined {
  return p.refs[page]?.[region];
}

/** The reference of a key, captured now (outside the loop) when it is missing. */
async function ensureRef(p: Profile, key: string): Promise<{ box: Box; img: Rgba } | undefined> {
  const [page, region] = key.split('/');
  if (!refFor(p, page, region) && p.resolver && !p.resolver.inLoop) await p.resolver.region(key);
  const r = refFor(p, page, region);
  const img = r && refImage(p, r.image);
  return r && img ? { box: r.box, img } : undefined;
}

export type VisionAsk = (question: string) => Promise<boolean | null>;

export async function evaluateVisual(driver: Driver, p: Profile, c: CheckPoint, ask?: VisionAsk, shot?: Buffer): Promise<CheckResult> {
  const key = `${c.page ?? ''}/${c.region ?? ''}`;
  const had = !!refFor(p, c.page ?? '', c.region ?? '');
  const ref = await ensureRef(p, key);
  if (!ref) {
    // Never seen, and its anchors are not on screen now. "Not found" is not proof of absence (the page may not
    // be the right one): only the vision model may decide; without it the check is unverified.
    if (!ask) return { check: c, pass: null, detail: `region ${key}: anchors not on screen (no reference yet) — 未验证` };
    const v = await ask(`${c.expect}. Answer true if this is the case on the screen now.`);
    // `expect` describes the state; want 'absent' passes when the model says it is not the case.
    return { check: c, pass: v === null ? null : c.want === 'absent' ? !v : v, detail: `region ${key}: no reference, anchors not found; vision says ${v}`, vision: true };
  }
  // Captured just now from this very screen: it shows.
  if (!had) return { check: c, pass: c.want !== 'absent', detail: `region ${key} captured now (present)` };
  const img = decodePng(shot ?? (await driver.screenshot()));
  const m = bestMatch(img, p, key, refFor(p, c.page ?? '', c.region ?? '')!);
  const dist = Math.round(m.fraction * 100);
  const present = m.fraction <= MATCH_FRACTION;
  const pass = c.want === 'absent' ? !present : present;
  if (pass || !ask || c.onlyOnAnomaly === false) return { check: c, pass, detail: `region ${c.page}/${c.region} ${present ? `matches (${m.theme ?? '-'} theme)` : 'differs'} (diff ${dist}%)`, distance: dist };
  // Anomaly: ask the vision model once to tell real problem / transient / operation drift.
  const v = await ask(`${c.expect}. Answer true if this is the case on the screen now.`);
  if (v === null) return { check: c, pass, detail: `region differs (diff ${dist}%); vision unavailable → counted as observed`, distance: dist };
  return { check: c, pass: c.want === 'absent' ? !v : v, detail: `region ${present ? 'matches' : 'differs'} (diff ${dist}%); vision says the described state is ${v ? 'there' : 'not there'}`, distance: dist, vision: true };
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
  const { yes, no } = majority(answers);
  if (!yes && !no) return { check: c, pass: null, detail: 'vision call failed — 未验证', vision: true };
  const v = yes > no;
  return { check: c, pass: c.want === 'absent' ? !v : v, detail: `vision: ${v} (votes yes ${yes} / no ${no})`, vision: true };
}

/** SKILL staleness: the home navigation region must match its reference; when it does not, its anchors are
 *  located again (the layout may have moved) — only when they cannot be found is the SKILL stale. */
export async function assertSkillFresh(driver: Driver, p: Profile, page = 'home', region = 'nav'): Promise<number> {
  const key = `${page}/${region}`;
  const had = !!refFor(p, page, region);
  const r = await ensureRef(p, key);
  if (!r) throw new SkillStaleError(page, `${key} 的锚点（${page === 'home' ? '聊天入口' : key}）在当前屏幕上找不到`);
  if (!had) return 0;
  const img = decodePng(await driver.screenshot());
  const m = regionMatch(img, r.img, r.box, dprOf(p, img));
  if (m.fraction <= 0.35) return m.fraction;
  if (p.resolver && !p.resolver.inLoop && (await p.resolver.refresh(key))) return 0;
  throw new SkillStaleError(page, `region ${region} differs from its reference (${Math.round(m.fraction * 100)}% of its marks missing) and its anchors are not found again`);
}

/** Midscene vision ask bound to a driver (web: PlaywrightAgent, android: AndroidAgent), agent cached. */
export async function visionAsker(driver: Driver & { page?: unknown; o?: any }): Promise<VisionAsk | undefined> {
  if (!visionEnabled()) return undefined;
  return (q) => visionAsk(driver, q);
}

/** The reference region `page/region` shows in this screenshot (pixels only: no tree, no model). False
 *  when the profile has no such reference. */
export function regionShows(img: Rgba, p: Profile, key: string, tolerance = MATCH_FRACTION): boolean {
  const [page, region] = key.split('/');
  const r = refFor(p, page, region);
  if (!r) return false;
  return bestMatch(img, p, key, r).fraction <= tolerance;
}

/** Poll the screen until one of the reference regions shows on two polls in a row (a page that is still
 *  loading can show a region for a moment and then redraw), or time out. Returns the key, or undefined.
 *  One screenshot per poll, no model. */
export async function waitForRegion(driver: Driver, p: Profile, keys: string[], ms = 30_000, every = 1500, tolerance = 0.35): Promise<string | undefined> {
  const t0 = Date.now();
  let last: string | undefined;
  let refreshed = false;
  for (;;) {
    // A region never captured yet: capture it as soon as its anchors are on screen (outside the loop).
    for (const k of keys) if (!refFor(p, ...(k.split('/') as [string, string]))) await ensureRef(p, k);
    const img = decodePng(await driver.screenshot());
    let hit = keys.find((k) => regionShows(img, p, k, tolerance));
    // Still no match after a while, outside the loop: the reference may be stale (the phone switched between
    // light and dark theme, 2026-11-03; a redesign). Capture it again where its anchors are found now.
    if (!hit && !refreshed && Date.now() - t0 > Math.min(6000, ms / 3) && p.resolver && !p.resolver.inLoop) {
      refreshed = true;
      for (const k of keys) {
        const [page, region] = k.split('/');
        const old = p.refs[page]?.[region];
        if (!old) continue;
        const oldImg = refImage(p, old.image);
        const oldTheme = old.theme ?? (oldImg ? themeOf(oldImg, old.box) : 'light');
        // Keep the old capture before the new one overwrites its file: it is the other theme's variant.
        const keep = old.image.replace(/\.png$/, '.prev.png');
        try {
          copyFileSync(refImagePath(p, old.image), refImagePath(p, keep));
        } catch {}
        delete p.refs[page][region];
        if (!(await ensureRef(p, k))) {
          p.refs[page][region] = old;
          continue;
        }
        const fresh = p.refs[page][region];
        const freshImg = refImage(p, fresh.image);
        const freshTheme = freshImg ? themeOf(freshImg, fresh.box) : 'light';
        p.refs[page][region] = withThemeVariant(fresh, { ...old, image: keep }, oldTheme, freshTheme, (from, to) => {
          try {
            copyFileSync(refImagePath(p, from), refImagePath(p, to));
          } catch {}
        });
        await saveCache(p).catch(() => {});
      }
      const again = decodePng(await driver.screenshot());
      hit = keys.find((k) => regionShows(again, p, k, tolerance));
    }
    if (hit && hit === last) return hit;
    last = hit;
    if (Date.now() - t0 > ms) return undefined;
    await new Promise((res) => setTimeout(res, every));
  }
}
