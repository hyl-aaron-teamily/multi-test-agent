// Android accessibility tree: the one place that reads it, through the device's tree backend
// (core/tree-backend.ts: uiautomator ≈ 2.6–3.7 s on the test phone, or the on-device service). Retried while
// the UI is not idle and timed — never used inside the action loop.
import { adb } from './adb';
import { readTree, type TreeRead } from './tree-backend';

export interface UiNode {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  text: string;
  /** Placeholder; an empty EditText reports its hint as `text`. */
  hint: string;
  desc: string;
  cls: string;
  clickable: boolean;
  /** resource-id (often empty in React Native apps). */
  rid?: string;
  /** Document order of the node in the dump, and its ancestors' (hierarchy for hit tests). */
  id?: number;
  anc?: number[];
}

export type UiBox = [number, number, number, number];

// uiautomator quotes a value with ' when it contains a " (e.g. a rewritten draft that quotes the original).
const attr = (n: string, k: string) => {
  const m = n.match(new RegExp(`\\s${k}=(?:"([^"]*)"|'([^']*)')`));
  return m ? (m[1] ?? m[2] ?? '') : '';
};
// uiautomator writes emoji as numeric character references (&#128077; = 👍).
const unescape = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

/** Pure: uiautomator XML → nodes of `pkg` (all packages when pkg is empty). */
export function parseNodes(xml: string, pkg: string): UiNode[] {
  const out: UiNode[] = [];
  const stack: number[] = [];
  let id = -1;
  for (const m of xml.matchAll(/<node\b[^>]*>|<\/node>/g)) {
    const n = m[0];
    if (n === '</node>') {
      stack.pop();
      continue;
    }
    id++;
    const anc = [...stack];
    if (!n.endsWith('/>')) stack.push(id);
    if (pkg && attr(n, 'package') !== pkg) continue;
    const b = attr(n, 'bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    out.push({ x1, y1, x2, y2, text: unescape(attr(n, 'text')), hint: unescape(attr(n, 'hint')), desc: unescape(attr(n, 'content-desc')), cls: attr(n, 'class'), clickable: attr(n, 'clickable') === 'true', ...(attr(n, 'resource-id') ? { rid: attr(n, 'resource-id') } : {}), id, anc });
  }
  return out;
}

/** Recent dump durations (ms), for reports. */
export const dumpTimings: number[] = [];

/** Raw XML of one read through the device's tree backend (core/tree-backend.ts). */
export async function readUiXml(udid?: string, timeoutMs = 20_000): Promise<TreeRead> {
  const r = await readTree(udid, timeoutMs);
  dumpTimings.push(r.t1 - r.t0);
  if (dumpTimings.length > 200) dumpTimings.shift();
  return r;
}

/** Nodes of `pkg`, retried while the UI animates ("could not get idle state"). Empty on failure. */
export async function dumpTree(udid: string | undefined, pkg: string, tries = 4): Promise<UiNode[]> {
  for (let i = 0; i < tries; i++) {
    try {
      const nodes = parseNodes((await readUiXml(udid)).xml, pkg);
      if (nodes.length) return nodes;
    } catch {
      /* UI not idle yet */
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 700));
  }
  return [];
}

/** Soft keyboard shown (system state, `dumpsys input_method`; ≈ 150 ms). */
export async function keyboardShown(udid?: string): Promise<boolean | null> {
  const out = await adb(['shell', 'dumpsys input_method | grep -m1 mInputShown'], udid).catch(() => '');
  if (!/mInputShown=/.test(out)) return null;
  return /mInputShown=true/.test(out);
}

export const toBox = (n: UiNode): UiBox => [n.x1, n.y1, n.x2 - n.x1, n.y2 - n.y1];
export const nodeCenter = (n: Pick<UiNode, 'x1' | 'y1' | 'x2' | 'y2'>) => ({ x: Math.round((n.x1 + n.x2) / 2), y: Math.round((n.y1 + n.y2) / 2) });
export const inside = (n: UiNode, o: UiNode) => n.x1 >= o.x1 && n.x2 <= o.x2 && n.y1 >= o.y1 && n.y2 <= o.y2;

export type TextMatch = { exact: string } | { contains: string } | { regex: string };

/** Pure: does a node's text or content-desc match? */
export function matches(n: UiNode, m: TextMatch): boolean {
  const vals = [n.text, n.desc].filter(Boolean);
  if ('exact' in m) return vals.some((v) => v.trim() === m.exact);
  if ('contains' in m) return vals.some((v) => v.includes(m.contains));
  const re = new RegExp(m.regex);
  return vals.some((v) => re.test(v));
}

/** Pure: nodes matching text, exact before substring (tier ① locate). */
export function findByText(nodes: UiNode[], q: string, within?: UiBox, o: { newest?: boolean } = {}): { node: UiNode; how: 'exact' | 'contains' } | undefined {
  const inBox = (n: UiNode) => !within || (n.x1 >= within[0] && n.y1 >= within[1] && n.x2 <= within[0] + within[2] && n.y2 <= within[1] + within[3]);
  // newest: the bottom-most message carrying the text, not a quote block ("<sender>, <quoted text>") that repeats it.
  const cards = o.newest ? nodes.filter((n) => n.clickable && /^[^,]{1,60}, .+/.test(n.desc)) : [];
  // newest: never the composer (text typed but not sent is not a message).
  const pool = nodes.filter(inBox).filter((n) => !cards.some((c) => c !== n && inside(n, c)) && !cards.includes(n) && !(o.newest && /EditText/.test(n.cls)));
  const pick = (xs: UiNode[]) => (o.newest ? [...xs].sort((a, b) => b.y1 - a.y1)[0] : xs[0]);
  const ex = pick(pool.filter((n) => matches(n, { exact: q })));
  if (ex) return { node: ex, how: 'exact' };
  const ct = pick(pool.filter((n) => matches(n, { contains: q })));
  return ct ? { node: ct, how: 'contains' } : undefined;
}

/** Pure: smallest node covering a point (fingerprint of what a tap hits). */
export function nodeAt(nodes: UiNode[], x: number, y: number): UiNode | undefined {
  return nodes.filter((n) => n.x1 <= x && x <= n.x2 && n.y1 <= y && y <= n.y2 && (n.text || n.desc)).sort((a, b) => (a.x2 - a.x1) * (a.y2 - a.y1) - (b.x2 - b.x1) * (b.y2 - b.y1))[0];
}

/** Pure: clickable ancestor (smallest clickable box containing n). */
export function clickableAncestor(nodes: UiNode[], n: UiNode): UiNode | undefined {
  return nodes.filter((o) => o.clickable && inside(n, o)).sort((a, b) => (a.x2 - a.x1) * (a.y2 - a.y1) - (b.x2 - b.x1) * (b.y2 - b.y1))[0];
}
