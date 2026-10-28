// Observation library (W2-1 §4.1): every check is decided by the first channel that gives a definite
// answer — ① deterministic (log / process / system state / accessibility or page text / region) → ② ranker
// slot (empty) → ③ vision. Only at round-end checkpoints, preparation and warm-up — never per step.
// Each decision records its tier and time (report: 判定分层统计).
import type { Page } from 'playwright';
import { clickableAncestor, dumpTree, inside, keyboardShown, matches, type TextMatch, type UiNode } from '../core/ui-tree';
import { visionAsk } from '../core/model/midscene';
import { AndroidDriver } from '../drivers/android';
import type { Driver, Point } from '../drivers/types';
import { WebDriver } from '../drivers/web';
import type { CheckPoint } from '../platform/schema/test-plan';
import type { CheckResult } from './checks';

export type Tier = '①' | '②' | '③';

export interface Observed extends CheckResult {
  tier?: Tier;
  ms?: number;
}

/** ② slot: rank candidate texts against a description. Empty this milestone (D2). */
export interface Ranker {
  rank(query: string, candidates: string[]): Promise<{ index: number; score: number } | undefined>;
}
export const noRanker: Ranker = { rank: async () => undefined };

/** Observation ids → surfaces where a deterministic (①) channel exists. Used by the plan validator. */
export const OBSERVATIONS: Record<string, { meaning: string; tier1: string[]; usable: string[] }> = {
  crash: { meaning: '闪退 / ANR / 页面崩溃', tier1: ['android-app', 'android-web', 'mobile-web', 'desktop-web'], usable: ['android-app', 'android-web', 'mobile-web', 'desktop-web'] },
  'process-alive': { meaning: '进程存活', tier1: ['android-app', 'android-web'], usable: ['android-app', 'android-web'] },
  'keyboard-shown': { meaning: '软键盘弹出', tier1: ['android-app', 'android-web'], usable: ['android-app', 'android-web'] },
  region: { meaning: '参考区域在 / 不在', tier1: ['android-app', 'android-web', 'mobile-web', 'desktop-web'], usable: ['android-app', 'android-web', 'mobile-web', 'desktop-web'] },
  text: { meaning: '指定文字在 / 不在（可限定引用块 / 目标附近）', tier1: ['android-app', 'mobile-web', 'desktop-web'], usable: ['android-app', 'android-web', 'mobile-web', 'desktop-web'] },
  'quoted-original': { meaning: '点引用后落在被引用的原消息', tier1: ['android-app', 'mobile-web', 'desktop-web'], usable: ['android-app', 'android-web', 'mobile-web', 'desktop-web'] },
  element: { meaning: '元素存在 / 不存在', tier1: ['android-app', 'android-web', 'mobile-web', 'desktop-web'], usable: ['android-app', 'android-web', 'mobile-web', 'desktop-web'] },
  'visual-question': { meaning: '自由视觉问题（只能视觉）', tier1: [], usable: ['android-app', 'android-web', 'mobile-web', 'desktop-web'] },
};

/** Pure: the observation id a check kind implements. */
export function observationOf(k: CheckPoint): string {
  switch (k.kind) {
    case 'crash':
    case 'page-error':
    case 'console-error':
      return 'crash';
    case 'keyboard':
      return 'keyboard-shown';
    case 'visual-region':
      return k.region?.startsWith('element:') ? 'element' : 'region';
    case 'baseline':
      return 'quoted-original';
    case 'ai':
      return 'visual-question';
    default:
      return k.kind;
  }
}

const wantPass = (k: CheckPoint, present: boolean) => (k.want === 'absent' ? !present : present);

/** Soft keyboard: ① system state on Android; ③ vision elsewhere / when the system answer is missing. */
export async function observeKeyboard(d: Driver, k: CheckPoint): Promise<Observed> {
  const t0 = Date.now();
  if (d instanceof AndroidDriver) {
    const shown = await keyboardShown(d.o.udid);
    if (shown !== null) return { check: k, pass: wantPass(k, shown), detail: `keyboard ${shown ? 'shown' : 'not shown'} (dumpsys input_method)`, tier: '①', ms: Date.now() - t0 };
  }
  const v = await visionAsk(d as any, 'The on-screen (soft) keyboard is shown at the bottom of the screen', 'checkpoint');
  if (v === null) return { check: k, pass: null, detail: 'keyboard state unknown (no system answer, vision unavailable) — 未验证', ms: Date.now() - t0 };
  return { check: k, pass: wantPass(k, v), detail: `vision: keyboard ${v ? 'shown' : 'not shown'}`, vision: true, tier: '③', ms: Date.now() - t0 };
}

const describeMatch = (m: TextMatch) => ('exact' in m ? `"${m.exact}"` : 'contains' in m ? `text containing "${m.contains}"` : `text matching /${m.regex}/`);

/** Pure: the newest (bottom-most) message carrying `anchor` — never the composer — and every node of its
 *  bubble / list row (its smallest clickable container). undefined = no such message on screen. */
export function messageNodes(nodes: UiNode[], anchor: string): UiNode[] | undefined {
  const hit = nodes.filter((n) => !/EditText/.test(n.cls) && (n.text.includes(anchor) || n.desc.includes(anchor))).sort((a, b) => b.y1 - a.y1)[0];
  if (!hit) return undefined;
  const box = clickableAncestor(nodes, hit) ?? hit;
  return nodes.filter((n) => inside(n, box));
}

/** Pure: does a plain string match? */
export const textMatches = (t: string, m: TextMatch) => matches({ text: t, desc: '' } as UiNode, m);

/** Pure: Android nodes in a text check's scope. */
export function scopeNodes(nodes: UiNode[], k: CheckPoint, targets: Record<string, Point>, viewportWidth: number): UiNode[] {
  const s = k.scope ?? 'screen';
  if (s === 'screen') return nodes;
  if (s === 'composer') return nodes.filter((n) => /EditText/.test(n.cls)).sort((a, b) => b.y1 - a.y1).slice(0, 1);
  if (s === 'quote-cards') return nodes.filter((n) => n.clickable && /^[^,]{1,60}, .+/.test(n.desc) && n.x1 > viewportWidth * 0.1);
  if ('message' in s) return messageNodes(nodes, s.message) ?? [];
  const p = targets[s.target];
  if (!p) return [];
  return nodes.filter((n) => Math.abs((n.y1 + n.y2) / 2 - p.y) <= (s.within ?? 250));
}

/** Text on screen: ① accessibility tree (Android) / page text (Playwright, read-only) → ③ vision. */
export async function observeText(d: Driver, k: CheckPoint, targets: Record<string, Point>, viewportWidth: number, pkg?: string): Promise<Observed> {
  const t0 = Date.now();
  const m = k.match;
  if (!m) return { check: k, pass: null, detail: 'text check without match' };
  if (k.scope === 'composer') {
    // The input's own text (an empty input reports its placeholder: read as '').
    const t = await composerText(d);
    if (t === null) return { check: k, pass: null, detail: 'composer not readable — 未验证', drift: 'composer not readable', ms: Date.now() - t0 };
    const hit = textMatches(t, m);
    return { check: k, pass: wantPass(k, hit), detail: `composer ${hit ? 'has' : 'does not have'} ${describeMatch(m)} — now "${t.slice(0, 120).replace(/\s+/g, ' ')}"${t.length > 120 ? '…' : ''} (${d instanceof AndroidDriver ? 'accessibility' : 'page text'})`, tier: '①', ms: Date.now() - t0 };
  }
  if (typeof k.scope === 'object' && 'message' in k.scope) {
    const anchor = k.scope.message;
    if (!(d instanceof AndroidDriver)) return { check: k, pass: null, detail: 'message scope is read from the accessibility tree (Android) only — 未验证', ms: Date.now() - t0 };
    const nodes = await dumpTree(d.o.udid, pkg ?? d.o.packageName, 3);
    const scoped = nodes.length ? messageNodes(nodes, anchor) : undefined;
    if (!scoped) return { check: k, pass: null, detail: `no message containing "${anchor}" on screen`, drift: `no message containing "${anchor}" on screen (not sent / not shown)`, tier: '①', ms: Date.now() - t0 };
    const hit = scoped.find((n) => matches(n, m));
    const all = [...new Set(scoped.map((n) => n.text || n.desc).filter(Boolean))].join(' | ').slice(0, 160);
    return { check: k, pass: wantPass(k, !!hit), detail: `newest message with "${anchor}": ${describeMatch(m)} ${hit ? 'present' : 'absent'} — nodes: ${all} (accessibility)`, tier: '①', ms: Date.now() - t0 };
  }
  if (d instanceof AndroidDriver) {
    const nodes = await dumpTree(d.o.udid, pkg ?? d.o.packageName, 3);
    if (nodes.length) {
      const scoped = scopeNodes(nodes, k, targets, viewportWidth);
      const hit = scoped.find((n) => matches(n, m));
      // The phone browser's accessibility tree is only built on page load: an empty scope there is not an answer.
      if (hit || d.surface === 'android-app' || scoped.length)
        return { check: k, pass: wantPass(k, !!hit), detail: `${describeMatch(m)} ${hit ? `on screen: "${(hit.text || hit.desc).slice(0, 80)}"` : `not on screen (${scoped.length} nodes in scope)`} (accessibility)`, tier: '①', ms: Date.now() - t0 };
    }
  } else if (d instanceof WebDriver && d.page && (k.scope ?? 'screen') === 'screen') {
    const found = await pageHasText(d.page, m);
    if (found !== null) return { check: k, pass: wantPass(k, found), detail: `${describeMatch(m)} ${found ? 'on the page' : 'not on the page'} (page text)`, tier: '①', ms: Date.now() - t0 };
  }
  const v = await visionAsk(d as any, `The screen shows ${describeMatch(m)}${k.scope && k.scope !== 'screen' ? ` (${typeof k.scope === 'string' ? 'in a quote block above a reply' : 'near the chosen message'})` : ''}. ${k.expect}`, 'checkpoint');
  if (v === null) return { check: k, pass: null, detail: 'text not readable and vision unavailable — 未验证', ms: Date.now() - t0 };
  return { check: k, pass: wantPass(k, v), detail: `vision: ${describeMatch(m)} ${v ? 'shown' : 'not shown'}`, vision: true, tier: '③', ms: Date.now() - t0 };
}

/** Read-only: does the visible page text contain the match? (Playwright locator text; nothing evaluated in the page.) */
export async function pageHasText(page: Page, m: TextMatch, area?: { minX?: number; maxY?: number; minY?: number }): Promise<boolean | null> {
  try {
    const loc = ('exact' in m ? page.getByText(m.exact, { exact: true }) : 'contains' in m ? page.getByText(m.contains) : page.getByText(new RegExp(m.regex))).filter({ visible: true });
    if (!area) return (await loc.count()) > 0;
    // Only matches inside an area (e.g. the chat pane, not the conversation list's preview line).
    for (const el of await loc.all()) {
      const b = await el.boundingBox().catch(() => null);
      if (b && b.x >= (area.minX ?? 0) && b.y >= (area.minY ?? -1e9) && b.y <= (area.maxY ?? 1e9)) return true;
    }
    return false;
  } catch {
    return null;
  }
}

/** ① What the message input contains (Android: the EditText's text; Playwright: the contenteditable's
 *  text, read-only). null = not readable. */
export async function composerText(d: Driver): Promise<string | null> {
  if (d instanceof AndroidDriver) {
    const nodes = await dumpTree(d.o.udid, d.o.packageName, 2);
    const e = nodes.filter((n) => /EditText/.test(n.cls)).sort((a, b) => b.y1 - a.y1)[0];
    return e ? (e.text === e.hint ? '' : e.text) : null;
  }
  if (d instanceof WebDriver && d.page) {
    try {
      return (await d.page.locator('[contenteditable="true"]').filter({ visible: true }).last().innerText({ timeout: 1000 })).trim();
    } catch {
      return null;
    }
  }
  return null;
}
