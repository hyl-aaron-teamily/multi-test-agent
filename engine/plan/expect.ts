// W3-1 executor checks around the loop's coordinate steps (§6): an action's post-condition (`expect`, read
// once right after it, ① only), the round's baseline (read before its first action), the frozen target's
// `must` (read once at preparation), and the evidence the revision step needs (expect / baseline failures,
// suspect signals with their logcat line, sampled low-resolution screenshots).
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng, downscale, encodePng } from '../../core/image';
import { dumpTree, type UiNode } from '../../core/ui-tree';
import { AndroidDriver } from '../../drivers/android';
import type { Point } from '../../drivers/types';
import type { CheckPoint, PlannedAction, TargetMust } from '../../platform/schema/test-plan';
import { bubbleAt } from '../observe';
import { observeCheck } from './checkpoint';
import type { RunCtx } from './context';
import { expand } from './template';

export interface ExpectRecord {
  round: number;
  /** Where in the plan: actions[2], afterCheck[0], baseline[1]. */
  at: string;
  role: 'phenomenon' | 'precondition' | 'baseline';
  pass: boolean | null;
  detail: string;
  ms?: number;
}

const MAX_RECORDS = 200;

function keep(c: RunCtx, r: ExpectRecord): void {
  const xs = (c.res.expectLog ??= []);
  if (xs.length < MAX_RECORDS) xs.push(r);
}

/** An action's post-condition, read now. Failures (and unreadable reads) are kept for the revision step. */
export async function readExpect(c: RunCtx, a: PlannedAction, at: string, round: number): Promise<ExpectRecord | undefined> {
  if (!a.expect) return undefined;
  const r = await observeCheck(c, a.expect.check).catch((e) => ({ check: a.expect!.check, pass: null, detail: `read failed: ${(e as Error).message.split('\n')[0]}` }) as const);
  const rec: ExpectRecord = { round, at, role: a.expect.role, pass: r ? r.pass : null, detail: r ? r.detail : `${a.expect.check.kind} cannot be read on ${c.plan.surface}`, ms: r && 'ms' in r ? r.ms : undefined };
  if (rec.pass !== true) keep(c, rec);
  return rec;
}

/** The round's baseline: the first check that does not hold (false or unreadable), else undefined. */
export async function readBaseline(c: RunCtx, round: number): Promise<ExpectRecord | undefined> {
  for (const [i, k] of c.plan.baseline.entries()) {
    const r = await observeCheck(c, k).catch(() => undefined);
    if (r?.pass === true) continue;
    const rec: ExpectRecord = { round, at: `baseline[${i}]`, role: 'baseline', pass: r ? r.pass : null, detail: r ? `${k.expect} — ${r.detail}` : `${k.kind} cannot be read on ${c.plan.surface}` };
    keep(c, rec);
    return rec;
  }
  return undefined;
}

const URL_ONLY = /^\s*https?:\/\/\S+\s*$/i;

/** Pure: does the message at `p` satisfy the target's `must` (SKILL §5.3)? Reads the bubble (smallest
 *  clickable container) on the accessibility tree: right half = self, left half = others; a node whose whole
 *  text is a URL = link; a large image node = image. `token` expands {token} in `contains`. */
export function checkMust(nodes: UiNode[], p: Point, must: TargetMust, viewportWidth: number, token: string): { ok: boolean; detail: string } {
  const b = bubbleAt(nodes, p);
  if (!b) return { ok: false, detail: 'nothing on the accessibility tree at the target point' };
  const { box, inner } = b;
  const texts = inner.map((n) => (n.text || n.desc).trim()).filter(Boolean);
  const why: string[] = [];
  if (must.sender && must.sender !== 'any') {
    // The clickable container may be the whole list row: take the bubble's own content (nodes narrower than
    // the row) and compare its gaps — own messages hug the right edge, others' sit after the avatar on the left.
    const parts = inner.filter((n) => n.x2 - n.x1 < viewportWidth * 0.95 && n.x2 > n.x1);
    const x1 = parts.length ? Math.min(...parts.map((n) => n.x1)) : box.x1;
    const x2 = parts.length ? Math.max(...parts.map((n) => n.x2)) : box.x2;
    const side = viewportWidth - x2 < x1 ? 'self' : 'others';
    if (side !== must.sender) why.push(`sender ${side} (bubble x ${Math.round(x1)}–${Math.round(x2)}), wanted ${must.sender}`);
  }
  if (must.content && must.content !== 'any') {
    const link = texts.some((t) => URL_ONLY.test(t));
    const image = inner.some((n) => /ImageView|Image$/.test(n.cls) && n.x2 - n.x1 > 200 && n.y2 - n.y1 > 200);
    const kind = image && !texts.length ? 'image' : link ? 'link' : texts.length ? 'text' : image ? 'image' : 'card';
    const ok = must.content === 'card' ? kind === 'card' || (link && texts.length > 1) : must.content === kind;
    if (!ok) why.push(`content ${kind}, wanted ${must.content}`);
  }
  if (must.contains) {
    const want = expand(must.contains, { token, round: 0 });
    if (!texts.some((t) => t.includes(want))) why.push(`does not contain "${want}"`);
  }
  const seen = texts.join(' | ').slice(0, 160);
  return why.length ? { ok: false, detail: `${why.join('; ')} — bubble: ${seen || '(no text)'}` } : { ok: true, detail: `must holds — bubble: ${seen}` };
}

/** Target `must` on the live screen (Android: accessibility tree). null = not verifiable on this surface. */
export async function verifyMust(c: RunCtx, id: string, p: Point): Promise<{ ok: boolean | null; detail: string }> {
  const t = c.plan.targets.find((x) => x.id === id);
  if (!t?.must) return { ok: true, detail: 'no must' };
  const inner = c.sess.inner;
  if (!(inner instanceof AndroidDriver)) return { ok: null, detail: `must not verifiable on ${c.plan.surface} (accessibility tree on Android only)` };
  const nodes = await dumpTree(inner.o.udid, inner.o.packageName, 3);
  return checkMust(nodes, p, t.must, c.sess.profile.viewport.width, c.res.runTag ?? '');
}

/** Every this many rounds a low-resolution screenshot is kept (revision material), at most MAX_SAMPLES. */
export const SAMPLE_EVERY = 10;
export const MAX_SAMPLES = 30;

/** Ring buffer of sampled screenshots (runDir/samples/round-NNN.png, 360 px wide). */
export async function sampleScreen(c: RunCtx, round: number): Promise<void> {
  const png = await c.sess.d.screenshot().catch(() => undefined);
  if (!png) return;
  const dir = join(c.o.runDir, 'samples');
  await mkdir(dir, { recursive: true });
  const f = join(dir, `round-${String(round).padStart(3, '0')}.png`);
  await writeFile(f, encodePng(downscale(decodePng(png), 360)));
  const xs = (c.res.samples ??= []);
  xs.push(f);
  while (xs.length > MAX_SAMPLES) await unlink(xs.shift()!).catch(() => {});
}

/** Pure: does a plan check anything at an action (its own expect) — for the plan view. */
export const expectLabel = (k: CheckPoint, role: string) => `${role === 'phenomenon' ? '现象' : '前置'}：${k.expect}`;
