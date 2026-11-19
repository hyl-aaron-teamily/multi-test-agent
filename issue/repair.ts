// W3-7 §8.1 ③–⑦ — repair only the broken step of a plan, in the same task.
//   ③ evidence: the screen's texts at the failure (RunResult.evidence) and near candidates for a text check;
//   ③½ deterministic fix (no model): one clearly-near candidate → swap the check's text; a restore check whose
//      text is not on the page → the page's own anchor text;
//   ④ ask the model for ops on the failing section only (the record's patch format, issue/record.ts);
//   ⑤ the judgment guard (what counts as reproduction is never changed automatically) and the scope check;
//   ⑦ continue only while the failure point moves on; stop on the same path twice or a return to an old rev.
import { readFileSync } from 'node:fs';
import { modelCall } from '../core/context/assemble';
import type { Slot } from '../core/context/assemble';
import { type FailurePoint, pathRank, toPointer } from '../engine/plan/failure-point';
import { TEAMILY_PAGES } from '../skills/teamily/page-rules';
import type { Envelope } from './author';
import { SKILL_FILE } from './author';
import { blockCatalog } from './catalog';
import type { PatchOp } from './record';

// ---------------------------------------------------------------- ③ near candidates

/** Words the App shows in either language (UI language follows the phone): for "the same text in the other
 *  language". Kept short; the page records add the real texts. */
export const BILINGUAL: [string, string][] = [
  ['设置', 'Settings'], ['全部设置', 'All settings'], ['偏好与安全', 'PREFERENCES & SECURITY'], ['账户', 'Account'],
  ['通知', 'Notifications'], ['隐私设置', 'Privacy Settings'], ['安全', 'Security'], ['语言', 'Language'],
  ['聊天', 'Chats'], ['消息', 'Messages'], ['我的', 'Me'], ['搜索', 'Search'], ['回复', 'Reply'], ['引用', 'Quote'],
  ['复制', 'Copy'], ['转发', 'Forward'], ['删除', 'Delete'], ['发送', 'Send'], ['取消', 'Cancel'], ['确定', 'OK'],
  ['翻译', 'Translate'], ['编辑', 'Edit'], ['撤回', 'Recall'], ['多选', 'Select'], ['收藏', 'Favorite'],
];

/** Pure: case, width, whitespace and punctuation folded. */
export const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s　]+/g, ' ').replace(/[“”"'`]/g, '').trim();

function lev(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

/** Pure: how near a screen text is to the text a check looks for (1 = the same after folding / translation). */
export function nearness(want: string, text: string): number {
  const a = fold(want);
  const b = fold(text);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (BILINGUAL.some(([zh, en]) => (fold(zh) === a && fold(en) === b) || (fold(en) === a && fold(zh) === b))) return 0.95;
  if (a.replace(/[^\p{L}\p{N}]/gu, '') === b.replace(/[^\p{L}\p{N}]/gu, '')) return 0.95;
  const r = 1 - lev(a, b) / Math.max(a.length, b.length);
  return b.includes(a) || a.includes(b) ? Math.max(r, 0.6 * Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.3) : r;
}

/** Pure: the top screen texts near `want` (§8.1 ③), best first, distinct. */
export function nearCandidates(want: string, texts: string[], k = 5): { text: string; score: number }[] {
  const seen = new Set<string>();
  return texts
    .filter((t) => t && !seen.has(t) && seen.add(t))
    .map((text) => ({ text, score: Math.round(nearness(want, text) * 100) / 100 }))
    .filter((c) => c.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ---------------------------------------------------------------- the check at a path

type Sub = Envelope['subcases'][number];
type AnyCheck = { kind?: string; match?: { contains?: string; exact?: string; regex?: string }; expect?: string; scope?: unknown };

/** Pure: the check a failure path names, with the pointer to it. */
export function checkAt(sc: Sub, path: string): { check: AnyCheck; pointer: string } | undefined {
  const p = sc.plan as Record<string, any>;
  const ptr = (rest: string) => `${toPointer(sc.sub, '')}/${rest}`;
  let m = path.match(/^baseline\[(\d+)\]$/);
  if (m && p.baseline?.[+m[1]]) return { check: p.baseline[+m[1]], pointer: ptr(`baseline/${m[1]}`) };
  m = path.match(/^(actions|afterCheck|setup|prepare)\[(\d+)\](?:\.expect)?$/);
  if (m && p[m[1]]?.[+m[2]]?.expect?.check) return { check: p[m[1]][+m[2]].expect.check, pointer: ptr(`${m[1]}/${m[2]}/expect/check`) };
  if (path === 'prepareCheck' && p.prepareCheck) return { check: p.prepareCheck, pointer: ptr('prepareCheck') };
  m = path.match(/^prepareChecks\[(\d+)\]$/);
  if (m && p.prepareChecks?.[+m[1]]) return { check: p.prepareChecks[+m[1]], pointer: ptr(`prepareChecks/${m[1]}`) };
  return undefined;
}

/** Pure: the text a check looks for (match.contains / exact). */
const wanted = (k: AnyCheck) => k.match?.contains ?? k.match?.exact;

// ---------------------------------------------------------------- ⑤ the judgment guard and the scope

/** Pure: does an op change what counts as reproduction (§8.1 ⑤ 3)? The phenomenon check at oracle.at (or its
 *  removal), the oracle itself, understanding, quotes. */
export function touchesJudgment(env: Envelope, op: PatchOp): string | undefined {
  if (/^\/(understanding|quotes)(\/|$)/.test(op.path)) return '改了 understanding / quotes';
  const m = op.path.match(/^\/subcases\/([^/]+)\/(oracle|plan)(?:\/(.*))?$/);
  if (!m) return undefined;
  if (m[2] === 'oracle') return '改了 oracle（判定依据）';
  const sc = env.subcases.find((s) => s.sub === m[1]);
  const rest = m[3] ?? '';
  const acts = ((sc?.plan as any)?.actions ?? []) as { expect?: { role?: string } }[];
  const a = rest.match(/^actions\/(\d+)(\/.*)?$/);
  if (a && acts[+a[1]]?.expect?.role === 'phenomenon' && (a[2] === undefined ? op.op !== 'add' : /^\/expect/.test(a[2]))) return `改了 actions[${a[1]}] 的现象检查`;
  if (rest === 'actions' || rest === '') return '整体替换了动作序列';
  return undefined;
}

/** Pure: the paths a repair may touch for a failure at `path` (§8.1 ④ 可改范围), as pointer prefixes. */
export function scopeOf(sub: string, path: string): string[] {
  const at = (p: string) => toPointer(sub, p);
  const out = [toPointer(sub, '').replace(/\/plan$/, '/trace')];
  let m = path.match(/^(baseline|afterCheck|prepareChecks)\[\d+\]/);
  if (m) return [...out, at(m[1])];
  m = path.match(/^actions\[(\d+)\]/);
  if (m) return [...out, at(`actions[${m[1]}]`)];
  m = path.match(/^(setup|prepare)\[(\d+)\]/);
  if (m) return [...out, at(`${m[1]}[${m[2]}]`), ...(+m[2] > 0 ? [at(`${m[1]}[${+m[2] - 1}]`)] : []), at('targets'), at('prepareCheck'), at('prepareChecks')];
  if (/^prepareCheck/.test(path)) return [...out, at('prepare'), at('prepareCheck'), at('prepareChecks')];
  m = path.match(/^targets\.([\w-]+)/);
  if (m) return [...out, at(`targets.${m[1]}`), at('setup')];
  return [...out, at('')];
}

/** Pure: ops outside the scope. */
export const outOfScope = (ops: PatchOp[], scope: string[]) => ops.filter((o) => !scope.some((s) => o.path === s || o.path.startsWith(`${s}/`)));

// ---------------------------------------------------------------- ③½ deterministic fix

export interface Fix {
  source: 'auto-fix' | 'patch';
  ops: PatchOp[];
  reason: string;
  /** Model diagnosis (patch only). */
  diagnosis?: { category: string; text: string };
  scopeReason?: string | null;
}

/** Pure: a fix without the model, or undefined (§8.1 ③½). */
export function deterministicFix(env: Envelope, sub: string, fp: FailurePoint, evidence?: { page: string; texts: { t: string }[] }): Fix | undefined {
  const sc = env.subcases.find((s) => s.sub === sub);
  if (!sc || !evidence || fp.cause !== 'plan') return undefined;
  const at = checkAt(sc, fp.path);
  if (!at || at.check.kind !== 'text') return undefined;
  const want = wanted(at.check);
  if (!want || /\{token\}|\{round\}/.test(want)) return undefined;
  const key = at.check.match?.contains !== undefined ? 'contains' : 'exact';
  const guard = (ops: PatchOp[]) => !ops.some((o) => touchesJudgment(env, o));
  const texts = evidence.texts.map((x) => x.t);
  // One clearly-near text: same after case / width / spaces, or the other language's word.
  const c = nearCandidates(want, texts);
  if (c[0] && c[0].score >= 0.9 && !(c[1] && c[1].score >= 0.9 && fold(c[1].text) !== fold(c[0].text)) && fold(c[0].text) !== fold(want)) {
    const ops: PatchOp[] = [{ op: 'replace', path: `${at.pointer}/match`, value: { [key]: c[0].text } }];
    if (guard(ops)) return { source: 'auto-fix', ops, reason: `${fp.path}：屏上没有「${want}」，只有一条高相似的「${c[0].text}」（${c[0].score}）` };
  }
  // A restore check: the page it lands on is known — use that page's own anchor text that is on screen.
  if (/^afterCheck\[/.test(fp.path) && evidence.page !== 'unknown') {
    const rule = TEAMILY_PAGES.find((r) => r.id === evidence.page);
    const anchors = rule ? [...rule.anchors.zh, ...rule.anchors.en].filter((a): a is string => typeof a === 'string') : [];
    const on = anchors.find((a) => texts.some((t) => fold(t) === fold(a)));
    if (on) {
      const ops: PatchOp[] = [{ op: 'replace', path: `${at.pointer}/match`, value: { contains: on } }];
      if (guard(ops)) return { source: 'auto-fix', ops, reason: `${fp.path}：复位后在「${rule!.name}」页，屏上没有「${want}」，改用这一页的标志文字「${on}」` };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- ④ ask for ops

export const REPAIR_FORMAT = `# 修补（只改坏掉的那一步）

计划在预热（或准备）时停在了下面的「失败点」。不要重写计划，只给出修改：
{
  "diagnosis": { "category": "对象 | 触发 | 观察位置 | 区分度 | 环境替代 | 缺积木 | 执行端", "text": "一句话" },
  "ops": [{ "op": "replace | add | remove", "path": "/subcases/<sub>/plan/baseline/0/match", "value": { } }],
  "reason": "为什么这样改",
  "scopeReason": null
}
- path 是 JSON 指针，子用例按名字定位，targets 按 id 定位。只能改「可改范围」里的路径；超出范围要在 scopeReason 写理由。
- 检查要找的文字只能用「失败时的屏幕文字」或「真实页面上的文字」里出现过的，或者计划自己构造的文字（{token}）。
- 诊断是「缺积木」或「执行端」时 ops 留空：计划不改，由人或积木修复处理。
- 不要改 oracle、understanding、quotes，也不要改 oracle.at 指向的现象检查：那是「什么算复现」，只能由人改。`;

/** Pure: one line per step (path: what it is) — the structure of the rest of the plan. */
export function planOutline(plan: Record<string, any>): string {
  const step = (a: any) => (a?.type === 'node' ? `node ${a.node?.name}` : `${a?.type}${a?.element ? ` ${a.element}` : ''}${a?.value ? ` "${String(a.value).slice(0, 30)}"` : ''}`) + (a?.expect ? `（expect ${a.expect.role}: ${a.expect.check?.kind}）` : '');
  const out: string[] = [];
  for (const t of plan.targets ?? []) out.push(`targets.${t.id}: ${t.kind}`);
  for (const key of ['setup', 'prepare', 'actions', 'afterCheck']) (plan[key] ?? []).forEach((a: any, i: number) => out.push(`${key}[${i}]: ${step(a)}`));
  (plan.baseline ?? []).forEach((k: any, i: number) => out.push(`baseline[${i}]: ${k.kind} ${JSON.stringify(k.match ?? k.expect ?? '').slice(0, 60)}`));
  return out.join('\n');
}

/** Pure: the failing section and its neighbours, verbatim. */
export function sectionOf(plan: Record<string, any>, path: string): Record<string, unknown> {
  const m = path.match(/^(\w+)\[(\d+)\]/);
  if (m && Array.isArray(plan[m[1]])) {
    const i = +m[2];
    return Object.fromEntries(plan[m[1]].map((x: unknown, j: number) => [`${m[1]}[${j}]`, x]).filter((_: unknown, j: number) => Math.abs(j - i) <= 1));
  }
  const t = path.match(/^targets\.([\w-]+)/);
  if (t) return { [`targets.${t[1]}`]: (plan.targets ?? []).find((x: any) => x.id === t[1]), setup: plan.setup };
  return { [path]: plan[path] };
}

export interface RepairInput {
  env: Envelope;
  sub: string;
  fp: FailurePoint;
  evidence?: { page: string; texts: { t: string; x: number; y: number }[] };
  /** The Issue lines the quotes point at (not the whole Issue). */
  quoted: string;
  /** Earlier repairs in this task (to avoid going back and forth). */
  history: { rev: number; path: string; source: string; reason: string; result: string }[];
  /** R13 warnings of the plan (texts not seen on the page). */
  warnings?: string[];
  /** Validation errors of the previous answer (the one retry). */
  errors?: string[];
}

/** Pure: the user message of a repair call. */
export function repairPrompt(x: RepairInput): string {
  const sc = x.env.subcases.find((s) => s.sub === x.sub)!;
  const at = checkAt(sc, x.fp.path);
  const want = at ? wanted(at.check) : undefined;
  return [
    '# 理解（设计时确定）', JSON.stringify(x.env.understanding), '', '# 摘录对应的原文', x.quoted, '',
    `# 子用例 ${x.sub} 的判定依据`, JSON.stringify(sc.oracle), '',
    '# 计划结构（每步一行）', planOutline(sc.plan), '',
    '# 失败的那一节（原样）', JSON.stringify(sectionOf(sc.plan, x.fp.path), null, 1), '',
    '# 失败点', `路径 ${x.fp.path}（${x.fp.phase}）；期望：${x.fp.expected}；实际：${x.fp.observed}；归因：${x.fp.basis}`, '',
    '# 可改范围', ...scopeOf(x.sub, x.fp.path).map((s) => `- ${s}`), '',
    ...(x.evidence ? [`# 失败时的屏幕文字（页面：${x.evidence.page}）`, x.evidence.texts.map((t) => `${t.t} @(${t.x},${t.y})`).join('\n'), ''] : []),
    ...(want && x.evidence ? ['# 近似候选（与检查要找的文字相近的屏幕文字）', nearCandidates(want, x.evidence.texts.map((t) => t.t)).map((c) => `- ${c.text}（${c.score}）`).join('\n') || '（没有）', ''] : []),
    ...(x.warnings?.length ? ['# 页面实录的警告（R13）', ...x.warnings.map((w) => `- ${w}`), ''] : []),
    ...(x.history.length ? ['# 本任务里此前的修补', ...x.history.map((h) => `- rev ${h.rev} @ ${h.path}（${h.source}）：${h.reason} → ${h.result}`), ''] : []),
    ...(x.errors?.length ? ['# 上一次的修改没通过校验', ...x.errors.map((e) => `- ${e}`)] : []),
  ].join('\n');
}

/** The system prompt: the SKILL's hard rules and revision section + the catalog without its schema (§8.4 ⑤). */
export function repairSystem(): string {
  const skill = readFileSync(SKILL_FILE, 'utf8');
  const rules = skill.slice(skill.indexOf('\n## 4.'), skill.indexOf('\n## 5.'));
  const rev = skill.indexOf('\n## 6.') > 0 ? skill.slice(skill.indexOf('\n## 6.')) : '';
  const cat = blockCatalog();
  return [rules.trim(), rev.trim(), cat, REPAIR_FORMAT].filter(Boolean).join('\n\n');
}

export type AskRepair = (system: string, user: string) => Promise<unknown>;

/** The model call (purpose plan-repair). */
export const defaultAskRepair: AskRepair = async (system, user) => {
  const slots: Slot[] = [
    { name: 'system', role: 'system', stable: true, content: system },
    { name: 'repair', role: 'user', content: user },
  ];
  const r = await modelCall({ purpose: 'plan-repair', slots, timeoutMs: 120_000, correct: true });
  return r.ok ? r.value : undefined;
};

/** Pure: a model answer → a Fix (or why not). */
export function fixFromAnswer(ans: unknown): Fix | { stop: string } {
  const a = ans as { diagnosis?: { category?: string; text?: string }; ops?: PatchOp[]; reason?: string; scopeReason?: string | null } | undefined;
  if (!a || typeof a !== 'object') return { stop: '模型没有返回可解析的修补' };
  const cat = String(a.diagnosis?.category ?? '');
  if (/缺积木|执行端/.test(cat)) return { stop: `模型诊断为「${cat}」：${a.diagnosis?.text ?? ''}` };
  if (!Array.isArray(a.ops) || !a.ops.length) return { stop: `模型没有给出修改（${cat || '无诊断'}：${a.diagnosis?.text ?? ''}）` };
  return { source: 'patch', ops: a.ops, reason: String(a.reason ?? a.diagnosis?.text ?? '模型修补'), diagnosis: { category: cat, text: String(a.diagnosis?.text ?? '') }, scopeReason: a.scopeReason ?? null };
}

/** Pure: the reasons a fix may not be applied automatically (judgment guard; scope without a reason). */
export function blockers(env: Envelope, sub: string, path: string, f: Fix): string[] {
  const out: string[] = [];
  for (const o of f.ops) {
    const j = touchesJudgment(env, o);
    if (j) out.push(`判定保护：${o.path} ${j}`);
  }
  const off = outOfScope(f.ops, scopeOf(sub, path));
  if (off.length && !f.scopeReason) out.push(`超出可改范围且没写理由：${off.map((o) => o.path).join('、')}`);
  return out;
}

// ---------------------------------------------------------------- ⑦ continue or stop

export interface RepairStep {
  rev: number;
  hash?: string;
  path: string;
  source: Fix['source'];
  reason: string;
  /** The run after this repair: where it failed next, or passed. */
  result?: string;
}

/** Pure: after a run of the repaired plan — continue repairing, or stop and why (§8.1 ⑦). */
export function nextMove(history: RepairStep[], fp: FailurePoint | undefined, hash: string | undefined, oldHashes: string[]): { go: true } | { go: false; why: string } {
  if (!fp) return { go: false, why: '预热通过' };
  if (fp.cause !== 'plan' && fp.cause !== 'uncertain') return { go: false, why: `归因为${fp.cause === 'executor' ? '执行端' : '环境'}，不改计划` };
  if (hash && oldHashes.includes(hash)) return { go: false, why: '修补把计划改回了之前的某个 rev（来回改）' };
  const last = history.at(-1);
  if (!last) return { go: true };
  const same = history.filter((h) => h.path === fp.path).length;
  if (same >= 2) return { go: false, why: `同一路径 ${fp.path} 已修补 2 次仍失败` };
  if (fp.path !== last.path && pathRank(fp.path) < pathRank(last.path)) return { go: false, why: `失败点往前退了（${last.path} → ${fp.path}）` };
  return { go: true };
}

/** Pure: the repair case written to the memory service's Skill library after a verified repair (W7-R13). */
export function repairCase(issue: string, sub: string, steps: RepairStep[], fp: FailurePoint): { name: string; description: string; content: string } {
  const name = `repair-${issue}-${sub}-${fp.path.replace(/[^\w]+/g, '-')}`.replace(/-+$/, '');
  return {
    name,
    description: `Issue ${issue} ${sub}：${fp.path} 失败（${fp.observed.slice(0, 80)}）→ 局部修补后预热通过`,
    content: [`# 修补案例 ${issue}/${sub}`, '', `- 失败点：${fp.path}（${fp.phase}）`, `- 实际：${fp.observed}`, `- 归因：${fp.basis}`, '', '## 修补', ...steps.map((s) => `- rev ${s.rev}（${s.source}）@ ${s.path}：${s.reason} → ${s.result ?? '-'}`)].join('\n'),
  };
}
