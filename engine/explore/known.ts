// Known issues across runs (W3-4 §8.5 ④) and human triage (②③). A finding's key is page + type + its text
// normalized (digits, times and punctuation gone); a new finding that matches a known issue only bumps that
// issue's count and links the run — it is not a new problem. Triage (这是问题 / 不是问题 / 环境问题) is stored in
// platform/explore/triage.json and on the known issue; turning it into rules that stop the reports is W3-5.
// D10: a "the typed text does not show" finding after the executor's read-back said `input not committed` is a
// test-method problem and does not count.
import { resolve } from 'node:path';
import { similarity } from '../../core/screen-index';
import { readJsonFile, writeJsonFile } from './store';

export type TriageVerdict = 'issue' | 'not-issue' | 'env';
export const TRIAGE_TEXT: Record<TriageVerdict, string> = { issue: '是问题', 'not-issue': '不是问题', env: '环境问题' };

export interface KnownRun {
  /** Task id, or the run dir's name for runs outside the platform. */
  run: string;
  /** Finding number in that run. */
  n: number;
  at: string;
}

export interface KnownIssue {
  id: string;
  key: string;
  page: string;
  type: string;
  /** Normalized text the key and the fuzzy match use. */
  text: string;
  /** The first description, verbatim. */
  sample: string;
  count: number;
  runs: KnownRun[];
  first: string;
  last: string;
  triage?: { verdict: TriageVerdict; note?: string; at: string };
}

export interface KnownFile {
  schemaVersion: 1;
  items: KnownIssue[];
}

/** platform/explore, or AUTOTEST_EXPLORE_DIR (tests). Read on every call so tests can point it elsewhere. */
export const exploreDir = () => resolve(process.env.AUTOTEST_EXPLORE_DIR ?? 'platform/explore');
export const knownPath = () => resolve(exploreDir(), 'known.json');
export const triagePath = () => resolve(exploreDir(), 'triage.json');
/** Same page and type, texts this similar = the same issue (model reports word the same thing differently). */
export const SAME_TEXT = 0.82;
/** Known issues of the current page in one prompt. */
export const KNOWN_MAX = 8;

/** Pure: a finding's text as the key sees it — digits (times, counts, dates) and punctuation dropped. */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\d+/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim();
}

export interface FindingKeyInput {
  page: string;
  /** detector kind, `reported`, `expectation:<id>`, `hard:<kind>`, `human`. */
  type: string;
  /** For detectors the node's text; otherwise the description. */
  text: string;
}

export const keyOf = (f: FindingKeyInput) => `${f.page}|${f.type}|${normText(f.text)}`;

/** Pure: the known issue a finding is (exact key, else the same page and type with a similar text). Model
 *  reports, expectations and human marks of any page match on text alone when the page was not recognized. */
export function matchKnown(items: KnownIssue[], f: FindingKeyInput): KnownIssue | undefined {
  const key = keyOf(f);
  const exact = items.find((k) => k.key === key);
  if (exact) return exact;
  const t = normText(f.text);
  if (!t) return undefined;
  let best: { k: KnownIssue; s: number } | undefined;
  for (const k of items) {
    if (k.type !== f.type || k.page !== f.page) continue;
    const s = similarity(k.text, t);
    if (s >= SAME_TEXT && (!best || s > best.s)) best = { k, s };
  }
  return best?.k;
}

const newId = (items: KnownIssue[]) => `K${String(items.reduce((m, k) => Math.max(m, Number(k.id.slice(1)) || 0), 0) + 1).padStart(3, '0')}`;

/** Pure: record a finding — bump the known issue it matches (one count per run and finding), or add a new one.
 *  `isNew` = it was not known before. */
export function recordKnown(items: KnownIssue[], f: FindingKeyInput & { description: string }, run: KnownRun): { issue: KnownIssue; isNew: boolean } {
  const k = matchKnown(items, f);
  if (k) {
    if (!k.runs.some((r) => r.run === run.run && r.n === run.n)) {
      k.count++;
      k.runs.push(run);
      if (k.runs.length > 50) k.runs.splice(0, k.runs.length - 50);
      k.last = run.at;
    }
    return { issue: k, isNew: false };
  }
  const issue: KnownIssue = { id: newId(items), key: keyOf(f), page: f.page, type: f.type, text: normText(f.text), sample: f.description, count: 1, runs: [run], first: run.at, last: run.at };
  items.push(issue);
  return { issue, isNew: true };
}

/** Pure: does a known issue's triage say it is not the app's problem (it does not count again)? */
export const dismissed = (k: KnownIssue | undefined) => !!k?.triage && k.triage.verdict !== 'issue';

/** Pure: the prompt block of the page's known issues (§8.5 ④): recorded, no need to report or spend steps. */
export function knownBlock(items: KnownIssue[], page: string): string {
  const here = items
    .filter((k) => k.page === page)
    .sort((a, b) => b.count - a.count)
    .slice(0, KNOWN_MAX);
  if (!here.length) return '';
  return `已记录的问题 (known issues on this page: already recorded — do not report them again and do not spend steps on them here):\n${here.map((k) => `- ${k.sample.slice(0, 120)}${k.triage && k.triage.verdict !== 'issue' ? ` (people marked it ${k.triage.verdict === 'env' ? 'an environment problem' : 'not a problem'})` : ''} (seen ${k.count}×)`).join('\n')}`;
}

export function readKnown(file = knownPath()): KnownIssue[] {
  return readJsonFile<KnownFile>(file)?.items ?? [];
}

/** Read the file again, apply `change` to it and write it (the platform and a run may both touch it). */
export function updateKnown<T>(change: (items: KnownIssue[]) => T, file = knownPath()): T {
  const items = readKnown(file);
  const r = change(items);
  writeJsonFile(file, { schemaVersion: 1, items } satisfies KnownFile);
  return r;
}

// ---------------------------------------------------------------- triage

export interface TriageEntry {
  /** Task id (or run dir name). */
  run: string;
  /** The finding it is about (absent for a 这是问题 mark that made a new finding — then `n` is that finding). */
  n?: number;
  step?: number;
  verdict: TriageVerdict;
  note?: string;
  description: string;
  page?: string;
  known?: string;
  at: string;
}

export function readTriage(file = triagePath()): TriageEntry[] {
  return readJsonFile<{ schemaVersion: 1; items: TriageEntry[] }>(file)?.items ?? [];
}

export function addTriage(e: TriageEntry, file = triagePath()): void {
  const items = readTriage(file);
  // A finding's latest triage replaces the earlier one.
  const i = e.n !== undefined ? items.findIndex((x) => x.run === e.run && x.n === e.n) : -1;
  if (i >= 0) items[i] = e;
  else items.push(e);
  writeJsonFile(file, { schemaVersion: 1, items });
}

// ---------------------------------------------------------------- D10

/** A finding that says typed text does not show (search box empty, IME garbage, text missing). */
const INPUT_NOT_SHOWN =
  /(输入|键入|打字|文字|文本|搜索框|输入框|关键词|候选|拼音).{0,16}(不显示|没有显示|未显示|没显示|不出现|没有出现|未出现|为空|空白|丢失|消失|乱码|不上屏|未上屏|没有上屏|没上屏)|不显示输入|输入.{0,6}(没有|未)(生效|反应)|(组合栏|候选栏|输入法).{0,10}(乱码|异常|残留)|(typed|input|entered|search)\s*(text|query|box|field)?.{0,30}(not (shown|displayed|visible|appear)|missing|empty|did ?n[o']t appear|disappear)|(ime|composition|candidate) (bar|text|garbage|garbled)/i;

/** Pure: is this finding the D10 false positive — it says the typed text does not show, and the last read-back
 *  before it (in this or an earlier step) was `input not committed`, with no successful read-back since? */
export function inputNotCommittedBefore(steps: { step: number; readback?: string[] }[], step: number, description: string): boolean {
  if (!INPUT_NOT_SHOWN.test(description)) return false;
  for (const s of [...steps].filter((x) => x.step <= step).sort((a, b) => b.step - a.step)) {
    const rb = s.readback?.at(-1);
    if (rb === undefined || rb === 'field not readable') continue;
    return rb === 'input not committed';
  }
  return false;
}

export const D10_REASON = '输入没有上屏（执行端读回 input not committed）：测试方法问题，不计入（D10）';
