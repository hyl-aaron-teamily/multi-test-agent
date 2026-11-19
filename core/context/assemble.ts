// Context assembler (W3-2 §1.3): every model call is built from named slots in a fixed order — stable prefix
// (role, rules, block catalog) → task → work area → memory → evidence → history — and leaves a manifest of what
// went in (slot, characters, images, degraded or not) next to the call's usage, so "why did the model not know X"
// is answered by reading the manifest. The API is stateless: the whole context is sent on every call; the
// assembler decides what, in which order, and keeps the stable prefix byte-identical so a provider prefix cache
// can hit it.
//
// W3-2 only moves the existing call sites onto slots (prompts unchanged, snapshot-tested); slicing (catalog per
// plan, the failing plan section, compressed history, memory) comes as slots in W3-3 … W3-7.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chatCall, visionCall, type CallOptions, type CallResult, type VisionPart } from '../model/llm';

export type Part = VisionPart;

export interface Slot {
  /** Stable id, e.g. 'skill', 'catalog', 'issue', 'screenshot'. */
  name: string;
  role: 'system' | 'user';
  /** Text, or text + images (user slots only). Empty slots are dropped and listed as such in the manifest. */
  content: string | Part[];
  /** Part of the stable prefix: identical across calls of this purpose (hashed into the manifest). */
  stable?: boolean;
  /** Soft budget in characters: above it, `degrade` is used instead (full → summary → reference). */
  budget?: number;
  degrade?: () => string | Part[];
  /** A remark for the manifest (W3-5: 「记忆服务不可用」 on the memory slot). */
  note?: string;
}

export interface SlotEntry {
  name: string;
  role: 'system' | 'user';
  chars: number;
  images: number;
  stable?: boolean;
  degraded?: boolean;
  empty?: boolean;
  note?: string;
}

export interface Manifest {
  t: string;
  purpose: string;
  slots: SlotEntry[];
  systemChars: number;
  userChars: number;
  images: number;
  /** sha1 of the stable slots, in order: equal hashes = a cacheable prefix. */
  prefixHash?: string;
}

export interface Assembled {
  system: string;
  /** The user message: a plain string when it has no images. */
  user: string | Part[];
  manifest: Manifest;
}

const textOf = (c: string | Part[]) => (typeof c === 'string' ? c : c.map((p) => (typeof p === 'string' ? p : p.label)).join(''));
const imagesOf = (c: string | Part[]) => (typeof c === 'string' ? 0 : c.filter((p) => typeof p !== 'string').length);
const isEmpty = (c: string | Part[]) => (typeof c === 'string' ? c.length === 0 : c.length === 0);

/** Pure: slots → system text + user message + manifest. Slots keep their given order within each role; system
 *  slots are joined with `systemJoin`, user text slots with `userJoin` (callers pass the separators their prompt
 *  always used, so moving onto slots changes no byte). */
export function assemble(purpose: string, slots: Slot[], o: { systemJoin?: string; userJoin?: string } = {}): Assembled {
  const entries: SlotEntry[] = [];
  const sys: string[] = [];
  const userSlots: (string | Part[])[] = [];
  const stableHash = createHash('sha1');
  let stable = false;
  for (const s of slots) {
    const degraded = s.budget !== undefined && !!s.degrade && textOf(s.content).length > s.budget;
    const content = degraded ? s.degrade!() : s.content;
    const entry: SlotEntry = { name: s.name, role: s.role, chars: textOf(content).length, images: imagesOf(content), ...(s.stable ? { stable: true } : {}), ...(degraded ? { degraded } : {}), ...(s.note ? { note: s.note } : {}) };
    if (isEmpty(content)) {
      entries.push({ ...entry, empty: true });
      continue;
    }
    entries.push(entry);
    if (s.stable) {
      stable = true;
      stableHash.update(`${s.role}:${s.name}\n${textOf(content)}\n`);
    }
    if (s.role === 'system') sys.push(textOf(content));
    else userSlots.push(content);
  }
  // Adjacent user text slots are joined into one text part; image slots keep their parts.
  const uj = o.userJoin ?? '\n\n';
  const merged: Part[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length) merged.push(pending.join(uj));
    pending = [];
  };
  for (const c of userSlots) {
    if (typeof c === 'string') pending.push(c);
    else {
      flush();
      merged.push(...c);
    }
  }
  flush();
  const system = sys.join(o.systemJoin ?? '\n\n');
  const user: string | Part[] = merged.every((p) => typeof p === 'string') ? (merged as string[]).join(uj) : merged;
  const manifest: Manifest = {
    t: new Date().toISOString(),
    purpose,
    slots: entries,
    systemChars: system.length,
    userChars: textOf(user).length,
    images: entries.reduce((n, e) => n + e.images, 0),
    ...(stable ? { prefixHash: stableHash.digest('hex').slice(0, 16) } : {}),
  };
  return { system, user, manifest };
}

let manifestLogPath: string | undefined;
/** Append every manifest (with the call's outcome and usage) to this JSONL file; undefined = stop. */
export function setContextManifestLog(path: string | undefined): void {
  manifestLogPath = path;
}

function logManifest(m: Manifest & Record<string, unknown>, extra?: string): void {
  for (const p of new Set([manifestLogPath, extra].filter((x): x is string => !!x))) {
    try {
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, `${JSON.stringify(m)}\n`);
    } catch {
      /* the log never breaks a call */
    }
  }
}

export interface ModelRequest extends CallOptions {
  purpose: string;
  slots: Slot[];
  /** Send to the vision model (images allowed). Default: vision when any slot has an image. */
  vision?: boolean;
  systemJoin?: string;
  userJoin?: string;
  /** Also append the manifest to this JSONL file. */
  manifestLog?: string;
}

/** Assemble, call, and log the manifest with the outcome. */
export async function modelCall(req: ModelRequest): Promise<CallResult & { manifest: Manifest }> {
  const { system, user, manifest } = assemble(req.purpose, req.slots, { systemJoin: req.systemJoin, userJoin: req.userJoin });
  const vision = req.vision ?? (manifest.images > 0);
  const opts: CallOptions = { ...req, purpose: req.purpose };
  const r = vision ? await visionCall(system, typeof user === 'string' ? [user] : user, opts) : await chatCall(system, typeof user === 'string' ? user : textOf(user), opts);
  logManifest({ ...manifest, ok: r.ok, ...(r.ok ? {} : { fail: r.fail }), usage: r.usage, ms: r.ms, requests: r.requests }, req.manifestLog);
  return { ...r, manifest };
}
