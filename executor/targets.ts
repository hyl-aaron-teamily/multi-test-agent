// Preparation stage: dynamic targets (which group / which conversation / which message) are decided
// here — never hard-coded — then frozen to coordinates for the deterministic loop.
//   1. candidates: visible conversation rows (title text + box) read once from the screen's accessibility
//      layer (web: rendered rows, android: uiautomator), or located by the vision model for non-row targets
//   2. decision: the model picks per SKILL guidance (TARGET_GUIDANCE); rules only if no model
//   3. freeze: the chosen row centre becomes the target point; the choice + reason go to the run record
import { adb } from '../core/adb';
import type { AndroidDriver } from '../drivers/android';
import type { Driver, Point } from '../drivers/types';
import type { WebDriver } from '../drivers/web';
import { parseNodes } from '../imui/clients/android';
import { chatJson, modelCalls, modelConfigured } from '../issue/llm';
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
    await adb(['shell', 'uiautomator', 'dump', '/sdcard/autotest_ui.xml'], d.o.udid);
    const nodes = parseNodes(await adb(['exec-out', 'cat', '/sdcard/autotest_ui.xml'], d.o.udid), d.o.packageName);
    const rows = nodes.filter((n) => n.clickable && n.x2 - n.x1 > p.viewport.width * 0.8 && n.y2 - n.y1 > 150 && n.y2 - n.y1 < 400 && n.y1 > 300 && n.y2 < p.viewport.height - 260);
    return rows
      .map((r) => {
        const inner = nodes.filter((n) => !n.clickable && n.text && n.x1 >= r.x1 && n.x2 <= r.x2 && n.y1 >= r.y1 && n.y2 <= r.y2);
        return { title: inner[0]?.text ?? '', preview: inner.slice(1).map((n) => n.text).join(' | '), box: [r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1] as Candidate['box'] };
      })
      .filter((c) => c.title);
  }
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

export const isRowTarget = (kind: string) => ROW_KINDS.has(kind);

/**
 * phase 'rows'   : conversation targets, on the home list (before setup)
 * phase 'inside' : on-screen things inside the opened conversation (after setup), located by vision;
 *                  a 'like-action' target is located after long-pressing the message target found before it.
 */
export async function pickTargets(plan: TestPlan, driver: Driver, p: Profile, log: (s: string) => void, locate?: (q: string) => Promise<Point | null>, phase: 'rows' | 'inside' = 'rows', frozen: FrozenTarget[] = []): Promise<FrozenTarget[]> {
  const out: FrozenTarget[] = [];
  const wanted = plan.targets.filter((t) => (phase === 'rows') === ROW_KINDS.has(t.kind));
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
      if (idx < 0) throw new Error(`prep: no candidate for target ${t.id} (${t.kind})`);
      taken.push(idx);
      const c = cands[idx];
      out.push({ id: t.id, kind: t.kind, point: { x: Math.round(c.box[0] + c.box[2] / 2), y: Math.round(c.box[1] + c.box[3] / 2) }, chosen: c.title, reason, by });
    } else {
      const msg = t.kind === 'like-action' ? [...frozen, ...out].find((x) => x.kind === 'others-text-message') : undefined;
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

/** Midscene vision locate (preparation only), counted as a vision call. */
export async function visionLocator(driver: Driver & { page?: unknown; o?: any }): Promise<((q: string) => Promise<Point | null>) | undefined> {
  if (process.env.ISSUE_NO_VISION === '1' || !process.env.MIDSCENE_MODEL_API_KEY) return undefined;
  return async (q) => {
    try {
      modelCalls.vision++;
      let agent: any;
      if (driver.surface === 'android-app') {
        const { AndroidAgent, AndroidDevice } = await import('@midscene/android');
        const dev = new AndroidDevice(driver.o.udid);
        await dev.connect();
        agent = new AndroidAgent(dev, { generateReport: false } as any);
      } else {
        const { PlaywrightAgent } = await import('@midscene/web/playwright');
        agent = new PlaywrightAgent(driver.page as any, { generateReport: false } as any);
      }
      const r = await agent.aiLocate(q);
      return r?.center ? { x: r.center[0], y: r.center[1] } : null;
    } catch (err) {
      console.warn(`[vision] locate failed: ${(err as Error).message.split('\n')[0]}`);
      return null;
    }
  };
}
