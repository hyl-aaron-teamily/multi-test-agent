// Observation library (W2-1 §4.1): every check is decided by the first channel that gives a definite
// answer — ① deterministic (log / process / system state / accessibility or page text / region) → ② ranker
// slot (empty) → ③ vision. Only at round-end checkpoints, preparation and warm-up — never per step.
// Each decision records its tier and time (report: 判定分层统计).
import type { Page } from 'playwright';
import { dumpTree, keyboardShown, matches, type TextMatch, type UiNode } from '../core/ui-tree';
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

/** Pure: Android nodes in a text check's scope. */
export function scopeNodes(nodes: UiNode[], k: CheckPoint, targets: Record<string, Point>, viewportWidth: number): UiNode[] {
  const s = k.scope ?? 'screen';
  if (s === 'screen') return nodes;
  if (s === 'quote-cards') return nodes.filter((n) => n.clickable && /^[^,]{1,60}, .+/.test(n.desc) && n.x1 > viewportWidth * 0.2);
  const p = targets[s.target];
  if (!p) return [];
  return nodes.filter((n) => Math.abs((n.y1 + n.y2) / 2 - p.y) <= (s.within ?? 250));
}

/** Text on screen: ① accessibility tree (Android) / page text (Playwright, read-only) → ③ vision. */
export async function observeText(d: Driver, k: CheckPoint, targets: Record<string, Point>, viewportWidth: number, pkg?: string): Promise<Observed> {
  const t0 = Date.now();
  const m = k.match;
  if (!m) return { check: k, pass: null, detail: 'text check without match' };
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
export async function pageHasText(page: Page, m: TextMatch): Promise<boolean | null> {
  try {
    const loc = 'exact' in m ? page.getByText(m.exact, { exact: true }) : 'contains' in m ? page.getByText(m.contains) : page.getByText(new RegExp(m.regex));
    return (await loc.filter({ visible: true }).count()) > 0;
  } catch {
    return null;
  }
}
