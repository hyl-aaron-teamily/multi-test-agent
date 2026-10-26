// Preparation stage: dynamic targets (which group / which conversation / which message) are decided
// here — never hard-coded — then frozen to coordinates for the deterministic loop.
//   1. candidates: visible conversation rows (title text + box) read once from the screen's accessibility
//      layer (web: rendered rows, android: uiautomator), or located by the vision model for non-row targets
//   2. decision: the model picks per SKILL guidance (TARGET_GUIDANCE); rules only if no model
//   3. freeze: the chosen row centre becomes the target point; the choice + reason go to the run record
import { literalsOf, locate } from './locate';
import type { AndroidDriver } from '../drivers/android';
import type { Driver, Point } from '../drivers/types';
import type { WebDriver } from '../drivers/web';
import { dumpTree } from '../core/ui-tree';
import { chatJson, modelConfigured } from '../core/model/llm';
import type { TestPlan } from '../platform/schema/test-plan';
import type { Profile } from '../skills/profile';

export interface Candidate {
  title: string;
  preview: string;
  box: [number, number, number, number];
}

export interface FrozenTarget {
  id: string;
  kind: string;
  point: Point;
  chosen: string;
  reason: string;
  by: 'model' | 'rules' | 'vision';
}

const ROW_KINDS = new Set(['group-conversation', 'other-conversation', 'muted-group', 'conversation']);

export async function conversationCandidates(driver: Driver, p: Profile): Promise<Candidate[]> {
  if (driver.surface === 'android-app') {
    const d = driver as AndroidDriver;
    const nodes = await dumpTree(d.o.udid, d.o.packageName);
    const rows = nodes.filter((n) => n.clickable && n.x2 - n.x1 > p.viewport.width * 0.8 && n.y2 - n.y1 > 150 && n.y2 - n.y1 < 400 && n.y1 > 300 && n.y2 < p.viewport.height - 260);
    return rows
      .map((r) => {
        const inner = nodes.filter((n) => !n.clickable && n.text && n.x1 >= r.x1 && n.x2 <= r.x2 && n.y1 >= r.y1 && n.y2 <= r.y2);
        return { title: inner[0]?.text ?? '', preview: inner.slice(1).map((n) => n.text).join(' | '), box: [r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1] as Candidate['box'] };
      })
      .filter((c) => c.title);
  }
  if (driver.surface === 'android-web') return browserRows(driver as AndroidDriver, p);
  const page = (driver as WebDriver).p;
  const listX = driver.surface === 'mobile-web' ? [0, p.viewport.width] : [70, 420];
  const out: Candidate[] = [];
  for (const l of await page.locator('div[role=button], a, div.cursor-pointer').filter({ visible: true }).all()) {
    const b = await l.boundingBox().catch(() => null);
    if (!b || b.x < listX[0] || b.x + b.width > listX[1] || b.height < 56 || b.height > 96 || b.y < 0 || b.y + b.height > p.viewport.height - 80) continue;
    const lines = (await l.innerText().catch(() => '')).split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length || out.some((o) => Math.abs(o.box[1] - b.y) < 10)) continue;
    // Muted rows carry an icon only; its accessible name is the only text cue.
    const muted = (await l.locator('[aria-label*="免打扰"], [aria-label*="mute" i], svg.lucide-bell-off').count().catch(() => 0)) > 0;
    out.push({ title: lines[0], preview: `${lines.slice(1).join(' | ')}${muted ? ' | [muted]' : ''}`, box: [b.x, b.y, b.width, b.height].map(Math.round) as Candidate['box'] });
  }
  return out;
}

/** android-web: conversation rows of the chat list from the phone's accessibility tree (the browser exposes
 *  web content): a title line with a time at the right end of the same row, the preview line under it.
 *  Rows under a floating card (free-trial banner) or the bottom bar are left out (a tap would hit those). */
export async function browserRows(d: AndroidDriver, p: Profile): Promise<Candidate[]> {
  const nodes = await dumpTree(d.o.udid, d.o.packageName);
  const web = nodes.find((n) => /WebView$/.test(n.cls) && n.y2 - n.y1 > 800);
  const w = p.viewport.width;
  const top = Math.max(web?.y1 ?? 0, ...nodes.filter((n) => /搜索/.test(n.hint) && /EditText/.test(n.cls) && n.y1 > (web?.y1 ?? 0)).map((n) => n.y2));
  const navTop = Math.min(...nodes.filter((n) => /^(\d+ )?(聊天|Chat)$/.test(n.desc) && n.y1 > (web?.y2 ?? p.viewport.height) - 320).map((n) => n.y1), web?.y2 ?? p.viewport.height);
  const card = nodes.filter((n) => /免费试用|free trial|查看我的任务/i.test(n.text));
  const cardTop = card.length ? Math.min(...card.map((n) => n.y1)) - 140 : navTop;
  const texts = nodes.filter((n) => /TextView/.test(n.cls) && n.text.trim() && n.y1 > top && n.y2 < Math.min(navTop, cardTop) && n.y2 > n.y1);
  const out: Candidate[] = [];
  for (const t of texts) {
    if (t.x1 < w * 0.15 || t.x1 > w * 0.35) continue;
    const time = texts.find((x) => x !== t && x.x1 > w * 0.75 && Math.abs(x.y1 - t.y1) < 40);
    if (!time) continue;
    const preview = texts.find((x) => x !== t && Math.abs(x.x1 - t.x1) < 30 && x.y1 >= t.y2 - 5 && x.y1 < t.y2 + 90);
    const y1 = t.y1 - 40;
    const y2 = (preview?.y2 ?? t.y2) + 40;
    out.push({ title: t.text.trim(), preview: preview?.text.trim() ?? '', box: [0, y1, w, y2 - y1] });
  }
  // Rows exposed as one button (the personal-AI row at the top): its whole text.
  for (const b of nodes.filter((n) => n.clickable && /Button/.test(n.cls) && n.text.length > 8 && n.x2 - n.x1 > w * 0.8 && n.y1 > top && n.y2 < Math.min(navTop, cardTop)))
    if (!out.some((o) => o.box[1] < b.y2 && o.box[1] + o.box[3] > b.y1)) out.push({ title: b.text.trim().slice(0, 60), preview: '', box: [b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1] });
  return out.sort((a, b) => a.box[1] - b.box[1]);
}

export interface QuoteCard {
  box: Candidate['box'];
  sender: string;
  quoted: string;
}

/** Quote cards on the Android chat screen (preparation-time accessibility read). */
export async function quoteCards(d: AndroidDriver, p: Profile): Promise<QuoteCard[]> {
  const nodes = await dumpTree(d.o.udid, d.o.packageName);
  return nodes
    .filter((n) => n.clickable && /^[^,]{1,60}, .+/.test(n.desc) && n.x1 > p.viewport.width * 0.2 && n.y1 > 300 && n.y2 < p.viewport.height - 300)
    .map((n) => ({ box: [n.x1, n.y1, n.x2 - n.x1, n.y2 - n.y1] as Candidate['box'], sender: n.desc.split(', ')[0], quoted: n.desc.slice(n.desc.indexOf(', ') + 2).trim() }))
    .sort((a, b) => a.box[1] - b.box[1]);
}

/** After a jump: is the quoted original shown as a message (text node outside any quote card)? */
export async function quotedOriginalVisible(d: AndroidDriver, quoted: string): Promise<[number, number, number, number] | undefined> {
  const nodes = await dumpTree(d.o.udid, d.o.packageName);
  const cards = nodes.filter((n) => n.clickable && /^[^,]{1,60}, .+/.test(n.desc));
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 30);
  const n = nodes.find((n) => n.text && norm(n.text) === norm(quoted) && !cards.some((c) => n.x1 >= c.x1 && n.x2 <= c.x2 && n.y1 >= c.y1 && n.y2 <= c.y2));
  return n ? [n.x1, n.y1, n.x2 - n.x1, n.y2 - n.y1] : undefined;
}

/** Pure fallback rules when no model is configured. */
export function ruleChoice(kind: string, cands: Candidate[], taken: number[]): number {
  const free = cands.map((c, i) => ({ c, i })).filter(({ i }) => !taken.includes(i));
  const isGroup = (c: Candidate) => /,|，/.test(c.title) || /room|群/i.test(c.title);
  const pick =
    kind === 'group-conversation' ? free.find(({ c }) => isGroup(c) && /,/.test(c.title)) ?? free.find(({ c }) => isGroup(c)) :
    kind === 'muted-group' ? free.find(({ c }) => /\[muted\]/.test(c.preview) && /@/.test(c.preview)) ?? free.find(({ c }) => /@/.test(c.preview) && isGroup(c)) :
    free.find(({ c }) => !/personal ai/i.test(c.title)) ?? free[0];
  return pick ? pick.i : -1;
}

/**
 * phase 'rows'   : conversation targets, on the home list (before setup)
 * phase 'inside' : on-screen things inside the opened conversation (after setup), located by vision;
 *                  a 'like-action' target is located after long-pressing the message target found before it.
 */
export async function pickTargets(plan: TestPlan, driver: Driver, p: Profile, log: (s: string) => void, locate?: (q: string) => Promise<Point | null>, phase: 'rows' | 'inside' | 'after-prepare' = 'rows', frozen: FrozenTarget[] = []): Promise<FrozenTarget[]> {
  const out: FrozenTarget[] = [];
  const wanted = plan.targets.filter((t) => (phase === 'rows' ? ROW_KINDS.has(t.kind) : !ROW_KINDS.has(t.kind) && (phase === 'after-prepare') === !!t.afterPrepare));
  if (!wanted.length) return out;
  const rowsNeeded = phase === 'rows';
  let cands: Candidate[] = [];
  // The list renders progressively: wait until it stops growing (max ~20 s).
  for (let i = 0; rowsNeeded && i < 8; i++) {
    const c = await conversationCandidates(driver, p);
    if (c.length >= 3 && c.length === cands.length) break;
    cands = c;
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (rowsNeeded) log(`prep: ${cands.length} conversation candidates on screen`);
  const taken: number[] = [];
  for (const t of wanted) {
    if (ROW_KINDS.has(t.kind)) {
      let idx = -1;
      let reason = '';
      let by: FrozenTarget['by'] = 'rules';
      if (modelConfigured() && cands.length) {
        const ans = (await chatJson(
          'You choose a test target in a chat app for a black-box test robot. Reply ONE JSON object {"index": <number>, "reason": "<one Chinese sentence>"}.',
          `Target "${t.id}" (${t.kind}). Guidance: ${t.guidance}\nAlready used indexes (do not reuse): ${JSON.stringify(taken)}\nVisible conversation rows:\n${cands.map((c, i) => `${i}. ${c.title} — ${c.preview}`).join('\n')}`,
        )) as { index?: number; reason?: string } | undefined;
        if (ans && Number.isInteger(ans.index) && ans.index! >= 0 && ans.index! < cands.length && !taken.includes(ans.index!)) {
          idx = ans.index!;
          reason = String(ans.reason ?? '');
          by = 'model';
        }
      }
      if (idx < 0) {
        idx = ruleChoice(t.kind, cands, taken);
        reason = 'rule fallback (model unavailable or answer invalid)';
      }
      if (idx < 0) {
        // No readable rows (the phone browser's accessibility tree can lag behind the page): let the vision
        // model find the row on the screenshot instead (preparation only).
        const pt = !cands.length && locate ? await locate(`the conversation row in the chat list that matches: ${t.guidance}`) : null;
        if (!pt) throw new Error(`prep: no candidate for target ${t.id} (${t.kind})`);
        const chosen = t.guidance.match(/titled "([^"]+)"/)?.[1] ?? t.guidance;
        out.push({ id: t.id, kind: t.kind, point: pt, chosen, reason: 'vision locate (no readable rows)', by: 'vision' });
        log(`prep: target ${t.id} → "${chosen.slice(0, 60)}" @ ${JSON.stringify(pt)} (vision: no readable rows)`);
        continue;
      }
      taken.push(idx);
      const c = cands[idx];
      out.push({ id: t.id, kind: t.kind, point: { x: Math.round(c.box[0] + c.box[2] / 2), y: Math.round(c.box[1] + c.box[3] / 2) }, chosen: c.title, reason, by });
    } else if (t.kind === 'quote-card' && driver.surface === 'android-app') {
      // Quote cards are clickable groups labelled "<sender>, <quoted text>"; take the bottom-most one.
      let q = (await quoteCards(driver as AndroidDriver, p)).at(-1);
      // The chat may reopen scrolled up: swipe toward the newest messages a few times (user action).
      for (let k = 0; !q && k < 4; k++) {
        await driver.swipe({ x: p.viewport.width / 2, y: p.viewport.height * 0.7 }, { x: p.viewport.width / 2, y: p.viewport.height * 0.3 }, 250);
        await new Promise((r) => setTimeout(r, 1200));
        q = (await quoteCards(driver as AndroidDriver, p)).at(-1);
      }
      if (!q) throw new Error('prep: 前置条件不存在 — no quote card (reply with a quote) visible in this conversation');
      out.push({ id: t.id, kind: t.kind, point: { x: Math.round(q.box[0] + q.box[2] / 2), y: Math.round(q.box[1] + q.box[3] / 2) }, chosen: `quote of "${q.quoted.slice(0, 40)}"`, reason: 'bottom-most quote card on screen', by: 'rules' });
    } else {
      const msg = t.kind === 'like-action' || t.kind === 'reply-action' ? [...frozen, ...out].find((x) => x.kind === 'others-text-message') : undefined;
      if (msg) {
        await driver.longPress(msg.point);
        await new Promise((r) => setTimeout(r, 1200));
      }
      const pt = locate ? await locate(`${t.guidance}`) : null;
      if (msg) {
        await driver.back();
        await new Promise((r) => setTimeout(r, 800));
      }
      if (!pt) throw new Error(`prep: target ${t.id} (${t.kind}) needs vision localisation, which is unavailable`);
      out.push({ id: t.id, kind: t.kind, point: pt, chosen: t.guidance, reason: 'vision locate', by: 'vision' });
    }
    log(`prep: target ${t.id} → "${out.at(-1)!.chosen}" @ ${JSON.stringify(out.at(-1)!.point)} (${out.at(-1)!.by}: ${out.at(-1)!.reason})`);
  }
  return out;
}

/** Preparation-time locator: tier ① literal texts quoted in the description, then ③ vision (executor/locate). */
export async function visionLocator(driver: Driver & { page?: unknown; o?: any }): Promise<((q: string) => Promise<Point | null>) | undefined> {
  return async (q) => (await locate(driver, q, { texts: literalsOf(q), purpose: 'prep' }))?.point ?? null;
}
