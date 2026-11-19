// Issue → draft (W3-1): every Issue is read by the model and its test case designed from scratch with the
// SKILL building blocks (issue/author.ts); there are no templates and no rule-built plans. Rules only read the
// structured fields (Frequency, platforms) and reviewed manual overrides (multi-account / deferred).
import { readFileSync } from 'node:fs';
import { DEFAULT_LIMITS, type Surface, type TestPlan, verdictRuleFor } from '../platform/schema/test-plan';
import { deferredContract } from './contract';
import { SKILL_VERSION } from '../skills/teamily/vocab';
import { AVAILABLE, type Classification, classify } from './classify';
import type { NormalizedIssue } from './parse';
import type { IssueContract } from '../platform/schema/contract';
import { validatePlan } from './validate';
import { author, type Authored, type AuthorContext, type Envelope, MAX_PLAN_VERSIONS, type RevisionMaterials } from './author';
import { issuePath } from './paths';
import { compileRecord } from './record';

export interface SubCase {
  sub: string;
  title: string;
  /** Surface the plan runs on. */
  surface: Surface;
  /** Set when the Issue's own platform is not available: needs one-time user approval. */
  substitution?: { from: string; to: Surface; reason: string; alternatives: Surface[] };
  plan: TestPlan;
  planErrors: string[];
  /** Intent contract of the sub-case (P2). */
  contract?: IssueContract;
}

/** One plan version's outcome (W3-1 §8.1): executability and reproduction rate, kept across revisions. */
export interface VersionRecord {
  version: number;
  planIds: string[];
  taskIds: string[];
  validated: boolean;
  warmup: 'passed' | 'failed' | 'not-run';
  /** drift / (valid + drift). */
  driftRate?: number;
  valid: number;
  hits: number;
  wilson?: [number, number];
  conclusion: string;
  /** Why the next version was made (the model's diagnosis), when there is one. */
  diagnosis?: string;
  /** Attribution when revisions stopped: plan / missing block / environment substitution. */
  attribution?: 'plan' | 'needs-block' | 'substitution';
}

export interface Draft {
  issue: NormalizedIssue;
  classification: Classification;
  /** Every Issue is taken (rule A3); `unplannable` = no plan could be built, the one-page report says why (E18);
   *  `needs-block` = the case needs a building block the SKILL does not have (K5) — no stand-in is used. */
  status: 'plannable' | 'unplannable' | 'needs-block';
  reason: string;
  subcases: SubCase[];
  /** Part of a plannable Issue that needs another capability (2122: the second-account part). */
  deferredPart?: string;
  /** Content hash (issue/drafts.ts) — what the user confirms. */
  hash?: string;
  /** Hash of the Issue file the draft came from. */
  issueHash?: string;
  /** Draft version (W2-3 §6.1): +1 whenever a new draft's hash differs from the saved one's. */
  version?: number;
  env?: string;
  /** Contracts of an unplannable Issue (which precondition cannot be established). */
  contracts?: IssueContract[];
  /** Warm-up failures fed back from runs (plan not executable on the current UI). */
  warmupFailures?: { planId: string; at: string; detail: string }[];
  /** The model's delivery this draft was compiled from (fed back on revision). */
  envelope?: Envelope;
  /** Plan version (W3-1: 1 = first design, +1 per revision, at most 3). */
  planVersion?: number;
  /** Validator errors when no plan could be generated. */
  errors?: string[];
  modelCalls?: number;
  /** The Issue file the draft was made from (issues/, issues/upload/, or a sample path). */
  issueFile?: string;
  /** Wall time the model spent designing this version (all calls, incl. the fix-up call), ms. */
  designMs?: number;
  /** Results of earlier plan versions of this Issue (revision history). */
  history?: VersionRecord[];
  /** Marked for rewrite (W3-1 P0): drafted by a rule template that did not match the Issue. */
  stale?: { reason: string; at: string };
}


export function substitutionOptions(issueSurfaces: string[]): { from: string; reason: string; alternatives: Surface[] } | undefined {
  const direct = issueSurfaces.some((p) => p === 'android' || p === 'web' || p === 'desktop');
  if (direct) return undefined;
  const from = issueSurfaces[0] ?? 'unknown';
  return {
    from,
    reason: `${from} 端当前无可用执行端（设备池只有 Android 真机，Web 用 Playwright）。替代为 android-app（同为原生移动端交互：长按/键盘/触控）或 mobile-web（同一 Web 代码的手机视口 + 触屏）；结论不能直接代表 ${from} 端。`,
    alternatives: ['android-app', 'mobile-web'],
  };
}

function basePlan(i: NormalizedIssue, c: Classification, sub: string, surface: Surface, env: 'test' | 'prod', title: string): TestPlan {
  const category = c.category as TestPlan['category'];
  return { id: `${i.id}${sub === 'main' ? '' : `-${sub}`}-${surface}-v1`, issueRef: i.id, title, category, surface, issueSurfaces: i.platforms, env, launch: 'once', targets: [], setup: [], prepare: [], prepareChecks: [], baseline: [], actions: [], checks: [], afterCheck: [], limits: { ...DEFAULT_LIMITS }, verdictRule: verdictRuleFor(category), provenance: { generatedBy: 'manual', skillVersion: SKILL_VERSION } };
}

/** Surface a sub-case runs on by default, and the substitution offered when the Issue's platform has none. */
export function surfaceOf(i: NormalizedIssue, c: Classification): { surface: Surface; subst?: ReturnType<typeof substitutionOptions> } {
  // Multi-client Issues (a phone platform and web / desktop): the phone App, other clients by alternating
  // logins on it (user 2026-11-09: web-surface plans are not run).
  const phone = i.platforms.some((p) => p === 'ios' || p === 'android');
  const other = i.platforms.some((p) => p === 'web' || p === 'desktop');
  if (phone && other && !i.platforms.includes('android')) {
    const s = substitutionOptions(['ios'])!;
    return { surface: 'android-app', subst: { ...s, reason: `多端 Issue（${i.platforms.join(' / ')}）在 Android App 上执行，另一端 / 另一账号用交替登录完成；iOS 端由 Android App 替代，结论不能直接代表 iOS 端。`, alternatives: ['android-app'] } };
  }
  const subst = substitutionOptions(i.platforms);
  if (subst) return { surface: 'android-app', subst };
  // The phone App first when the Issue names Android (the device pool's main surface), the desktop web otherwise.
  return { surface: c.surfaces.find((s) => AVAILABLE.includes(s) && s === 'android-app') ?? c.surfaces[0] ?? 'android-app' };
}

/** Pure: the draft of one authored delivery (status, reason, sub-cases). */
export function draftOf(i: NormalizedIssue, c: Classification, a: Authored, cx: Pick<AuthorContext, 'version' | 'surface'>, subst?: ReturnType<typeof substitutionOptions>): Draft {
  const base = { issue: i, classification: c, envelope: a.envelope, planVersion: cx.version, modelCalls: a.calls };
  const env = a.envelope;
  if (env && env.feasibility.status === 'needs-block')
    return { ...base, status: 'needs-block', reason: `缺积木：${env.feasibility.missing.map((m) => `${m.kind}「${m.need}」`).join('；') || '（模型未写明）'}`, subcases: [] };
  if (env && env.feasibility.status === 'unconstructible') return { ...base, status: 'unplannable', reason: `前置条件黑盒无法构造：${env.feasibility.missing.map((m) => m.need).join('；') || env.understanding.phenomenon}`, subcases: [] };
  if (a.errors.length || !a.subcases.length || a.subcases.some((s) => !s.plan)) return { ...base, status: 'unplannable', reason: `无法生成计划：${(a.errors.length ? a.errors : ['模型没有交付子用例']).slice(0, 6).join('；')}`, errors: a.errors, subcases: [] };
  const subcases: SubCase[] = a.subcases.map((s) => ({
    sub: s.sub,
    title: s.plan!.title,
    surface: cx.surface,
    substitution: subst ? { from: subst.from, to: cx.surface, reason: subst.reason, alternatives: subst.alternatives } : undefined,
    plan: s.plan!,
    planErrors: [],
    contract: s.plan!.contract,
  }));
  return { ...base, status: 'plannable', reason: `计划 v${cx.version}：${env!.understanding.subject} — ${env!.understanding.phenomenon}`.slice(0, 300), subcases };
}

/** Issue → draft (W3-1): rules read Frequency / platforms (K4), the model designs the case from the blocks.
 *  `raw` = the Issue file as is (read from issues/ when omitted). */
export async function draftIssue(i: NormalizedIssue, opts: { env?: 'test' | 'prod'; useModel?: boolean; raw?: string; ask?: Parameters<typeof author>[2] } = {}): Promise<Draft> {
  const env = opts.env ?? 'prod';
  const c = await classify(i);
  // Nothing to read, or a reviewed manual deferral: no plan, and the one-page report says why (E18).
  if (c.category === 'not-executable') return { issue: i, classification: c, status: 'unplannable', reason: c.reason, subcases: [] };
  if (c.category === 'multi-account') {
    const s = syncSubcase(i, c, env);
    if (typeof s === 'string') return { issue: i, classification: c, status: 'unplannable', reason: s, subcases: [], contracts: [deferredContract(i, 'multi-account', c.blockedBy)] };
    return { issue: i, classification: c, status: 'plannable', reason: `${c.reason}：${s.plan.sync!.roles.join(' + ')}，每轮一端发一条、其余端都要看到`, subcases: [s] };
  }
  if (c.category === 'deferred') return { issue: i, classification: c, status: 'unplannable', reason: c.reason, subcases: [], contracts: [deferredContract(i, c.category, c.blockedBy)] };
  const cat: TestPlan['category'] = c.category === 'bug-always' ? 'bug-always' : 'bug-intermittent';
  const cls = { ...c, category: cat };
  if (opts.useModel === false && !opts.ask) return { issue: i, classification: cls, status: 'unplannable', reason: '无法生成计划：W3-1 起计划由模型从原文设计，--no-model 不再有规则模板可用', subcases: [] };
  const { surface, subst } = surfaceOf(i, cls);
  const raw = opts.raw ?? readFileSync(issuePath(i.id), 'utf8');
  const cx: AuthorContext = { issue: i, raw, surface, env, category: cat, version: 1, substitution: subst ? { from: subst.from, to: surface, reason: subst.reason } : undefined };
  const t0 = Date.now();
  const a = await author(cx, {}, opts.ask);
  const d = keepPartial(draftOf(i, cls, a, cx, subst), a, cx);
  d.designMs = Date.now() - t0;
  return d;
}

/** W3-6 §5 ③: a delivery that fails validation (or needs a block) is kept with its errors / gaps by path. */
function keepPartial(d: Draft, a: Authored, cx: AuthorContext): Draft {
  if (d.status === 'plannable' || !a.envelope) return d;
  const r = compileRecord(d, a.envelope, cx);
  // Delivery-level errors (e.g. a revision without `revision`) stay errors even when the sub-cases compile.
  const own = a.errors.filter((e) => !/^subcases\[/.test(e));
  if (r.status === 'plannable' && own.length) return Object.assign(d, { status: 'unplannable' as const, reason: `校验未过：${own.slice(0, 6).join('；')}`, subcases: [], partial: [{ sub: '(交付)', errors: own.map((message) => ({ path: '', message })) }], errors: a.errors });
  return Object.assign(d, r);
}

/** Next plan version from run evidence (W3-1 §8.2). Returns undefined when no revision is allowed. */
export async function reviseIssue(prev: Draft, m: RevisionMaterials, opts: { raw?: string; ask?: Parameters<typeof author>[2] } = {}): Promise<Draft | undefined> {
  const version = (prev.planVersion ?? 1) + 1;
  if (version > MAX_PLAN_VERSIONS || !prev.envelope || prev.status !== 'plannable') return undefined;
  const i = prev.issue;
  const { surface, subst } = surfaceOf(i, prev.classification);
  const raw = opts.raw ?? readFileSync(issuePath(i.id), 'utf8');
  const cx: AuthorContext = { issue: i, raw, surface, env: (prev.env as 'test' | 'prod') ?? 'prod', category: prev.classification.category as TestPlan['category'], version, substitution: subst ? { from: subst.from, to: surface, reason: subst.reason } : undefined };
  const t0 = Date.now();
  const a = await author(cx, { previous: prev.envelope, materials: m }, opts.ask);
  const d = keepPartial(draftOf(i, prev.classification, a, cx, subst), a, cx);
  d.designMs = Date.now() - t0;
  d.history = [...(prev.history ?? [])];
  return d;
}

/** Issue platform words → the surfaces a multi-role plan uses (iOS → the Android app, desktop client → Edge). */
const ROLE_OF: [RegExp, Surface][] = [[/android|ios|iphone|mobile app|app/i, 'android-app'], [/web|browser|desktop|mac|windows/i, 'desktop-web']];

/** A multi-account Issue whose observable is "the message shows on every client" → one multi-role sub-case
 *  (§6); a forward / other operation the SKILL has no Node for → the reason it cannot be planned (E18). */
export function syncSubcase(i: NormalizedIssue, c: Classification, env: 'test' | 'prod'): SubCase | string {
  const text = `${i.summary} ${i.steps.join(' ')}`;
  if (/forward|转发/i.test(text)) return '需要「转发」操作：SKILL 里还没有转发 Node，多端协同计划只能发普通消息；补上转发 Node 后重新生成草稿';
  const roles = [...new Set(i.platforms.flatMap((p) => ROLE_OF.filter(([re]) => re.test(p)).map(([, s]) => s)))];
  for (const s of ['desktop-web', 'android-app'] as Surface[]) if (roles.length < 2 && !roles.includes(s)) roles.push(s);
  const cat = { ...c, category: (/always|必现|100%/i.test(i.frequency) ? 'bug-always' : 'bug-intermittent') as Classification['category'] };
  const plan: TestPlan = { ...basePlan(i, cat, 'sync', roles[0], env, `多端同步：${roles.join(' + ')}`), sync: { roles, rounds: 3 } };
  const v = validatePlan(plan);
  return { sub: 'sync', title: `多端同步（${roles.join(' + ')}）`, surface: roles[0], substitution: i.platforms.some((p) => /ios|iphone/i.test(p)) ? { from: 'ios', to: 'android-app', reason: '没有 iOS 设备，用 Android App 代替', alternatives: ['android-app'] } : undefined, plan: v.plan ?? plan, planErrors: v.errors };
}

/** Apply the one-time confirmation: chosen sub-cases (and their surfaces) become fixed plans. A plan moved to
 *  another surface keeps its steps (no template to rebuild from); resolvePlan validates it there. */
export function applyApproval(d: Draft, approve: { sub: string; surface?: Surface }[]): TestPlan[] {
  const now = new Date().toISOString();
  return d.subcases
    .filter((s) => approve.some((a) => a.sub === s.sub))
    .map((s) => {
      const surf = approve.find((a) => a.sub === s.sub)?.surface ?? s.surface;
      return {
        ...s.plan,
        id: s.plan.id.replace(s.surface, surf),
        surface: surf,
        substitution: s.substitution ? { from: s.substitution.from, to: surf, reason: s.substitution.reason } : s.plan.substitution,
        provenance: { ...s.plan.provenance, confirmedAt: now, draftHash: d.hash },
      };
    });
}
