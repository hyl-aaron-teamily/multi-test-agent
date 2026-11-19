// Lessons (W3-5 §8.7, D13): one person's sentence on a finding becomes a structured lesson the executor obeys —
// L1 executor guard (code; listed as a to-do when it does not exist yet), L2 judging rule (a finding it covers
// does not count), L3 behaviour guidance (put into the prompt). The repository is the source of truth:
// platform/memory/lessons.jsonl (in git); lessons about one device only: lessons.local.jsonl. The memory
// service gets a copy for search and its panel (core/memory/client.ts), never the other way round.
//
// `when` holds conditions the executor can compute itself — never the model's judgement:
//   always | after:<action type> | page:<page id> | readback:<text in the last read-back> | finding:<finding type>
// `do.L2`:  suppress:input-echo (the D10 family) | suppress:type:<finding type> | suppress:text:<regex> |
//           suppress:known:<known issue id>
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type LessonStatus = 'active' | 'candidate' | 'disabled' | 'undone';
export type LessonClass = 'test-method' | 'environment' | 'app-behaviour' | 'not-a-bug';

export interface Lesson {
  id: string;
  scope: { surface?: string; page?: string; action?: string };
  when: string[];
  class: LessonClass;
  do: { L1?: string; L2?: string; L3?: string };
  /** What must still be reported (keeps the lesson from hiding real problems). */
  counter: string;
  /** One sentence for people (the preview next to 「修改」「撤销」). */
  preview: string;
  evidence: { run: string; step?: number; n?: number; note?: string }[];
  status: LessonStatus;
  /** Where it came from: a person's mark, the memory service's extraction (a candidate), an overturn. */
  source: 'human' | 'memory-service' | 'manual';
  createdAt: string;
  updatedAt?: string;
  /** Why it is a candidate / disabled (overturned, conflict, replay gate). */
  reason?: string;
  /** Only this device (stored in lessons.local.jsonl). */
  device?: string;
}

export interface LessonStats {
  injected: number;
  applied: number;
  overturned: number;
}

export const memoryDir = () => resolve(process.env.AUTOTEST_MEMORY_DIR ?? 'platform/memory');
export const lessonsPath = () => resolve(memoryDir(), 'lessons.jsonl');
export const localLessonsPath = () => resolve(memoryDir(), 'lessons.local.jsonl');
export const statsPath = () => resolve(memoryDir(), 'stats.local.json');

// ---------------------------------------------------------------- storage

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).flatMap((l) => {
    try {
      return [JSON.parse(l) as T];
    } catch {
      return [];
    }
  });
}

function writeJsonl(file: string, items: unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''));
  renameSync(`${file}.tmp`, file);
}

export function readLessons(o: { shared?: string; local?: string } = {}): Lesson[] {
  return [...readJsonl<Lesson>(o.shared ?? lessonsPath()), ...readJsonl<Lesson>(o.local ?? localLessonsPath()).map((l) => ({ ...l, device: l.device ?? 'local' }))];
}

/** Write all lessons back, each to its file (device lessons to the local file). */
export function writeLessons(items: Lesson[], o: { shared?: string; local?: string } = {}): void {
  writeJsonl(o.shared ?? lessonsPath(), items.filter((l) => !l.device));
  writeJsonl(o.local ?? localLessonsPath(), items.filter((l) => l.device));
}

export function updateLessons<T>(change: (items: Lesson[]) => T, o: { shared?: string; local?: string } = {}): T {
  const items = readLessons(o);
  const r = change(items);
  writeLessons(items, o);
  return r;
}

export function readStats(file = statsPath()): Record<string, LessonStats> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, LessonStats>;
  } catch {
    return {};
  }
}

/** Add counts (a run's injections / applications) to the local stats file (not in git: it changes every run). */
export function addStats(delta: Record<string, Partial<LessonStats>>, file = statsPath()): void {
  if (!Object.keys(delta).length) return;
  const all = readStats(file);
  for (const [id, d] of Object.entries(delta)) {
    const s = (all[id] ??= { injected: 0, applied: 0, overturned: 0 });
    s.injected += d.injected ?? 0;
    s.applied += d.applied ?? 0;
    s.overturned += d.overturned ?? 0;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(all, null, 2));
}

// ---------------------------------------------------------------- checking

const WHEN = /^(always|after:[a-z_]+|page:[\w-]+|readback:.+|finding:[\w:-]+)$/;
const L2 = /^suppress:(input-echo|type:[\w:-]+|text:.+|known:K\d+)$/;

/** Pure: what is wrong with a lesson (undefined = usable). */
export function checkLesson(l: Partial<Lesson>): string | undefined {
  if (!l.id || !/^L-[\w-]{2,60}$/.test(l.id)) return 'id：L- 开头，字母数字和 -';
  if (!Array.isArray(l.when) || !l.when.length) return 'when：至少一个条件';
  const badWhen = l.when.find((w) => !WHEN.test(w));
  if (badWhen) return `when：不认识的条件「${badWhen}」（always | after:<动作> | page:<页面> | readback:<文字> | finding:<类型>）`;
  if (!l.do || !(l.do.L1 || l.do.L2 || l.do.L3)) return 'do：L1 / L2 / L3 至少一项';
  if (l.do.L2 && !L2.test(l.do.L2)) return `do.L2：不认识的规则「${l.do.L2}」（suppress:input-echo | suppress:type:<类型> | suppress:text:<正则> | suppress:known:<K编号>）`;
  if (l.do.L2?.startsWith('suppress:text:')) {
    try {
      new RegExp(l.do.L2.slice('suppress:text:'.length), 'i');
    } catch {
      return 'do.L2：suppress:text: 后面不是合法的正则';
    }
  }
  if (!l.counter?.trim()) return 'counter：写明哪些情况仍要报';
  return undefined;
}

// ---------------------------------------------------------------- matching

/** What the executor knows at a step (all computed, nothing from the model). */
export interface StepContext {
  surface: string;
  page?: string;
  /** The action type of the previous step (after:<type>). */
  lastAction?: string;
  /** The previous step's read-back lines (readback:<text>). */
  readback?: string[];
}

const scopeFits = (l: Lesson, c: { surface?: string; page?: string; action?: string }) =>
  (!l.scope.surface || !c.surface || l.scope.surface === c.surface) && (!l.scope.page || l.scope.page === c.page) && (!l.scope.action || !c.action || l.scope.action === c.action);

/** Pure: does one `when` condition hold at this step? */
export function whenHolds(w: string, c: StepContext & { findingType?: string }): boolean {
  if (w === 'always') return true;
  const [k, ...rest] = w.split(':');
  const v = rest.join(':');
  if (k === 'after') return c.lastAction === v;
  if (k === 'page') return c.page === v;
  if (k === 'readback') return (c.readback ?? []).some((r) => r.includes(v.replace(/^['"]|['"]$/g, '')));
  if (k === 'finding') return c.findingType === v;
  return false;
}

/** Pure: the active lessons to put into this step's prompt (L3), deterministic path (§8.7 ④). The `finding:`
 *  conditions are for judging, not for prompts: a lesson that has only those is not injected. */
export function lessonsForStep(lessons: Lesson[], c: StepContext, max = 5): Lesson[] {
  return lessons
    .filter((l) => l.status === 'active' && l.do.L3 && scopeFits(l, { surface: c.surface, page: c.page, action: c.lastAction }))
    .filter((l) => l.when.filter((w) => !w.startsWith('finding:')).length > 0 && l.when.filter((w) => !w.startsWith('finding:')).every((w) => whenHolds(w, c)))
    .slice(0, max);
}

/** Pure: the prompt block (appended after the other blocks, K4). Retrieved experience comes after the lessons. */
export function lessonBlock(ls: Lesson[], retrieved: string[] = []): string {
  if (!ls.length && !retrieved.length) return '';
  const lines = ls.map((l) => `- [${l.id}] ${l.do.L3}${l.counter ? `（仍要报：${l.counter}）` : ''}`);
  const ref = retrieved.map((r) => `- （参考）${r}`);
  return [`Lessons from people's marks on earlier runs (follow them):`, ...lines, ...(ref.length ? ['Related experience (for reference only):', ...ref] : [])].join('\n');
}

/** A finding as the judging rules see it. */
export interface FindingFacts {
  source: string;
  type: string;
  text: string;
  page?: string;
  knownId?: string;
  step: number;
}

/** The D10 family: typed text that "does not show" (shared with engine/explore/known.ts). */
export const INPUT_ECHO = /(输入|键入|打字|文字|文本|搜索框|输入框|关键词|候选|拼音).{0,16}(不显示|没有显示|未显示|没显示|不出现|没有出现|未出现|为空|空白|丢失|消失|乱码|不上屏|未上屏|没有上屏|没上屏)|不显示输入|(组合栏|候选栏|输入法).{0,10}(乱码|异常|残留)|(typed|input|entered|search)\s*(text|query|box|field)?.{0,30}(not (shown|displayed|visible|appear)|missing|empty|did ?n[o']t appear|disappear)|(ime|composition|candidate) (bar|text|garbage|garbled)/i;

/** Pure: does a lesson's L2 rule cover this finding? (scope + `when` + the rule; human findings never). */
export function suppresses(l: Lesson, f: FindingFacts, c: StepContext): boolean {
  if (l.status !== 'active' || !l.do.L2 || f.source === 'human') return false;
  if (!scopeFits(l, { surface: c.surface, page: f.page, action: c.lastAction })) return false;
  if (!l.when.every((w) => whenHolds(w, { ...c, page: f.page ?? c.page, findingType: f.type }))) return false;
  const rule = l.do.L2.slice('suppress:'.length);
  if (rule === 'input-echo') return INPUT_ECHO.test(f.text);
  if (rule.startsWith('type:')) return f.type === rule.slice(5);
  if (rule.startsWith('text:')) return new RegExp(rule.slice(5), 'i').test(f.text);
  if (rule.startsWith('known:')) return f.knownId === rule.slice(6);
  return false;
}

export function suppressingLesson(lessons: Lesson[], f: FindingFacts, c: StepContext): Lesson | undefined {
  return lessons.find((l) => suppresses(l, f, c));
}

/** L1 guards the executor has (code). A lesson naming another one is listed as an executor to-do. */
export const L1_GUARDS: Record<string, string> = {
  'type.verifyCommit': 'W3-3：输入后读回，没上屏换方式重试，仍不行回 input not committed',
};

/** Pure: two active lessons that contradict (same scope and when, one suppresses what the other's L3 says to report). */
export function conflicts(a: Lesson, b: Lesson): boolean {
  if (a.id === b.id || a.status !== 'active' || b.status !== 'active') return false;
  const same = JSON.stringify(a.scope) === JSON.stringify(b.scope) && JSON.stringify([...a.when].sort()) === JSON.stringify([...b.when].sort());
  return same && !!a.do.L2 && !!b.do.L2 && a.do.L2 === b.do.L2 && a.class !== b.class;
}

export function lessonText(l: Lesson, stats?: LessonStats): string {
  return `${l.status === 'active' ? '✓' : l.status === 'candidate' ? '?' : '·'} [${l.id}] ${l.preview}${l.do.L2 ? `  L2 ${l.do.L2}` : ''}${l.do.L3 ? `  L3「${l.do.L3}」` : ''}${l.do.L1 ? `  L1 ${l.do.L1}${L1_GUARDS[l.do.L1] ? '' : '（执行端待修）'}` : ''}  when ${l.when.join(' & ')}${stats ? `  注入 ${stats.injected} / 生效 ${stats.applied} / 推翻 ${stats.overturned}` : ''}${l.reason ? `  # ${l.reason}` : ''}`;
}
