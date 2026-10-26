// Issue → draft (sub-cases, substitution options, TestPlans). LLM first (JSON-schema contract + SKILL
// vocabulary), validated by rules; on any failure a rule template of the category is used and validated
// the same way. Templates are generic by feature signal (mention / like / keyboard / notification entry /
// mention aggregation / generic), not per issue.
import { DEFAULT_LIMITS, type Surface, type TestPlan, testPlanJsonSchema, verdictRuleFor } from '../platform/schema/test-plan';
import { type PlanFragment, patternById, patternForText } from '../skills/teamily/patterns';
import { contractFor, coverageOf } from './contract';
import { ELEMENTS, NODES, REGIONS, SKILL_VERSION, TARGET_GUIDANCE } from '../skills/teamily/vocab';
import { AVAILABLE, type Classification, classify } from './classify';
import { chatJson, modelConfigured } from '../core/model/llm';
import type { NormalizedIssue } from './parse';
import type { IssueContract } from '../platform/schema/contract';
import { validatePlan } from './validate';

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

export interface Draft {
  issue: NormalizedIssue;
  classification: Classification;
  status: 'plannable' | 'refused' | 'deferred';
  reason: string;
  subcases: SubCase[];
  /** Part deferred inside a plannable issue (2122: second-account part). */
  deferredPart?: string;
  /** Content hash (issue/drafts.ts) — what the user confirms. */
  hash?: string;
  /** Hash of the Issue file the draft came from. */
  issueHash?: string;
  env?: string;
  /** Warm-up failures fed back from runs (plan not executable on the current UI). */
  warmupFailures?: { planId: string; at: string; detail: string }[];
}


/** Split "(1) … (2) … (3) …" in the summary into sub-cases. */
export function splitSubcases(i: NormalizedIssue): { sub: string; text: string }[] {
  const parts = i.summary.split(/\((\d)\)\s*/);
  if (parts.length < 5) return [{ sub: 'main', text: i.summary }];
  const out: { sub: string; text: string }[] = [];
  for (let k = 1; k + 1 < parts.length; k += 2) out.push({ sub: `s${parts[k]}`, text: parts[k + 1].replace(/[;,.]?\s*(and)?\s*$/, '').trim() });
  return out;
}

type Template = PlanFragment;

/** Pure: plan fragment of the pattern a (sub-)case text selects (rule path; patterns in skills/teamily/patterns.ts). */
export function templateFor(text: string, category: TestPlan['category'], surface: Surface): Template {
  return patternForText(text, category).build(surface);
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

function basePlan(i: NormalizedIssue, c: Classification, sub: string, surface: Surface, env: 'test' | 'prod', tpl: Template, by: 'model' | 'rules'): TestPlan {
  const category = c.category as TestPlan['category'];
  return {
    id: `${i.id}${sub === 'main' ? '' : `-${sub}`}-${surface}-v1`,
    issueRef: i.id,
    title: tpl.title,
    category,
    surface,
    issueSurfaces: i.platforms,
    env,
    launch: /launch|startup|启动|加载/.test(i.summary.toLowerCase()) ? 'each-iteration' : 'once',
    targets: tpl.targets,
    setup: tpl.setup,
    prepare: tpl.prepare ?? [],
    prepareCheck: tpl.prepareCheck,
    actions: tpl.actions,
    checks: tpl.checks,
    afterCheck: tpl.afterCheck ?? [],
    acceptance: tpl.acceptance,
    limits: { ...DEFAULT_LIMITS },
    verdictRule: verdictRuleFor(category),
    provenance: { generatedBy: by, skillVersion: SKILL_VERSION },
  };
}

const PLAN_SYSTEM = () => `You write black-box UI test plans for the Teamily IM app. Output ONE JSON object with keys
"title", "targets", "setup", "actions", "checks", and for features "acceptance" — matching this JSON Schema subset:
${JSON.stringify((testPlanJsonSchema() as any).properties ? Object.fromEntries(['targets', 'setup', 'actions', 'checks', 'acceptance'].map((k) => [k, (testPlanJsonSchema() as any).properties[k]])) : {})}
Use ONLY these element ids: ${ELEMENTS.map((e) => `${e.id} (${e.meaning}; ${e.surfaces.join('/')})`).join('; ')}.
Dynamic things (which group, which message) are targets: declare them in "targets" (id, kind, guidance) and reference as element "target.<id>" or as node input. Target kinds: ${Object.entries(TARGET_GUIDANCE).map(([k, v]) => `${k}: ${v}`).join('; ')}.
Nodes: ${NODES.map((n) => `${n.name}(${Object.keys(n.input).join(', ')}) — ${n.doc}`).join('; ')}.
visual-region checks may use: ${REGIONS.map((r) => `${r.page}/${r.region}`).join(', ')} or page/<"element:"+element id>.
Every delayAfterMs ≤ 1000. The loop "actions" repeats; checks run at the end of each round. No coordinates, no code.`;

async function modelTemplate(i: NormalizedIssue, c: Classification, text: string, surface: Surface): Promise<Template | undefined> {
  if (!modelConfigured()) return undefined;
  const ans = (await chatJson(PLAN_SYSTEM(), `Category: ${c.category}\nSurface: ${surface}\nIssue ${i.id}: ${text}\nSteps:\n${i.steps.join('\n')}\nExpected: ${i.expected.slice(0, 1500)}`)) as Template | undefined;
  if (!ans || !Array.isArray(ans.actions)) return undefined;
  // Models often write a region as "page/region"; split it into the schema's two fields.
  const fix = (c: any) => (c && !c.page && typeof c.region === 'string' && c.region.includes('/') ? { ...c, page: c.region.split('/')[0], region: c.region.split('/').slice(1).join('/') } : c);
  // Launch and login are the executor's job (once per Issue, session reuse); drop them from model plans.
  const unprefix = (x: any) => {
    if (x?.node?.input) for (const k of ['target', 'from', 'to']) if (typeof x.node.input[k] === 'string') x.node.input[k] = x.node.input[k].replace(/^target\./, '');
    return x;
  };
  const clean = (xs: any[]) => (xs ?? []).filter((x) => x?.type !== 'launch' && x?.node?.name !== 'teamily.login').map(unprefix);
  return { title: String(ans.title ?? 'model plan'), targets: ans.targets ?? [], setup: clean(ans.setup), actions: clean(ans.actions), checks: (ans.checks ?? []).map(fix), acceptance: ans.acceptance?.map((a: any) => ({ ...a, check: fix(a.check) })) };
}

export async function draftIssue(i: NormalizedIssue, opts: { env?: 'test' | 'prod'; useModel?: boolean } = {}): Promise<Draft> {
  const env = opts.env ?? 'prod';
  const c = await classify(i);
  if (c.category === 'server-side' || c.category === 'not-executable') return { issue: i, classification: c, status: 'refused', reason: c.reason, subcases: [] };
  if (c.category === 'multi-account' || c.category === 'deferred') return { issue: i, classification: c, status: 'deferred', reason: c.reason, subcases: [] };
  const subst = substitutionOptions(i.platforms);
  const surface: Surface = c.surfaces.find((s) => AVAILABLE.includes(s) && s === 'desktop-web') ?? c.surfaces[0] ?? 'android-app';
  const subcases: SubCase[] = [];
  for (const sc of c.category === 'feature' ? [{ sub: 'main', text: `${i.summary} ${i.expected}` }] : splitSubcases(i)) {
    const surf = subst ? 'android-app' : surface;
    const text = `${sc.text} ${c.category === 'feature' ? i.featureArea : ''}`;
    // Stage 1: intent contract (rules where a device-validated pattern applies, the model otherwise).
    const contract = await contractFor(i, sc.sub, text, c.category as TestPlan['category'], opts.useModel !== false);
    let plan: TestPlan | undefined;
    let v: ReturnType<typeof validatePlan> | undefined;
    if (contract.trigger.pattern) {
      // Stage 2a: the contract selects a pattern → deterministic compile, no model.
      plan = { ...basePlan(i, c, sc.sub, surf, env, patternById(contract.trigger.pattern)!.build(surf, contract.trigger.params), 'rules'), contract };
      plan.provenance.pattern = contract.trigger.pattern;
      v = validatePlan(plan);
    } else if (opts.useModel !== false) {
      // Stage 2b: no pattern → the model composes from the action library (one attempt, validated).
      const tpl = await modelTemplate(i, c, sc.text, surf);
      plan = tpl && { ...basePlan(i, c, sc.sub, surf, env, tpl, 'model'), contract };
      v = plan ? validatePlan(plan) : undefined;
      if (v && !v.ok) console.warn(`[plan] model plan for ${i.id}/${sc.sub} rejected: ${v.errors.slice(0, 3).join('; ')} — using rule template`);
    }
    if (!v?.ok) {
      // Fallback unchanged (D3): the rule template of the text; coverage tells whether it can observe the Issue.
      plan = { ...basePlan(i, c, sc.sub, surf, env, templateFor(text, c.category as TestPlan['category'], surf), 'rules'), contract };
      v = validatePlan(plan);
    }
    const final = { ...(v.plan ?? plan!), contract };
    final.coverage = coverageOf(final, contract);
    subcases.push({
      sub: sc.sub,
      title: `${sc.text.slice(0, 80)}`,
      surface: surf,
      // Keyboard behaviour only exists with a real soft keyboard: a browser emulation cannot stand in for it.
      substitution: subst ? { from: subst.from, to: surf, reason: subst.reason, alternatives: /keyboard|键盘/i.test(sc.text) ? ['android-app'] : subst.alternatives } : undefined,
      plan: final,
      planErrors: v.errors,
      contract,
    });
  }
  const blocked = subcases.filter((s) => s.contract?.preconditions.some((p) => p.establish === 'unconstructible'));
  if (subcases.length && blocked.length === subcases.length)
    return { issue: i, classification: c, status: 'deferred', reason: `前置条件黑盒无法构造：${[...new Set(blocked.flatMap((s) => s.contract!.preconditions.filter((p) => p.establish === 'unconstructible').map((p) => p.text)))].join('；')}`, subcases: [] };
  return { issue: i, classification: c, status: 'plannable', reason: c.reason, subcases, deferredPart: c.partialMultiAccount ? '需要第二账号 @ 我才能产生的角标/推送部分：暂缓（账号池多账号调度后执行）' : undefined };
}

/** Apply the one-time confirmation: chosen sub-cases (and their surfaces) become fixed plans. */
export function applyApproval(d: Draft, approve: { sub: string; surface?: Surface }[]): TestPlan[] {
  const now = new Date().toISOString();
  return d.subcases
    .filter((s) => approve.some((a) => a.sub === s.sub))
    .map((s) => {
      const surf = approve.find((a) => a.sub === s.sub)?.surface ?? s.surface;
      // A pattern plan is rebuilt for the approved surface (fragments differ per surface); others are kept.
      const pat = surf !== s.surface && s.plan.provenance.pattern ? patternById(s.plan.provenance.pattern) : undefined;
      const tpl = pat ? { prepare: [], afterCheck: [], ...pat.build(surf, s.contract?.trigger.params) } : { title: s.plan.title, targets: s.plan.targets, setup: s.plan.setup, prepare: s.plan.prepare, prepareCheck: s.plan.prepareCheck, actions: s.plan.actions, checks: s.plan.checks, afterCheck: s.plan.afterCheck, acceptance: s.plan.acceptance };
      const plan: TestPlan = {
        ...s.plan,
        ...tpl,
        id: s.plan.id.replace(s.surface, surf),
        surface: surf,
        substitution: s.substitution ? { from: s.substitution.from, to: surf, reason: s.substitution.reason } : undefined,
        provenance: { ...s.plan.provenance, confirmedAt: now, draftHash: d.hash },
      };
      if (plan.contract) plan.coverage = coverageOf(plan, plan.contract);
      return plan;
    });
}
