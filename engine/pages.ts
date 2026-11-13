// Page recording and page recognition (W3-4 §8.2′, contract K3). `pageOf(nodes)` tells which page of the app
// is on screen from the accessibility tree (rules: skills/teamily/page-rules.ts) — the checklist (§8.5 ①), the
// known issues (④) and W3-5's lessons are injected per page; an unrecognized screen is `unknown` and gets no
// per-page entries. The recorder keeps, per language and page, the deduplicated screen texts and element
// descriptions the executor read (every snapshot of an exploration or a plan run), in
// skills/teamily/pages.local.json (not in git). W3-7 builds the block catalog's "texts on real pages" from it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { label, type ScreenNode } from '../core/screen-index';
import { TEAMILY_PAGES } from '../skills/teamily/page-rules';
import { fingerprint } from './agent/step';

export type Lang = 'zh' | 'en';
type Anchor = string | RegExp;

export interface PageRule {
  id: string;
  /** What people call it (the checklist's `page` uses this or the id). */
  name: string;
  anchors: Record<Lang, Anchor[]>;
  /** At least one of these must be among the matched anchors. */
  need?: Record<Lang, Anchor[]>;
  min: number;
}

export interface PageMatch {
  /** Rule id, or `unknown`. */
  id: string;
  name: string;
  lang: Lang;
}

export const UNKNOWN_PAGE = 'unknown';

const hit = (a: Anchor, labels: Set<string>): boolean => (typeof a === 'string' ? labels.has(a) : [...labels].some((l) => a.test(l)));

/** Pure: the language of the screen's own words — one vote per label: Chinese if it has CJK characters, English
 *  if it is a short Latin label (the app's chrome: "Settings", "Log out"). Longer Latin texts are user content
 *  (names, group titles, links), which a Chinese UI is full of. */
export function langOf(nodes: Pick<ScreenNode, 'text' | 'desc'>[]): Lang {
  let zh = 0;
  let en = 0;
  for (const t of new Set(nodes.map((n) => label(n)).filter(Boolean))) {
    if (/[一-鿿]/.test(t)) zh++;
    else if (/[A-Za-z]/.test(t) && t.length <= 12) en++;
  }
  return zh >= en && zh > 0 ? 'zh' : 'en';
}

/** Pure: which page is on screen (contract K3). Rules in order; the first that matches wins. */
export function pageOf(nodes: Pick<ScreenNode, 'text' | 'desc'>[], rules: PageRule[] = TEAMILY_PAGES): PageMatch {
  const labels = new Set(nodes.map((n) => label(n)).filter(Boolean));
  for (const r of rules) {
    for (const lang of ['zh', 'en'] as Lang[]) {
      const got = r.anchors[lang].filter((a) => hit(a, labels));
      if (got.length < r.min) continue;
      if (r.need && !r.need[lang].some((a) => hit(a, labels))) continue;
      return { id: r.id, name: r.name, lang };
    }
  }
  return { id: UNKNOWN_PAGE, name: '未知页面', lang: langOf(nodes) };
}

/** Pure: does a page reference (id or name, as people write it in the checklist) mean this page? */
export function samePage(ref: string | undefined, page: Pick<PageMatch, 'id' | 'name'>, rules: PageRule[] = TEAMILY_PAGES): boolean {
  if (!ref || page.id === UNKNOWN_PAGE) return false;
  const r = ref.trim();
  if (r === page.id || r === page.name) return true;
  const rule = rules.find((x) => x.id === page.id);
  return !!rule && (r === rule.name || r.replace(/\s+/g, '') === rule.name.replace(/\s+/g, ''));
}

/** Pure: a page reference → the rule id ('' when it names no known page). */
export function pageId(ref: string | undefined, rules: PageRule[] = TEAMILY_PAGES): string {
  if (!ref) return '';
  const r = ref.trim().replace(/\s+/g, '');
  return rules.find((x) => x.id === ref.trim() || x.name.replace(/\s+/g, '') === r)?.id ?? '';
}

// ---------------------------------------------------------------- recording

/** Dedup key of a text: digits (times, counts, dates) do not make a new text. */
export const textKey = (t: string) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

interface Counted {
  /** One verbatim sample. */
  v: string;
  n: number;
}

export interface PageRecord {
  name: string;
  seen: number;
  first: string;
  last: string;
  surfaces: string[];
  texts: Record<string, Counted>;
  elements: Record<string, Counted>;
}

export interface UnknownRecord {
  seen: number;
  last: string;
  /** A sample of the screen's texts, for writing a rule. */
  texts: string[];
}

export interface PagesFile {
  schemaVersion: 1;
  note: string;
  pages: Record<Lang, Record<string, PageRecord>>;
  /** Screens no rule recognized, by fingerprint (for writing rules, V2). */
  unknown: Record<Lang, Record<string, UnknownRecord>>;
}

/** Entries kept per page and kind; on overflow the rarest go (user content seen once, not the page's own texts). */
export const PAGE_CAP = 400;
const UNKNOWN_CAP = 200;

export const emptyPages = (): PagesFile => ({ schemaVersion: 1, note: '页面实录（W3-4 §8.2′）：执行端读到的屏幕文字和元素描述，按语言、页面去重计数。不进 git。', pages: { zh: {}, en: {} }, unknown: { zh: {}, en: {} } });

/** Pure: how an element is described (kind, text, id tail) — the same words as the model's element list. */
export function elementDesc(n: ScreenNode): string | undefined {
  const input = /EditText|textbox|textarea|searchbox|combobox/i.test(n.cls);
  if (!n.clickable && !input) return undefined;
  const t = label(n);
  const id = n.rid ? n.rid.split('/').pop() : '';
  if (!t && !id && !n.hint) return undefined;
  return `${input ? 'input' : 'button'} ${JSON.stringify(t)}${n.hint ? ` hint ${JSON.stringify(n.hint)}` : ''}${!t && id ? ` id ${JSON.stringify(id)}` : ''}`;
}

const bump = (m: Record<string, Counted>, v: string, by = 1) => {
  const k = textKey(v);
  if (!k) return;
  const c = m[k];
  if (c) c.n += by;
  else m[k] = { v, n: by };
};

function cap(m: Record<string, Counted>, max = PAGE_CAP): void {
  const ks = Object.keys(m);
  if (ks.length <= max) return;
  for (const [k] of Object.entries(m).sort((a, b) => a[1].n - b[1].n).slice(0, ks.length - max)) delete m[k];
}

/** Pure: add one screen to the record (texts and elements counted once per screen). */
export function recordScreen(f: PagesFile, nodes: ScreenNode[], surface: string, at = new Date().toISOString(), page = pageOf(nodes)): PageMatch {
  if (!nodes.length) return page;
  const texts = [...new Set(nodes.map((n) => label(n)).filter(Boolean))];
  if (page.id === UNKNOWN_PAGE) {
    const fp = fingerprint(nodes as ScreenNode[]);
    const u = (f.unknown[page.lang][fp] ??= { seen: 0, last: at, texts: texts.slice(0, 40) });
    u.seen++;
    u.last = at;
    const all = Object.entries(f.unknown[page.lang]);
    if (all.length > UNKNOWN_CAP) for (const [k] of all.sort((a, b) => a[1].last.localeCompare(b[1].last)).slice(0, all.length - UNKNOWN_CAP)) delete f.unknown[page.lang][k];
    return page;
  }
  const p = (f.pages[page.lang][page.id] ??= { name: page.name, seen: 0, first: at, last: at, surfaces: [], texts: {}, elements: {} });
  p.seen++;
  p.last = at;
  if (!p.surfaces.includes(surface)) p.surfaces.push(surface);
  const seenText = new Set<string>();
  for (const t of texts) if (!seenText.has(textKey(t))) (seenText.add(textKey(t)), bump(p.texts, t));
  const seenEl = new Set<string>();
  for (const n of nodes) {
    const d = elementDesc(n);
    if (d && !seenEl.has(textKey(d))) (seenEl.add(textKey(d)), bump(p.elements, d));
  }
  cap(p.texts);
  cap(p.elements);
  return page;
}

/** Pure: merge what one process recorded into the file's content (counts add up). */
export function mergePages(into: PagesFile, add: PagesFile): PagesFile {
  for (const lang of ['zh', 'en'] as Lang[]) {
    for (const [id, p] of Object.entries(add.pages[lang])) {
      const q = into.pages[lang][id];
      if (!q) {
        into.pages[lang][id] = structuredClone(p);
        continue;
      }
      q.seen += p.seen;
      q.first = q.first < p.first ? q.first : p.first;
      q.last = q.last > p.last ? q.last : p.last;
      q.surfaces = [...new Set([...q.surfaces, ...p.surfaces])];
      for (const c of Object.values(p.texts)) bump(q.texts, c.v, c.n);
      for (const c of Object.values(p.elements)) bump(q.elements, c.v, c.n);
      cap(q.texts);
      cap(q.elements);
    }
    for (const [fp, u] of Object.entries(add.unknown[lang])) {
      const q = into.unknown[lang][fp];
      if (!q) into.unknown[lang][fp] = structuredClone(u);
      else (q.seen += u.seen, (q.last = q.last > u.last ? q.last : u.last));
    }
  }
  return into;
}

export const PAGES_FILE = resolve('skills/teamily/pages.local.json');

export function readPages(file = PAGES_FILE): PagesFile {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as PagesFile;
    return j?.schemaVersion === 1 && j.pages && j.unknown ? j : emptyPages();
  } catch {
    return emptyPages();
  }
}

/** Records the screens of one run in memory and merges them into the file now and then (another process may be
 *  writing the same file: read, merge, write through a temp file). */
export class PageRecorder {
  private delta = emptyPages();
  private pending = 0;
  constructor(
    readonly file = PAGES_FILE,
    readonly surface = '',
    private readonly every = 25,
  ) {}
  observe(nodes: ScreenNode[], surface = this.surface): PageMatch {
    const page = recordScreen(this.delta, nodes, surface);
    if (nodes.length && ++this.pending >= this.every) this.flush();
    return page;
  }
  flush(): void {
    if (!this.pending) return;
    try {
      const merged = mergePages(readPages(this.file), this.delta);
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged, null, 1));
      renameSync(tmp, this.file);
      this.delta = emptyPages();
      this.pending = 0;
    } catch {
      // Recording is a by-product: a failed write must not stop a run (the delta is kept for the next flush).
    }
  }
}

let active: PageRecorder | undefined;

/** Start recording every snapshot of the app under test (engine/snapshot.ts calls observeSnapshot); the
 *  returned function flushes and stops. Bench runs do not record (other apps). */
export function startPageRecording(surface: string, file = PAGES_FILE): () => void {
  const r = new PageRecorder(file, surface);
  active = r;
  return () => {
    r.flush();
    if (active === r) active = undefined;
  };
}

/** Called by snapshot(): records the screen when a run records pages. Never throws. */
export function observeSnapshot(nodes: ScreenNode[], surface: string): void {
  try {
    active?.observe(nodes, surface);
  } catch {
    /* recording is a by-product */
  }
}
