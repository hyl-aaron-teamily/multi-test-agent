// Screen snapshot structure + index (W2-4 §4.2 K1). One normalised node list serves locate, the pre-tap
// check, checkpoints, calibration and `doctor --probe`. Pure: no device access here (capture lives in
// executor/snapshot.ts). Fuzzy matching after Artemis' screen index (ref/artemis, Apache-2.0), rewritten.
import type { UiNode } from './ui-tree';

export type Box = [number, number, number, number];

export interface ScreenNode {
  text: string;
  desc: string;
  /** resource-id (Android) / test id or role (web). */
  rid: string;
  cls: string;
  clickable: boolean;
  box: Box;
  center: { x: number; y: number };
  /** Android: document id and ancestor ids (core/ui-tree.ts). */
  id?: number;
  anc?: number[];
}

export interface ScreenSnapshot {
  at: string;
  surface: string;
  /** Where the nodes came from: uiautomator / a11y-service / playwright. */
  source: string;
  /** Set when the preferred tree backend failed and this snapshot fell back. */
  fallback?: string;
  ms: { stable: number; tree: number; shot: number; total: number };
  width: number;
  height: number;
  nodes: ScreenNode[];
  png?: Buffer;
}

export const label = (n: Pick<ScreenNode, 'text' | 'desc'>) => (n.text || n.desc).trim();
const area = (b: Box) => b[2] * b[3];

/** Pure: uiautomator nodes → screen nodes; zero-area and unlabelled non-interactive containers dropped. */
export function normalizeNodes(nodes: UiNode[]): ScreenNode[] {
  const out: ScreenNode[] = [];
  for (const n of nodes) {
    const box: Box = [n.x1, n.y1, n.x2 - n.x1, n.y2 - n.y1];
    if (box[2] <= 0 || box[3] <= 0) continue;
    const text = n.text === n.hint && /EditText/.test(n.cls) ? '' : n.text;
    if (!text && !n.desc && !n.rid && !n.clickable && !/EditText/.test(n.cls)) continue;
    out.push({ text, desc: n.desc, rid: n.rid ?? '', cls: n.cls, clickable: n.clickable, box, center: { x: Math.round(n.x1 + box[2] / 2), y: Math.round(n.y1 + box[3] / 2) }, ...(n.id !== undefined ? { id: n.id, anc: n.anc } : {}) });
  }
  return out;
}

/** Pure: comparison form of a label (case, spaces and punctuation ignored). */
export const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/** Pure: Levenshtein distance (code points). */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

/** Pure: 0..1 similarity of two labels; a whole-word containment scores by length ratio, floor 0.8. */
export function similarity(a: string, b: string): number {
  const p = norm(a);
  const q = norm(b);
  if (!p || !q) return 0;
  if (p === q) return 1;
  const [s, l] = p.length <= q.length ? [p, q] : [q, p];
  const lev = 1 - editDistance(p, q) / Math.max(p.length, q.length);
  return l.includes(s) ? Math.max(lev, 0.8 + 0.2 * (s.length / l.length)) : lev;
}

export interface Hit {
  node: ScreenNode;
  how: 'exact' | 'contains' | 'fuzzy';
  score: number;
}

/** Pure: best match for a query — exact → substring → fuzzy (≥ threshold). Ties: larger score, then smaller box. */
export function search(nodes: ScreenNode[], q: string, threshold = 0.75): Hit | undefined {
  const t = q.trim();
  if (!t) return undefined;
  const small = (a: ScreenNode, b: ScreenNode) => area(a.box) - area(b.box);
  const ex = nodes.filter((n) => n.text.trim() === t || n.desc.trim() === t).sort(small)[0];
  if (ex) return { node: ex, how: 'exact', score: 1 };
  const ct = nodes.filter((n) => n.text.includes(t) || n.desc.includes(t)).sort(small)[0];
  if (ct) return { node: ct, how: 'contains', score: 0.95 };
  let best: Hit | undefined;
  for (const n of nodes) {
    const s = Math.max(similarity(n.text, t), similarity(n.desc, t));
    if (s >= threshold && (!best || s > best.score || (s === best.score && small(n, best.node) < 0))) best = { node: n, how: 'fuzzy', score: s };
  }
  return best;
}

/** Pure: is one node inside the other in the hierarchy (box containment when there is no hierarchy)? */
export function related(a: ScreenNode, b: ScreenNode): boolean {
  if (a === b) return true;
  if (a.id !== undefined && b.id !== undefined) return !!a.anc?.includes(b.id) || !!b.anc?.includes(a.id);
  const inBox = (x: Box, y: Box) => x[0] >= y[0] && x[1] >= y[1] && x[0] + x[2] <= y[0] + y[2] && x[1] + x[3] <= y[1] + y[3];
  return inBox(a.box, b.box) || inBox(b.box, a.box);
}

const covers = (b: Box, x: number, y: number) => b[0] <= x && x <= b[0] + b[2] && b[1] <= y && y <= b[1] + b[3];

/** Pure: what a tap at (x, y) hits — the smallest interactive node covering it, else the smallest labelled one. */
export function hitTest(nodes: ScreenNode[], x: number, y: number): ScreenNode | undefined {
  const under = nodes.filter((n) => covers(n.box, x, y)).sort((a, b) => area(a.box) - area(b.box));
  return under.find((n) => n.clickable || /EditText|textbox|button|link/i.test(n.cls)) ?? under.find((n) => label(n));
}

/** Pure: the smallest clickable node containing `n` (the row / button a label belongs to). */
export function clickableOf(nodes: ScreenNode[], n: ScreenNode): ScreenNode {
  const inside = (o: ScreenNode) => n.box[0] >= o.box[0] && n.box[1] >= o.box[1] && n.box[0] + n.box[2] <= o.box[0] + o.box[2] && n.box[1] + n.box[3] <= o.box[1] + o.box[3];
  return nodes.filter((o) => o.clickable && inside(o)).sort((a, b) => area(a.box) - area(b.box))[0] ?? n;
}
