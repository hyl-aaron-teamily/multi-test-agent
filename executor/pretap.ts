// Pre-tap check (W2-4 §4.3 K2), outside the action loop only: before a tap on a point decided earlier
// (located, frozen, healed), check that the target is still there.
//   tree  — weighted match of the remembered fingerprint (resource-id 0.5, text 0.4, box 0.3, position 0.3)
//           against a fresh snapshot: small drift → tap the new centre (corrected); else shifted / covered / gone
//   pixel — no fingerprint (vision-located targets, icons): the decision-time frame vs now around the point;
//           nearly equal → pass, else the vision model compares both frames (answer + confidence only);
//           vision unavailable → uncertain (tapped, recorded)
// Blocked taps raise PreTapBlocked (an "execution event"); the caller re-locates or fails. After Artemis'
// Safety Net (ref/artemis, Apache-2.0), rewritten in TypeScript.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng, drawBox, encodePng, pixelDiff, type Rgba } from '../core/image';
import { visionConfigured, visionJson } from '../core/model/llm';
import { clickableOf, hitTest, label, related, similarity, type Box, type ScreenNode } from '../core/screen-index';
import type { Driver, Point } from '../drivers/types';
import type { RecordingDriver } from '../incident/recording-driver';
import { snapshot } from './snapshot';

export interface TapRef {
  purpose: string;
  /** Label of the node the decision was made on (text or content-desc). */
  text?: string;
  rid?: string;
  /** Box of the tappable container at decision time. */
  box?: Box;
  /** Decision-time screenshot (pixel fallback when there is no fingerprint). */
  png?: Buffer;
  /** Checked on the next tap only (first tap after a self-heal). */
  once?: boolean;
}

export type PreTapKind = 'pass' | 'corrected' | 'shifted' | 'covered' | 'gone' | 'uncertain';

export interface PreTapResult {
  kind: PreTapKind;
  how: 'tree' | 'pixel' | 'vision' | 'none';
  /** Point to tap (the corrected one when kind = corrected). */
  point: Point;
  score?: number;
  detail: string;
}

export const W = { rid: 0.5, text: 0.4, box: 0.3, pos: 0.3 };
export const DRIFT_PX = 120;
export const MATCH_MIN = 0.6;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const boxSim = (a: Box, b: Box) => (Math.min(a[2], b[2]) / Math.max(a[2], b[2], 1)) * (Math.min(a[3], b[3]) / Math.max(a[3], b[3], 1));

/** Pure: tree verdict; undefined when the fingerprint has nothing to compare (no text, no resource-id). */
export function treeVerdict(ref: TapRef, point: Point, nodes: ScreenNode[], driftPx = DRIFT_PX): PreTapResult | undefined {
  if (!ref.text && !ref.rid) return undefined;
  let best: { n: ScreenNode; box: ScreenNode; score: number } | undefined;
  for (const n of nodes) {
    const ts = ref.text ? Math.max(similarity(n.text, ref.text), similarity(n.desc, ref.text)) : 0;
    const rs = ref.rid && n.rid === ref.rid ? 1 : 0;
    // A fingerprint with text needs the text: rows of one list share a resource-id.
    if (ref.text ? ts < 0.75 : !rs) continue;
    const box = clickableOf(nodes, n);
    let num = 0;
    let den = 0;
    const add = (w: number, s: number) => ((num += w * s), (den += w));
    if (ref.rid) add(W.rid, rs);
    if (ref.text) add(W.text, ts);
    if (ref.box) add(W.box, boxSim(ref.box, box.box));
    add(W.pos, Math.max(0, 1 - dist(box.center, point) / (4 * driftPx)));
    const score = num / den;
    if (!best || score > best.score) best = { n, box, score };
  }
  if (!best || best.score < MATCH_MIN) return { kind: 'gone', how: 'tree', point, score: best?.score ?? 0, detail: `"${ref.text ?? ref.rid}" not on screen${best ? ` (best ${best.score.toFixed(2)})` : ''}` };
  const d = dist(best.box.center, point);
  const name = `"${label(best.n).slice(0, 40) || best.n.rid}"`;
  if (d > driftPx) return { kind: 'shifted', how: 'tree', point, score: best.score, detail: `${name} moved ${Math.round(d)} px (> ${driftPx}) to (${best.box.center.x},${best.box.center.y})` };
  const at = d <= 8 ? point : best.box.center;
  const hit = hitTest(nodes, at.x, at.y);
  if (hit && !related(hit, best.box))
    return { kind: 'covered', how: 'tree', point, score: best.score, detail: `${name} is under "${label(hit).slice(0, 40) || hit.cls}" at (${at.x},${at.y})` };
  if (d <= 8) return { kind: 'pass', how: 'tree', point, score: best.score, detail: `${name} still at the point (${best.score.toFixed(2)})` };
  return { kind: 'corrected', how: 'tree', point: at, score: best.score, detail: `${name} drifted ${Math.round(d)} px: (${point.x},${point.y}) → (${at.x},${at.y})` };
}

/** Pure: fraction of changed pixels in a square around the point (same-size frames). */
export function pixelChange(a: Rgba, b: Rgba, p: Point, r = 80): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const box: Box = [Math.max(0, p.x - r), Math.max(0, p.y - r), Math.min(2 * r, a.width - Math.max(0, p.x - r)), Math.min(2 * r, a.height - Math.max(0, p.y - r))];
  return pixelDiff(a, b, box) / Math.max(1, box[2] * box[3]);
}

const mark = (img: Rgba, p: Point) => {
  const c = { ...img, data: Buffer.from(img.data) } as Rgba;
  for (const r of [18, 20, 22]) drawBox(c, [p.x - r, p.y - r, 2 * r, 2 * r], [255, 0, 0]);
  return encodePng(c);
};

export interface PreTapEvent extends PreTapResult {
  at: string;
  phase: string;
  purpose: string;
  from: Point;
  frames?: string[];
}

export class PreTapGuard {
  /** On during preparation, re-entry, heal and calibration; off during the loop. */
  enabled = false;
  phase = '';
  readonly refs = new Map<string, TapRef>();
  readonly events: PreTapEvent[] = [];
  readonly tally = { checked: 0, pass: 0, corrected: 0, blocked: 0, uncertain: 0, vision: 0, byPhase: {} as Record<string, number> };

  constructor(
    readonly driver: Driver,
    readonly o: { dir?: string; driftPx?: number; log?: (s: string) => void } = {},
  ) {}

  /** The phone browser's accessibility tree is built on page load only (stale after in-page navigation):
   *  there the check is pixel-only, against a frame taken now. */
  get pixelOnly(): boolean {
    return this.driver.surface === 'android-web';
  }

  async remember(p: Point, ref: TapRef): Promise<void> {
    if (this.pixelOnly && !ref.png) ref = { ...ref, png: await this.driver.screenshot().catch(() => undefined) };
    this.refs.set(`${p.x},${p.y}`, ref);
  }

  /** Run `fn` with the guard on, labelled `phase`. */
  async during<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const was = [this.enabled, this.phase] as const;
    this.enabled = true;
    this.phase = phase;
    try {
      return await fn();
    } finally {
      [this.enabled, this.phase] = was;
    }
  }

  /** Install on the session's recording driver. */
  attach(d: RecordingDriver): this {
    d.beforeTap = (p) => this.beforeTap(p);
    return this;
  }

  /** The point to tap; throws PreTapBlocked when the target is not there. Unknown points pass unchecked. */
  async beforeTap(p: Point): Promise<Point> {
    if (!this.enabled) return p;
    const key = `${p.x},${p.y}`;
    const ref = this.refs.get(key);
    if (!ref) return p;
    if (ref.once) this.refs.delete(key);
    const r = await this.check(p, ref).catch((e): PreTapResult => ({ kind: 'uncertain', how: 'none', point: p, detail: `check failed: ${(e as Error).message.split('\n')[0].slice(0, 120)}` }));
    this.tally.checked++;
    this.tally.byPhase[this.phase] = (this.tally.byPhase[this.phase] ?? 0) + 1;
    const ev: PreTapEvent = { ...r, at: new Date().toISOString(), phase: this.phase, purpose: ref.purpose, from: p };
    if (r.kind === 'pass') this.tally.pass++;
    else if (r.kind === 'corrected') this.tally.corrected++;
    else if (r.kind === 'uncertain') this.tally.uncertain++;
    else this.tally.blocked++;
    this.events.push(ev);
    this.o.log?.(`pre-tap [${this.phase}] ${ref.purpose}: ${r.kind} (${r.how}) — ${r.detail}`);
    if (r.kind === 'corrected') {
      this.refs.delete(key);
      this.refs.set(`${r.point.x},${r.point.y}`, ref);
    }
    if (r.kind === 'shifted' || r.kind === 'covered' || r.kind === 'gone') {
      ev.frames = await this.saveFrames(ev, ref).catch(() => undefined);
      throw new PreTapBlocked(ev);
    }
    return r.point;
  }

  async check(p: Point, ref: TapRef): Promise<PreTapResult> {
    const snap = await snapshot(this.driver, { keepPng: !!ref.png || this.pixelOnly, stableMaxMs: 900 });
    this.lastPng = snap.png;
    const t = this.pixelOnly ? undefined : treeVerdict(ref, p, snap.nodes, this.o.driftPx);
    if (t) return t;
    if (!ref.png || !snap.png) return { kind: 'uncertain', how: 'none', point: p, detail: 'no fingerprint and no reference frame' };
    let a: Rgba;
    let b: Rgba;
    try {
      a = decodePng(ref.png);
      b = decodePng(snap.png);
    } catch {
      return { kind: 'uncertain', how: 'pixel', point: p, detail: 'frames not decodable' };
    }
    // Web taps are CSS px; the screenshot may be device px.
    const f = snap.width && b.width !== snap.width ? b.width / snap.width : 1;
    const pp = { x: Math.round(p.x * f), y: Math.round(p.y * f) };
    const ch = pixelChange(a, b, pp);
    if (ch < 0.05) return { kind: 'pass', how: 'pixel', point: p, score: 1 - ch, detail: `area around the point unchanged (${(ch * 100).toFixed(1)}% pixels differ)` };
    if (!visionConfigured()) return { kind: 'uncertain', how: 'pixel', point: p, score: 1 - ch, detail: `area changed (${(ch * 100).toFixed(1)}%), vision unavailable` };
    this.tally.vision++;
    const ans = (await visionJson(
      'You compare two phone/browser screenshots for a test robot about to tap the red-marked point. Reply ONE JSON object {"same": true|false, "state": "present"|"moved"|"covered"|"gone", "confidence": 0..1}.',
      [`Target: ${ref.purpose}. Image 1 = when the target was chosen; image 2 = now. Is the same target still under the red mark in image 2?`, { label: 'image 1 (decision time)', png: mark(a, pp) }, { label: 'image 2 (now)', png: mark(b, pp) }],
      60_000,
    )) as { same?: boolean; state?: string; confidence?: number } | undefined;
    if (!ans || typeof ans.same !== 'boolean') return { kind: 'uncertain', how: 'vision', point: p, detail: `area changed (${(ch * 100).toFixed(1)}%), vision gave no answer` };
    const conf = Number(ans.confidence ?? 0);
    if (ans.same) return { kind: conf >= 0.6 ? 'pass' : 'uncertain', how: 'vision', point: p, score: conf, detail: `vision: target still at the point (${conf.toFixed(2)})` };
    const kind: PreTapKind = ans.state === 'covered' ? 'covered' : ans.state === 'moved' ? 'shifted' : 'gone';
    return { kind, how: 'vision', point: p, score: conf, detail: `vision: target ${ans.state ?? 'gone'} (${conf.toFixed(2)})` };
  }

  private lastPng?: Buffer;

  private async saveFrames(ev: PreTapEvent, ref: TapRef): Promise<string[] | undefined> {
    if (!this.o.dir) return undefined;
    const dir = join(this.o.dir, 'pretap');
    await mkdir(dir, { recursive: true });
    const n = this.events.length;
    const out: string[] = [];
    const now = this.lastPng ?? (await this.driver.screenshot());
    for (const [name, png] of [['ref', ref.png], ['now', now]] as const) {
      if (!png) continue;
      const f = join(dir, `${n}-${name}.png`);
      await writeFile(f, mark(decodePng(png), ev.from));
      out.push(f);
    }
    return out;
  }

  /** Report section 「执行前校验」. */
  reportLines(): string[] {
    const t = this.tally;
    if (!t.checked) return [];
    const lines = [`- 校验 ${t.checked} 次：通过 ${t.pass}，修正 ${t.corrected}，拦截 ${t.blocked}，不确定 ${t.uncertain}；视觉调用 ${t.vision}`, `- 分阶段：${Object.entries(t.byPhase).map(([k, v]) => `${k} ${v}`).join('，')}`];
    for (const e of this.events.filter((x) => x.kind !== 'pass')) lines.push(`- [${e.phase}] ${e.purpose}：${e.kind}（${e.how}）${e.detail}${e.frames?.length ? `；截图 ${e.frames.map((f) => f.split(/[\\/]/).slice(-2).join('/')).join('、')}` : ''}`);
    return lines;
  }
}

/** An execution event: the pre-tap check stopped a tap. */
export class PreTapBlocked extends Error {
  constructor(readonly event: PreTapEvent) {
    super(`执行前校验拦截：${event.purpose} — ${event.kind}（${event.detail}）`);
    this.name = 'PreTapBlocked';
  }
}
