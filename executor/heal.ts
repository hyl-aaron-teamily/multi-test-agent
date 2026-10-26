// Fingerprint self-heal (W2-1 §6.2): calibration records each fixed element's text fingerprint; when the
// SKILL check or a warm-up step fails on a fixed element, the element is looked up again by that fingerprint
// (tier ①, accessibility tree / page text). Found → this run uses the new coordinates, the report lists
// them, and a candidate profile is written to the run directory — the calibrated profile is never changed.
// Never inside the loop (the loop reads no hierarchy).
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clickableAncestor, dumpTree, type UiNode } from '../core/ui-tree';
import { AndroidDriver } from '../drivers/android';
import { WebDriver } from '../drivers/web';
import type { ElementCal, Profile } from '../skills/profile';
import type { Session } from './session';

export interface Healed {
  element: string;
  from: ElementCal['box'];
  to: ElementCal['box'];
  by: string;
}

/** Pure: the node a fingerprint identifies (exact text / desc, same class when recorded). */
export function findByFingerprint(nodes: UiNode[], fp: NonNullable<ElementCal['fingerprint']>): UiNode | undefined {
  const same = (n: UiNode) => (!fp.cls || n.cls === fp.cls) && ((fp.text && n.text === fp.text) || (fp.desc && n.desc === fp.desc));
  return nodes.find(same) ?? nodes.find((n) => (fp.text && n.text === fp.text) || (fp.desc && n.desc === fp.desc));
}

/** Re-resolve elements of `ids` by fingerprint; updates the session's (in-memory) profile. */
export async function healElements(s: Session, ids: string[], runDir?: string): Promise<Healed[]> {
  const out: Healed[] = [];
  const p = s.profile;
  const fps = ids.filter((id) => p.elements[id]?.fingerprint && (p.elements[id].fingerprint!.text || p.elements[id].fingerprint!.desc));
  if (!fps.length) return out;
  if (s.inner instanceof AndroidDriver) {
    const nodes = await dumpTree(s.inner.o.udid, s.inner.o.packageName, 2);
    for (const id of fps) {
      const n = findByFingerprint(nodes, p.elements[id].fingerprint!);
      if (!n) continue;
      const t = clickableAncestor(nodes, n) ?? n;
      const to: ElementCal['box'] = [t.x1, t.y1, t.x2 - t.x1, t.y2 - t.y1];
      out.push({ element: id, from: p.elements[id].box, to, by: `accessibility "${n.text || n.desc}"` });
    }
  } else if (s.inner instanceof WebDriver && s.inner.page) {
    for (const id of fps) {
      const fp = p.elements[id].fingerprint!;
      const label = fp.text || fp.desc!;
      const b = await s.inner.page.getByText(label, { exact: true }).filter({ visible: true }).first().boundingBox({ timeout: 1000 }).catch(() => null);
      if (b) out.push({ element: id, from: p.elements[id].box, to: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)], by: `page text "${label}"` });
    }
  }
  const moved = out.filter((h) => h.from.join() !== h.to.join());
  for (const h of moved) p.elements[h.element] = { ...p.elements[h.element], box: h.to, note: `healed this run (was ${JSON.stringify(h.from)})` };
  if (moved.length && runDir) await writeFile(join(runDir, 'healed-profile.json'), JSON.stringify(p, null, 2)).catch(() => {});
  return moved;
}

/** Elements of a page that carry a fingerprint. */
export const fingerprintedOf = (p: Profile, page: string) => Object.entries(p.elements).filter(([, e]) => e.page === page && e.fingerprint).map(([id]) => id);

/** Warm-up helper: heal one element; returns a report line or undefined. */
export async function healElement(c: { sess: Session; o: { runDir: string }; res: { healed?: Healed[] }; log: (s: string) => void }, id: string): Promise<string | undefined> {
  const h = (await healElements(c.sess, [id], c.o.runDir))[0];
  if (!h) return undefined;
  (c.res.healed ??= []).push(h);
  const line = `${h.element}: ${JSON.stringify(h.from)} → ${JSON.stringify(h.to)}（${h.by}）`;
  c.log(`self-heal ${line}`);
  return line;
}
