// The plan record of an Issue (W3-6 §5, contract K2): one Issue = one plan, one version number `rev`. The
// editable source is the model's delivery (the envelope): every change — the model's delivery, a patch, a
// person's edit, a change applied from the side chat, a rollback, a redesign — is applied to it, compiled and
// validated again, and recorded as rev+1 with a snapshot (compare, roll back). A delivery that does not pass
// validation is kept as it is, with the errors on the paths they are about; a needs-block delivery keeps what
// the model wrote, with the gaps.
//
// Patch format (§8.1 ④): [{ op: 'replace' | 'add' | 'remove', path: '/subcases/<sub>/plan/actions/1/expect/check', value }]
// (JSON pointer into the envelope; a sub-case is addressed by its name).
import { readFileSync } from 'node:fs';
import type { TestPlan } from '../platform/schema/test-plan';
import { compile, EnvelopeZ, type AuthorContext, type Envelope } from './author';
import { draftHash } from './drafts';
import { issuePath } from './paths';
import { type Draft, draftOf, surfaceOf } from './planner';

export type RevSource = 'model' | 'patch' | 'human' | 'chat' | 'rollback' | 'redesign';

export interface PathError {
  /** JSON pointer into the envelope (`/subcases/main/plan/actions/1/expect/check`), or '' for the delivery. */
  path: string;
  message: string;
}

/** A sub-case as written, whether or not it compiles. */
export interface PartialSub {
  sub: string;
  /** The compiled plan when the schema accepted it (it may still fail the R-rules). */
  plan?: TestPlan;
  errors: PathError[];
}

export interface Snapshot {
  status: Draft['status'];
  reason: string;
  envelope?: Envelope;
}

export interface RevEntry {
  rev: number;
  source: RevSource;
  at: string;
  /** Paths the change touched. */
  paths: string[];
  reason: string;
  by?: string;
  snapshot: Snapshot;
}

export interface ChatEntry {
  role: 'user' | 'model';
  text: string;
  at: string;
  /** model: a suggested change (applied only when a person clicks 「应用」, D3). */
  ops?: PatchOp[];
  /** The rev the suggestion was made against / applied as. */
  rev?: number;
  applied?: number;
}

export interface PatchOp {
  op: 'replace' | 'add' | 'remove';
  path: string;
  value?: unknown;
}

/** Record fields carried by a Draft (stored in platform/plans/drafts/<issue>.json). */
export interface RecordFields {
  rev?: number;
  revs?: RevEntry[];
  chat?: ChatEntry[];
  /** Sub-cases with errors (status unplannable with partial = 校验未过). */
  partial?: PartialSub[];
  /** Missing blocks of a needs-block delivery. */
  gaps?: { kind: string; need: string }[];
}

export type PlanRecord = Draft & RecordFields;

/** Executor-owned plan fields (SKILL §5.2): never patched. */
const EXECUTOR_FIELDS = new Set(['id', 'issueRef', 'category', 'surface', 'env', 'limits', 'verdictRule', 'provenance', 'issueSurfaces', 'audit', 'contract', 'coverage', 'substitution']);

// ---------------------------------------------------------------- state words

export type RecordState = '可运行' | '校验未过' | '缺积木' | '无法构造' | '待重写';

export function stateOf(r: PlanRecord): RecordState {
  if (r.stale) return '待重写';
  if (r.status === 'plannable') return '可运行';
  if (r.status === 'needs-block') return '缺积木';
  return r.partial?.length ? '校验未过' : '无法构造';
}

// ---------------------------------------------------------------- paths

/** Pure: an error text of the validator → the path it is about (in the sub-case's plan) and the message. */
export function errorPath(sub: string, e: string): PathError {
  const text = e.replace(/^subcases\[[^\]]+\]\s*(\.plan\s*)?/, '').replace(/^(R\d+)\s+/, '$1 ');
  const m = text.match(/^(?:(R\d+) )?((?:targets\.[\w-]+|[a-zA-Z]+)(?:\[\d+\]|\.\d+|\.[a-zA-Z]+)*)(?:\s*:| "[^"]*"\s*:?)/);
  if (!m) return { path: `/subcases/${sub}/plan`, message: e };
  const segs = m[2].replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  // `oracle.at` lives on the sub-case, not in its plan; `check` / `prepareCheck` texts without an index name the field.
  if (segs[0] === 'oracle') return { path: `/subcases/${sub}/${segs.join('/')}`, message: e };
  return { path: `/subcases/${sub}/plan/${segs.join('/')}`, message: e };
}

const unescape = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~');

/** Pure: apply ops to a copy of the envelope. Sub-cases are addressed by name. Throws on a bad path. */
export function applyOps(env: Envelope, ops: PatchOp[]): Envelope {
  const out = JSON.parse(JSON.stringify(env)) as Envelope;
  for (const o of ops) {
    if (!['replace', 'add', 'remove'].includes(o.op)) throw new Error(`op「${o.op}」：只能是 replace / add / remove`);
    const segs = o.path.split('/').slice(1).map(unescape);
    if (!segs.length) throw new Error('path 不能为空');
    if (segs[0] === 'subcases' && segs[1] !== undefined && !/^\d+$/.test(segs[1])) {
      const i = out.subcases.findIndex((s) => s.sub === segs[1]);
      if (i < 0) throw new Error(`${o.path}：没有子用例 ${segs[1]}`);
      segs[1] = String(i);
    }
    if (segs[0] === 'subcases' && segs[2] === 'plan' && segs[3] && EXECUTOR_FIELDS.has(segs[3])) throw new Error(`${o.path}：${segs[3]} 由执行器负责，不能修改`);
    let cur: any = out;
    for (const s of segs.slice(0, -1)) {
      if (cur === null || typeof cur !== 'object' || !(s in cur)) throw new Error(`${o.path}：路径不存在（在「${s}」处）`);
      cur = cur[s];
    }
    const last = segs[segs.length - 1];
    if (Array.isArray(cur)) {
      const i = last === '-' ? cur.length : Number(last);
      if (!Number.isInteger(i) || i < 0 || i > cur.length || (o.op !== 'add' && i >= cur.length)) throw new Error(`${o.path}：下标 ${last} 越界`);
      if (o.op === 'add') cur.splice(i, 0, o.value);
      else if (o.op === 'remove') cur.splice(i, 1);
      else cur[i] = o.value;
    } else if (cur && typeof cur === 'object') {
      if (o.op === 'remove') delete cur[last];
      else if (o.op === 'replace' && !(last in cur)) throw new Error(`${o.path}：没有字段 ${last}（新增用 add）`);
      else cur[last] = o.value;
    } else throw new Error(`${o.path}：父级不是对象或数组`);
  }
  return out;
}

// ---------------------------------------------------------------- compile with errors kept

/** The author context of a saved draft (to compile its envelope again). */
export function contextOf(d: Draft, rev: number, raw?: string): AuthorContext {
  const { surface, subst } = surfaceOf(d.issue, d.classification);
  return { issue: d.issue, raw: raw ?? readFileSync(issuePath(d.issue.id), 'utf8'), surface: d.subcases[0]?.surface ?? surface, env: (d.env as 'test' | 'prod') ?? 'prod', category: d.classification.category as TestPlan['category'], version: rev, substitution: subst ? { from: subst.from, to: surface, reason: subst.reason } : undefined };
}

/** Pure: an envelope → the draft fields it gives (plannable, or kept with errors / gaps). */
export function compileRecord(base: Draft, env: Envelope, cx: AuthorContext): Pick<PlanRecord, 'status' | 'reason' | 'subcases' | 'partial' | 'gaps' | 'envelope' | 'errors'> {
  const parsed = EnvelopeZ.safeParse(env);
  if (!parsed.success) {
    const errors = parsed.error.issues.slice(0, 20).map((i) => ({ path: `/${i.path.join('/')}`, message: `envelope ${i.path.join('.')}: ${i.message}` }));
    return { status: 'unplannable', reason: `校验未过：${errors.map((e) => e.message).slice(0, 3).join('；')}`, subcases: [], partial: [{ sub: '(交付)', errors }], envelope: env, errors: errors.map((e) => e.message) };
  }
  const e = parsed.data;
  if (e.feasibility.status === 'needs-block') {
    const gaps = e.feasibility.missing.map((m) => ({ kind: m.kind, need: m.need }));
    return { status: 'needs-block', reason: `缺积木：${gaps.map((m) => `${m.kind}「${m.need}」`).join('；') || '（模型未写明）'}`, subcases: [], partial: e.subcases.length ? compileSubs(e, cx) : [], gaps, envelope: e };
  }
  if (e.feasibility.status === 'unconstructible') return { status: 'unplannable', reason: `前置条件黑盒无法构造：${e.feasibility.missing.map((m) => m.need).join('；') || e.understanding.phenomenon}`, subcases: [], envelope: e };
  if (!e.subcases.length) return { status: 'unplannable', reason: '校验未过：可执行的交付至少要有一个子用例', subcases: [], partial: [{ sub: '(交付)', errors: [{ path: '/subcases', message: 'subcases: a plannable delivery needs at least one sub-case' }] }], envelope: e };
  const subs = compileSubs(e, cx);
  if (subs.some((s) => s.errors.length || !s.plan)) {
    const n = subs.reduce((k, s) => k + s.errors.length, 0);
    const all = subs.flatMap((s) => s.errors.map((x) => x.message));
    return { status: 'unplannable', reason: `校验未过（${n} 处，${subs.filter((s) => s.errors.length).map((s) => s.sub).join('、')}）：${all.slice(0, 6).join('；')}`, subcases: [], partial: subs, envelope: e, errors: all };
  }
  const d = draftOf(base.issue, base.classification, { envelope: e, subcases: subs.map((s) => ({ sub: s.sub, plan: s.plan, errors: [] })), errors: [], calls: 0 }, cx, surfaceOf(base.issue, base.classification).subst);
  return { status: d.status, reason: d.reason, subcases: d.subcases, partial: undefined, gaps: undefined, envelope: e, errors: undefined };
}

function compileSubs(e: Envelope, cx: AuthorContext): PartialSub[] {
  return compile(e, cx).map((s) => ({ sub: s.sub, ...(s.plan ? { plan: s.plan } : {}), errors: s.errors.map((x) => errorPath(s.sub, x)) }));
}

// ---------------------------------------------------------------- revisions

export const revOf = (r: PlanRecord) => r.rev ?? r.version ?? 1;

/** A saved draft from before W3-6 → a record (rev = its draft version; the first rev entry = what is there). */
export function asRecord(d: Draft): PlanRecord {
  const r = d as PlanRecord;
  if (r.revs?.length) return r;
  const rev = revOf(r);
  return { ...r, rev, revs: [{ rev, source: 'model', at: r.history?.at(-1) ? new Date().toISOString() : new Date(0).toISOString(), paths: [], reason: '迁移：W3-6 之前的草稿', snapshot: { status: r.status, reason: r.reason, envelope: r.envelope } }], chat: r.chat ?? [] };
}

/** Pure: the next record after a change (rev+1, a history entry with the snapshot; hash and plan ids follow rev). */
export function nextRecord(prev: PlanRecord, fields: ReturnType<typeof compileRecord>, meta: { source: RevSource; reason: string; paths?: string[]; by?: string; at?: string }): PlanRecord {
  const base = asRecord(prev);
  const rev = revOf(base) + 1;
  const at = meta.at ?? new Date().toISOString();
  const next: PlanRecord = { ...base, ...fields, rev, version: rev, stale: undefined, warmupFailures: undefined };
  if (fields.status === 'plannable') {
    next.partial = undefined;
    next.gaps = undefined;
  }
  // Plan ids carry the rev: `<issue>/<sub>:<surface>@v<rev>` — one number for a version (§5 ①).
  next.subcases = next.subcases.map((s) => ({ ...s, plan: { ...s.plan, id: s.plan.id.replace(/-v\d+$/, `-v${rev}`) } }));
  next.hash = draftHash(next);
  next.revs = [...(base.revs ?? []), { rev, source: meta.source, at, paths: meta.paths ?? [], reason: meta.reason, ...(meta.by ? { by: meta.by } : {}), snapshot: { status: next.status, reason: next.reason, envelope: next.envelope } }];
  return next;
}

/** Apply a patch (person / chat / repair): checked, compiled, recorded. Executor fields are refused. */
export function patchRecord(prev: PlanRecord, ops: PatchOp[], meta: { source: RevSource; reason: string; by?: string; raw?: string }): PlanRecord {
  if (!meta.reason.trim()) throw new Error('修改要写一句原因');
  if (!prev.envelope) throw new Error(`Issue ${prev.issue.id} 的草稿没有模型交付（envelope），不能按步骤修改：先重新设计`);
  if (!ops.length) throw new Error('没有修改');
  const env = applyOps(prev.envelope, ops);
  const fields = compileRecord(prev, env, contextOf(prev, revOf(prev) + 1, meta.raw));
  return nextRecord(prev, fields, { source: meta.source, reason: meta.reason, by: meta.by, paths: ops.map((o) => o.path) });
}

/** Roll back: the content of `rev` becomes a new rev (nothing is deleted). */
export function rollbackRecord(prev: PlanRecord, rev: number, meta: { by?: string; raw?: string } = {}): PlanRecord {
  const r = asRecord(prev);
  const old = r.revs!.find((x) => x.rev === rev);
  if (!old) throw new Error(`没有 rev ${rev}`);
  if (!old.snapshot.envelope) throw new Error(`rev ${rev} 没有可回退的内容`);
  const fields = compileRecord(r, old.snapshot.envelope, contextOf(r, revOf(r) + 1, meta.raw));
  return nextRecord(r, fields, { source: 'rollback', reason: `回退到 rev ${rev}`, by: meta.by });
}

// ---------------------------------------------------------------- diff

export interface DiffEntry {
  path: string;
  a?: unknown;
  b?: unknown;
}

/** Pure: leaf-level differences between two values (paths as JSON pointers). Arrays of steps compare by index. */
export function diffValues(a: unknown, b: unknown, path = ''): DiffEntry[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const obj = (x: unknown) => x !== null && typeof x === 'object';
  if (!obj(a) || !obj(b) || Array.isArray(a) !== Array.isArray(b)) return [{ path: path || '/', a, b }];
  const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])];
  return keys.flatMap((k) => diffValues((a as any)[k], (b as any)[k], `${path}/${k}`));
}

/** Pure: two revs compared by step — sub-cases matched by name, the diff of each plan; the delivery's
 *  understanding and feasibility too. */
export function diffRevs(r: PlanRecord, a: number, b: number): { a: number; b: number; changes: DiffEntry[] } {
  const rec = asRecord(r);
  const ea = rec.revs!.find((x) => x.rev === a)?.snapshot.envelope;
  const eb = rec.revs!.find((x) => x.rev === b)?.snapshot.envelope;
  if (!ea || !eb) throw new Error(`rev ${!ea ? a : b} 没有内容`);
  const byName = (e: Envelope) => Object.fromEntries(e.subcases.map((s) => [s.sub, s]));
  return { a, b, changes: [...diffValues(ea.understanding, eb.understanding, '/understanding'), ...diffValues(ea.feasibility, eb.feasibility, '/feasibility'), ...diffValues(byName(ea), byName(eb), '/subcases')] };
}
