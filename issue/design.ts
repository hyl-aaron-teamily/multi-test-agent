// Leaner Issue design (W3-6 §8.4 ③④⑤, D11): fewer output tokens and fewer whole re-deliveries.
//  ⑤ the Issue is shown with line numbers (comments dropped, images as [图n]); quotes are written as line ranges
//    and expanded from the original lines by the executor — always verbatim, and the model does not copy text;
//    no selfCheck (the validator checks the rules), at most 3 risks.
//  ④ two stages: (1) understanding + feasibility + the blocks it will use, with only the understanding part of
//    the SKILL and a one-line list of blocks; unknown blocks → needs-block, decided by rule, nothing more is
//    asked; (2) only when plannable: the plan, with the full specs of the chosen blocks only.
//  ③ a delivery that fails validation is not redone: the failing sub-cases and their error paths go back, the
//    model answers with ops (issue/record.ts patch format) and only those are applied.
// A revision (v2+, previous delivery + run evidence) stays one call (issue/author.ts).
import { readFileSync } from 'node:fs';
import { NODE_SPECS } from '../skills/teamily/node-specs';
import { ELEMENTS, REGIONS } from '../skills/teamily/vocab';
import { OBSERVATIONS } from '../engine/observe';
import { blockCatalog } from './catalog';
import type { Authored, AuthorContext, AskMeta, Envelope } from './author';
import { compile, EnvelopeZ, SKILL_FILE } from './author';
import { applyOps, type PatchOp } from './record';

// ---------------------------------------------------------------- ⑤ numbered Issue, quotes by line

/** Pure: the Issue as the model reads it — `L<n> <text>` per non-empty line, HTML comments dropped, images as
 *  [图n]. Line numbers are the original file's, so a range expands to the original text. */
export function numberedIssue(raw: string): string {
  const out: string[] = [];
  let inComment = false;
  let img = 0;
  raw.split(/\r?\n/).forEach((line, i) => {
    let l = line;
    if (inComment) {
      const e = l.indexOf('-->');
      if (e < 0) return;
      l = l.slice(e + 3);
      inComment = false;
    }
    l = l.replace(/<!--[\s\S]*?-->/g, '');
    const s = l.indexOf('<!--');
    if (s >= 0) {
      l = l.slice(0, s);
      inComment = true;
    }
    l = l.replace(/!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>/gi, () => `[图${++img}]`).trimEnd();
    if (l.trim()) out.push(`L${i + 1} ${l}`);
  });
  return out.join('\n');
}

/** Pure: "L12-L14" / "L7" → the original lines (1-based, inclusive), joined; undefined when out of range. */
export function linesText(raw: string, range: string): string | undefined {
  const m = range.trim().match(/^L?(\d+)(?:\s*-\s*L?(\d+))?$/i);
  if (!m) return undefined;
  const lines = raw.split(/\r?\n/);
  const a = Number(m[1]);
  const b = Number(m[2] ?? m[1]);
  if (a < 1 || b < a || b > lines.length) return undefined;
  const t = lines.slice(a - 1, b).join('\n').trim();
  return t || undefined;
}

/** Pure: quotes written as `{id, lines}` become `{id, text}` (text kept when given). Unexpandable → error. */
export function expandQuotes(quotes: unknown, raw: string): { quotes: { id: string; text: string; lines?: string }[]; errors: string[] } {
  const errors: string[] = [];
  const out: { id: string; text: string; lines?: string }[] = [];
  for (const q of Array.isArray(quotes) ? quotes : []) {
    const id = String(q?.id ?? `q${out.length + 1}`);
    if (typeof q?.text === 'string' && q.text.trim()) out.push({ id, text: q.text, ...(q.lines ? { lines: String(q.lines) } : {}) });
    else if (q?.lines) {
      const t = linesText(raw, String(q.lines));
      if (t) out.push({ id, text: t, lines: String(q.lines) });
      else errors.push(`quotes.${id}: lines "${q.lines}" is not a line range of the Issue (L<n> or L<a>-L<b>)`);
    } else errors.push(`quotes.${id}: needs lines (e.g. "L12-L14")`);
  }
  return { quotes: out, errors };
}

// ---------------------------------------------------------------- ④ stage 1

/** Pure: the block list of stage 1 — the catalog without its JSON Schema section (Node inputs and kinds are
 *  kept: judging feasibility needs to know what a Node can do, e.g. sendMessage kind=markdown-link). */
export function blockNames(): string {
  const c = blockCatalog();
  const i = c.indexOf('\n## 字段格式');
  return (i > 0 ? c.slice(0, i) : c).replace(/\n- `teamily\.login`[^\n]*/, '');
}

/** The SKILL up to its hard rules (§1–§4): what stage 1 needs to understand and judge feasibility. */
export function skillUnderstanding(skill = readFileSync(SKILL_FILE, 'utf8')): string {
  const i = skill.indexOf('\n## 5.');
  return i > 0 ? skill.slice(0, i) : skill;
}

export const STAGE1_FORMAT = `# 第一段交付（只做理解和可行性）

只输出一个 JSON 对象：
{
  "quotes": [{ "id": "q1", "lines": "L12-L14" }],
  "understanding": { "subject": "", "trigger": "", "phenomenon": "", "expected": "", "frequency": "always | intermittent | unknown", "control": "", "basis": ["q1"] },
  "feasibility": { "status": "plannable | needs-block | unconstructible", "missing": [{ "kind": "node | element | target | observation | precondition", "need": "", "basis": ["q2"] }] },
  "blocks": ["teamily.openConversation", "chat.composer", "text"]
}
- quotes 写行号（原文每行前面的 L 编号），执行器按行号取出原文，不要抄写原文。
- blocks：计划会用到的 Node、固定元素、参考区域（写成 page/region）的名字，必须来自积木目录；目录里没有的，写进 feasibility.missing 并把 status 写成 needs-block。
- 不可执行（needs-block / unconstructible）就到此为止。`;

export const STAGE2_NOTE = `# 第二段交付（计划）

理解、可行性和原文摘录已经确定（见下面「第一段结果」，不要改）。只输出：
{ "subcases": [ …§5.1 的子用例… ], "risks": ["最多 3 条，每条一句"] }
- trace 引用第一段的片段编号；不写 selfCheck（规则由校验器检查）。`;

const KNOWN = () => new Set([...NODE_SPECS.map((n) => n.name), ...ELEMENTS.map((e) => e.id), ...REGIONS.map((r) => `${r.page}/${r.region}`), ...Object.keys(OBSERVATIONS)]);

/** Pure: the Nodes / elements / regions stage 1 chose that the catalog does not have (a rule decides needs-block).
 *  Bare words (primitives, target kinds, observations) are left to the stage-2 validator. */
export function unknownBlocks(blocks: unknown): string[] {
  const k = KNOWN();
  return (Array.isArray(blocks) ? blocks.map(String) : []).map((b) => b.replace(/^element:/, '')).filter((b) => /[./]/.test(b) && !k.has(b));
}

/** Pure: the catalog with only the chosen Nodes (the rest of it — elements, regions, observations, schemas — is
 *  small and needed for any plan). */
export function catalogFor(blocks: string[]): string {
  const keep = new Set(blocks);
  const lines = blockCatalog().split('\n');
  return lines.filter((l) => !/^- `teamily\.[\w]+`/.test(l) || keep.has(l.match(/^- `([^`]+)`/)?.[1] ?? '')).join('\n');
}

/** Pure: the user message of a stage (Issue numbered + the executor's conditions + stage-1 result for stage 2). */
export function stagePrompt(base: string, cx: AuthorContext, stage1?: unknown): string {
  // `base` is userPrompt(cx) of issue/author.ts: swap the verbatim Issue for the numbered one.
  const head = `# Issue ${cx.issue.id}（原文，逐字）\n${cx.raw}`;
  const numbered = `# Issue ${cx.issue.id}（原文，按行编号；摘录写行号）\n${numberedIssue(cx.raw)}`;
  const body = base.startsWith(head) ? numbered + base.slice(head.length) : `${numbered}\n\n${base}`;
  return stage1 ? `${body}\n\n# 第一段结果（已确定）\n${JSON.stringify(stage1)}` : body;
}

type Ask = (system: string, user: string, images: AuthorContext['issue']['images'], meta?: AskMeta) => Promise<unknown>;

export interface TwoStageDeps {
  ask: Ask;
  userPrompt: (cx: AuthorContext) => string;
  logs: AskMeta['logs'];
}

/** Two stages, then (if needed) one ops-only fix. Calls: 1 (not plannable), 2, or 3. */
export async function authorTwoStage(cx: AuthorContext, d: TwoStageDeps): Promise<Authored> {
  const images = cx.issue.images ?? [];
  // ---- stage 1
  const m1: AskMeta = { logs: d.logs };
  const s1 = (await d.ask(`${skillUnderstanding()}\n\n${blockNames()}\n\n${STAGE1_FORMAT}`, stagePrompt(d.userPrompt(cx), cx), images, m1)) as Record<string, any> | undefined;
  if (!s1 || typeof s1 !== 'object') return { subcases: [], errors: [m1.failure ?? '第一段没有返回可解析的 JSON'], calls: 1 };
  const q = expandQuotes(s1.quotes, cx.raw);
  const missing = unknownBlocks(s1.blocks);
  const feasibility = { status: s1.feasibility?.status ?? 'plannable', missing: Array.isArray(s1.feasibility?.missing) ? s1.feasibility.missing : [] };
  if (missing.length && feasibility.status === 'plannable') {
    feasibility.status = 'needs-block';
    feasibility.missing = [...feasibility.missing, ...missing.map((b) => ({ kind: 'node', need: `积木「${b}」不在积木目录里（第一段名单）`, basis: [] }))];
  }
  const head = { quotes: q.quotes, understanding: s1.understanding, feasibility, revision: null, selfCheck: {}, risks: [] as string[] };
  const p1 = EnvelopeZ.safeParse({ ...head, subcases: [] });
  if (!p1.success || q.errors.length) return { subcases: [], errors: [...q.errors, ...(p1.success ? [] : p1.error.issues.slice(0, 10).map((i) => `envelope ${i.path.join('.')}: ${i.message}`))], calls: 1, ...(p1.success ? { envelope: p1.data } : {}) };
  if (p1.data.feasibility.status !== 'plannable') return { envelope: p1.data, subcases: [], errors: [], calls: 1 };
  // ---- stage 2
  const blocks = (Array.isArray(s1.blocks) ? s1.blocks.map(String) : []) as string[];
  const m2: AskMeta = { logs: d.logs };
  const skill = readFileSync(SKILL_FILE, 'utf8');
  const s2 = (await d.ask(`${skill}\n\n${catalogFor(blocks)}\n\n${STAGE2_NOTE}`, stagePrompt(d.userPrompt(cx), cx, { quotes: q.quotes.map(({ id, lines }) => ({ id, lines })), understanding: p1.data.understanding, feasibility: p1.data.feasibility, blocks }), images, m2)) as Record<string, any> | undefined;
  const p2 = EnvelopeZ.safeParse({ ...head, subcases: s2?.subcases ?? [], risks: (Array.isArray(s2?.risks) ? s2!.risks : []).slice(0, 3) });
  if (!p2.success) return { envelope: p1.data, subcases: [], errors: s2 ? p2.error.issues.slice(0, 10).map((i) => `envelope ${i.path.join('.')}: ${i.message}`) : [m2.failure ?? '第二段没有返回可解析的 JSON'], calls: 2 };
  let env = p2.data;
  if (!env.subcases.length) return { envelope: env, subcases: [], errors: ['subcases: a plannable delivery needs at least one sub-case'], calls: 2 };
  let subs = compile(env, cx);
  let errors = subs.flatMap((s) => s.errors);
  if (!errors.length) return { envelope: env, subcases: subs, errors: [], calls: 2 };
  // ---- ③ ops-only fix
  const failing = env.subcases.filter((s) => subs.find((x) => x.sub === s.sub.replace(/\W+/g, '_').slice(0, 24))?.errors.length);
  const m3: AskMeta = { logs: d.logs };
  const fix = (await d.ask(`${skill}\n\n${catalogFor(blocks)}\n\n${FIX_NOTE}`, [`# 出错的子用例（只改这些）`, JSON.stringify(failing), '', '# 校验错误', ...errors.map((e) => `- ${e}`)].join('\n'), [], m3)) as { ops?: PatchOp[] } | undefined;
  if (Array.isArray(fix?.ops) && fix!.ops.length) {
    try {
      env = EnvelopeZ.parse(applyOps(env, fix!.ops));
      subs = compile(env, cx);
      errors = subs.flatMap((s) => s.errors);
    } catch (e) {
      errors = [...errors, `修改不能应用：${(e as Error).message}`];
    }
  }
  return { envelope: env, subcases: subs, errors, calls: 3 };
}

export const FIX_NOTE = `# 只改出错的地方

下面的子用例没有通过校验。不要重交整份计划，只输出修改：
{ "ops": [{ "op": "replace | add | remove", "path": "/subcases/<sub>/plan/actions/1/expect/check", "value": … }] }
path 是 JSON 指针，子用例用名字定位；不要改执行器负责的字段。`;

/** Re-exported for the envelope type users. */
export type { Envelope };
