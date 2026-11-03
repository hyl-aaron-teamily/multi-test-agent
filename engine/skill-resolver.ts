// Runtime locate + cache (refactor P3, rule C1–C4): elements and reference regions are found on the live screen
// the first time they are needed outside the loop, then cached (skills/profile.ts). Rules first (SKILL finders
// over one screen snapshot), vision only to locate something about to be tapped. Inside the loop nothing is
// located: a missing element is an error (the warm-up round runs the plan's actions once, so whatever the
// loop uses was resolved there). A cached element is used as is (like a calibrated point); it is located again
// when a warm-up step on it fails or the home check no longer matches (refresh), and an app update or another
// screen size starts a new cache.
import { writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import type { Box } from '../core/image';
import { visionAsk, visionLocateRect } from '../core/model/midscene';
import { clickableOf, label, type ScreenNode } from '../core/screen-index';
import type { Driver } from '../drivers/types';
import { WebDriver } from '../drivers/web';
import { adb } from '../core/adb';
import { decodePng } from '../core/image';
import type { Surface } from '../platform/accounts/types';
import { cacheDir, cacheKey, loadCache, type Profile, saveCache, type SkillResolverLike } from '../skills/profile';
import { SKILL_VERSION } from '../skills/teamily/vocab';
import { finderFor, regionSpec } from '../skills/teamily/finders';
import { ELEMENTS } from '../skills/teamily/vocab';
import { snapshot } from './snapshot';

export interface LocateRecord {
  key: string;
  how: string;
  ms: number;
}

export class SkillResolver implements SkillResolverLike {
  inLoop = false;
  private seen = new Set<string>();
  /** What was located this run (report: 定位). */
  readonly located: LocateRecord[] = [];

  constructor(
    private p: Profile,
    private d: Driver,
    private log: (s: string) => void = () => {},
  ) {}

  private async nodes(): Promise<{ nodes: ScreenNode[]; png?: Buffer }> {
    const s = await snapshot(this.d, { stableMaxMs: 1200, keepPng: true });
    return { nodes: s.nodes, png: s.png };
  }

  private async bySelector(sel: string): Promise<Box | undefined> {
    if (!(this.d instanceof WebDriver) || !this.d.page) return undefined;
    try {
      const b = await this.d.page.locator(sel).filter({ visible: true }).last().boundingBox({ timeout: 1500 });
      return b ? ([b.x, b.y, b.width, b.height].map(Math.round) as Box) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Rules only (no vision): the element's box on the current screen. */
  private async find(id: string, nodes: ScreenNode[]): Promise<{ box: Box; fp?: ElementFp; how: string } | undefined> {
    const f = finderFor(id, this.p.surface);
    if (!f) return undefined;
    if (f.label) {
      const n = nodes.find((x) => labelsOf(x).some((l) => f.label!.test(l)));
      if (n) {
        const c = clickableOf(nodes, n);
        return { box: c.box, fp: fpOf(n), how: `label "${(labelsOf(n).find((l) => f.label!.test(l)) ?? label(n)).slice(0, 30)}"` };
      }
    }
    if (f.pick) {
      const n = f.pick(nodes, this.p.viewport);
      if (n) return { box: n.box, fp: fpOf(n), how: 'rule' };
    }
    if (f.selector) {
      const b = await this.bySelector(f.selector);
      if (b) return { box: b, how: `selector ${f.selector}` };
    }
    return undefined;
  }

  async element(id: string, o: { vision?: boolean } = { vision: true }): Promise<boolean> {
    if (this.inLoop) return !!this.p.elements[id];
    const spec = ELEMENTS.find((e) => e.id === id);
    if (spec && !spec.surfaces.includes(this.p.surface)) return false;
    if (this.p.elements[id] && this.seen.has(id)) return true;
    const t0 = Date.now();
    const { nodes } = await this.nodes();
    let r = await this.find(id, nodes);
    if (!r && (o.vision !== false || process.env.AUTOTEST_LOCATE_DEBUG)) this.log(`no rule match for ${id} among ${nodes.length} nodes${process.env.AUTOTEST_LOCATE_DEBUG ? `: ${nodes.map((n) => labelsOf(n).join('/')).filter(Boolean).slice(0, 60).join(' | ')}` : ''}`);
    // Cached and not found by rules now (vision-only control, or another page is showing): keep the cache.
    if (!r && this.p.elements[id]) {
      this.seen.add(id);
      return true;
    }
    let tier = '①';
    if (!r && o.vision !== false) {
      const desc = finderFor(id, this.p.surface)?.vision ?? spec?.meaning ?? id;
      const v = await visionLocateRect(this.d as any, desc, `locate ${id}`).catch(() => null);
      // Phone browser: a point on the browser's own toolbars is not the page's control (2026-11-03: its back
      // button was taken for the conversation's back arrow).
      const chrome = v && this.p.surface === 'android-web' ? browserChrome(nodes) : undefined;
      const onChrome = v && chrome && (v.y + v.h / 2 < chrome.top || v.y + v.h / 2 > chrome.bottom);
      if (onChrome) this.log(`vision put ${id} on the browser's toolbar — ignored`);
      if (v && v.w > 0 && v.h > 0 && !onChrome) r = { box: [v.x, v.y, v.w, v.h], how: 'vision' };
      tier = '③';
    }
    if (!r) return false;
    this.p.elements[id] = { page: spec?.page ?? '?', box: r.box, ...(r.fp ? { fingerprint: r.fp } : {}), tier, at: new Date().toISOString() };
    this.seen.add(id);
    this.located.push({ key: id, how: r.how, ms: Date.now() - t0 });
    this.log(`located ${id}: ${r.how} → [${r.box.join(',')}]`);
    await saveCache(this.p).catch(() => {});
    return true;
  }

  async region(key: string): Promise<boolean> {
    const [page, region] = key.split('/');
    if (this.p.refs[page]?.[region]) return true;
    if (this.inLoop) return false;
    const spec = regionSpec(key);
    if (!spec) return false;
    const t0 = Date.now();
    for (const a of spec.anchors) if (!(await this.element(a, { vision: false }))) return false;
    // Phone browser: its accessibility tree is not refreshed by in-page navigation, so an anchor "found" there
    // may belong to a page no longer shown. Capture only once the screen itself shows the anchors (vision).
    if (this.p.surface === 'android-web') {
      const what = spec.anchors.map((a) => finderFor(a, this.p.surface)?.vision ?? a).join('; and ');
      const shown = await visionAsk(this.d as any, `The page on screen shows: ${what}`, 'prep').catch(() => null);
      if (shown !== true) {
        this.log(`reference ${key} not captured: the screen does not show its anchors (vision: ${shown})`);
        return false;
      }
    }
    const { nodes, png } = await this.nodes();
    const box = spec.box({ surface: this.p.surface, vp: this.p.viewport, nodes, el: (id) => this.p.elements[id]?.box });
    if (!box || !png) return false;
    const image = `ref-${page}-${region.replace(/[^\w.-]/g, '_')}.png`;
    await mkdir(cacheDir(this.p.name), { recursive: true });
    await writeFile(`${cacheDir(this.p.name)}/${image}`, png);
    (this.p.refs[page] ??= {})[region] = { box: box.map(Math.round) as Box, image, at: new Date().toISOString() };
    this.located.push({ key, how: 'captured', ms: Date.now() - t0 });
    this.log(`captured reference ${key} → [${box.map(Math.round).join(',')}]`);
    await saveCache(this.p).catch(() => {});
    return true;
  }

  async refresh(key: string, o: { rulesOnly?: boolean } = {}): Promise<boolean> {
    if (this.inLoop) return false;
    if (key.includes('/')) {
      const [page, region] = key.split('/');
      const spec = regionSpec(key);
      for (const a of spec?.anchors ?? []) {
        this.seen.delete(a);
        delete this.p.elements[a];
      }
      if (this.p.refs[page]) delete this.p.refs[page][region];
      return this.region(key);
    }
    this.seen.delete(key);
    delete this.p.elements[key];
    return this.element(key, { vision: !o.rulesOnly });
  }
}

type ElementFp = { text?: string; desc?: string; cls?: string };
const fpOf = (n: ScreenNode): ElementFp => ({ ...(n.text ? { text: n.text } : {}), ...(n.desc ? { desc: n.desc } : {}), ...(n.cls ? { cls: n.cls } : {}) });

/** The SKILL profile of a running driver: cache of surface@env@appVersion@screen size, with a resolver.
 *  `into`: fill this object (callers already hold it) instead of a new one. */
export async function skillProfile(d: Driver, o: { surface: Surface; env: 'test' | 'prod'; udid?: string; packageName?: string; log?: (s: string) => void; into?: Profile }): Promise<Profile> {
  let viewport = { width: 0, height: 0 };
  let appVersion: string | undefined;
  if (d instanceof WebDriver) viewport = await d.viewport();
  else {
    const img = decodePng(await d.screenshot());
    viewport = { width: img.width, height: img.height };
    if (o.udid && o.packageName) appVersion = (await adb(['shell', `dumpsys package ${o.packageName} | grep -m1 versionName=`], o.udid, 10_000).catch(() => '')).match(/versionName=(\S+)/)?.[1];
  }
  const name = cacheKey(o.surface, o.env, appVersion, viewport);
  const p = Object.assign(o.into ?? ({} as Profile), loadCache({ surface: o.surface, skillVersion: SKILL_VERSION, env: o.env, appVersion, viewport, packageName: o.packageName }, name));
  p.resolver = new SkillResolver(p, d, (m) => o.log?.(`skill: ${m}`));
  o.log?.(`SKILL cache ${name}: ${Object.keys(p.elements).length} element(s), ${Object.values(p.refs).reduce((n, r) => n + Object.keys(r).length, 0)} reference region(s)`);
  return p;
}

/** Names a node can be recognised by: its text, its accessibility description, and the description without the
 *  state Teamily appends to it ("聊天, 11", "记忆, 有新更新"). */
export function labelsOf(n: Pick<ScreenNode, 'text' | 'desc'>): string[] {
  const out = [n.text.trim(), n.desc.trim(), n.desc.split(/[,，]/)[0].trim()];
  return [...new Set(out.filter(Boolean))];
}

/** Phone browser: the page area between the browser's own title bar and bottom bar (native views, whose
 *  accessibility nodes stay current). */
function browserChrome(nodes: ScreenNode[]): { top: number; bottom: number } | undefined {
  const bar = (id: string) => nodes.find((n) => (n as ScreenNode & { rid?: string }).rid === `com.android.browser:id/${id}`);
  const top = bar('titleBar') ?? bar('nav_bar');
  const bottom = bar('bottom_bar');
  if (!top && !bottom) return undefined;
  return { top: top ? top.box[1] + top.box[3] : 0, bottom: bottom ? bottom.box[1] : Number.POSITIVE_INFINITY };
}
