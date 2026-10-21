// Issue → draft (sub-cases, substitution options, TestPlans). LLM first (JSON-schema contract + SKILL
// vocabulary), validated by rules; on any failure a rule template of the category is used and validated
// the same way. Templates are generic by feature signal (mention / like / keyboard / notification entry /
// mention aggregation / generic), not per issue.
import { DEFAULT_LIMITS, type PlannedAction, type Surface, type TestPlan, testPlanJsonSchema, verdictRuleFor } from '../platform/schema/test-plan';
import { ELEMENTS, NODES, REGIONS, SKILL_VERSION, TARGET_GUIDANCE } from '../skills/teamily/vocab';
import { AVAILABLE, type Classification, classify } from './classify';
import { chatJson, modelConfigured } from './llm';
import type { NormalizedIssue } from './parse';
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
}

export interface Draft {
  issue: NormalizedIssue;
  classification: Classification;
  status: 'plannable' | 'refused' | 'deferred';
  reason: string;
  subcases: SubCase[];
  /** Part deferred inside a plannable issue (2122: second-account part). */
  deferredPart?: string;
}

const a = (type: PlannedAction['type'], extra: Partial<PlannedAction> = {}): PlannedAction => ({ type, delayAfterMs: 300, ...extra });
const node = (name: string, input: Record<string, unknown> = {}, delayAfterMs = 300): PlannedAction => ({ type: 'node', node: { name, input }, delayAfterMs });

/** Split "(1) … (2) … (3) …" in the summary into sub-cases. */
export function splitSubcases(i: NormalizedIssue): { sub: string; text: string }[] {
  const parts = i.summary.split(/\((\d)\)\s*/);
  if (parts.length < 5) return [{ sub: 'main', text: i.summary }];
  const out: { sub: string; text: string }[] = [];
  for (let k = 1; k + 1 < parts.length; k += 2) out.push({ sub: `s${parts[k]}`, text: parts[k + 1].replace(/[;,.]?\s*(and)?\s*$/, '').trim() });
  return out;
}

type Template = Pick<TestPlan, 'targets' | 'setup' | 'actions' | 'checks'> & { prepare?: TestPlan['prepare']; prepareCheck?: TestPlan['prepareCheck']; afterCheck?: TestPlan['afterCheck']; acceptance?: TestPlan['acceptance']; title: string };

const T = TARGET_GUIDANCE;

/** Pure: generic template by feature signal of the (sub-)case text. */
export function templateFor(text: string, category: TestPlan['category'], surface: Surface): Template {
  const t = text.toLowerCase();
  if (category === 'feature' && /bell|🔔|notification entr|通知入口|notification center/.test(t)) {
    const pages = surface === 'android-app' ? [] : (['profile', 'artifacts'] as const);
    return {
      title: '通知入口盘点（一次性验收）',
      targets: [],
      setup: [],
      actions: [],
      checks: [],
      acceptance: [
        ...pages.map((p) => ({
          id: `no-separate-bell-${p}`,
          text: `${p === 'profile' ? '个人主页' : 'Artifacts 页'}不再有独立维护未读状态的 🔔 入口（统一到单一通知中心）`,
          actions: [node('teamily.openPage', { page: p }, 1000), a('wait', { value: '1000', delayAfterMs: 1000 })],
          check: { kind: 'visual-region' as const, page: p, region: 'element:' + `${p}.bell`, expect: `${p} 页头部仍有独立 🔔`, want: 'absent' as const },
        })),
        ...(surface === 'desktop-web'
          ? [
              {
                id: 'no-separate-bell-clouddoc',
                text: 'CloudDoc / 交付物文档头部不再有独立维护未读状态的 🔔 入口（统一到单一通知中心）',
                actions: [node('teamily.openPage', { page: 'artifacts' }, 1000), a('wait', { value: '1000', delayAfterMs: 1000 }), { type: 'tap' as const, element: 'artifacts.firstCard', delayAfterMs: 1000 }, a('wait', { value: '1000', delayAfterMs: 1000 }), a('wait', { value: '1000', delayAfterMs: 1000 }), a('wait', { value: '1000', delayAfterMs: 1000 })],
                check: { kind: 'visual-region' as const, page: 'clouddoc', region: 'element:clouddoc.bell', expect: 'CloudDoc 头部仍有独立 🔔', want: 'absent' as const },
              },
            ]
          : []),
        {
          id: 'single-center',
          text: '存在一个汇总所有模块通知、共享同一未读状态的通知中心入口',
          actions: [a('back', { delayAfterMs: 1000 }), node('teamily.openPage', { page: 'chat' }, 1000)],
          check: { kind: 'ai' as const, expect: 'The far-left global navigation rail (the narrow icon column at the left edge) contains a bell-shaped (🔔) notification icon. Answer false if no bell-shaped icon is in that rail; gift, memory, download or other icons do not count', want: 'present' as const, onlyOnAnomaly: false },
        },
      ],
    };
  }
  if (category === 'feature' && /mention|@/.test(t)) {
    return {
      title: '@我 聚合入口 / 免打扰群 @ 提示（单账号可验部分）',
      targets: [{ id: 'mutedGroup', kind: 'muted-group', guidance: '会话列表里带免打扰（划线铃铛）图标、且预览中出现 “@” 的群' }],
      setup: [],
      actions: [],
      checks: [],
      acceptance: [
        {
          id: 'mentions-entry',
          text: '存在 “@我 / Mentions” 聚合入口（列出所有 @ 我的消息）',
          actions: [node('teamily.openPage', { page: 'chat' }, 1000)],
          check: { kind: 'ai', expect: 'There is a visible entry named like "@我", "Mentions" or "提及" that lists messages mentioning the user', want: 'present', onlyOnAnomaly: false },
        },
        {
          id: 'muted-mention-badge',
          text: '免打扰群被 @ 时，会话列表有显著提示（角标/徽标，而不只是小号绿色 “[有人@你]” 文本）',
          actions: [],
          check: { kind: 'ai', expect: 'In the conversation list, the muted group row that mentions the user shows a prominent badge (a count or @ badge on the avatar or at the right side), not only small green preview text', want: 'present', onlyOnAnomaly: false },
        },
      ],
    };
  }
  if (/@|mention|picker|selector|选择器/.test(t)) {
    return {
      title: '@ 成员选择器弹出（切换会话后循环）',
      targets: [
        { id: 'group', kind: 'group-conversation', guidance: T['group-conversation'] },
        { id: 'other', kind: 'other-conversation', guidance: T['other-conversation'] },
      ],
      setup: [node('teamily.openConversation', { target: 'group' }, 800)],
      actions: [node('teamily.clearComposer', {}, 200), node('teamily.openConversation', { target: 'other' }, 500), node('teamily.openConversation', { target: 'group' }, 700), node('teamily.typeMention', {}, 700)],
      checks: [
        { kind: 'visual-region', page: 'mention-picker', region: 'picker', expect: '输入 @ 后成员/智能体选择器弹出', want: 'present', onlyOnAnomaly: true },
        { kind: surface === 'android-app' ? 'crash' : 'page-error', expect: '无崩溃 / 页面错误', want: 'absent' },
      ],
    };
  }
  if (/location link|jumps? to|定位|跳转|message link/.test(t)) {
    // A quote card (reply with quote) is a location link back to the quoted message. Round 1 checks the
    // first jump really shows the quoted original and keeps that screen; later rounds must land there too.
    return {
      title: '点引用定位应稳定跳到被引用消息',
      targets: [
        { id: 'conv', kind: 'group-conversation', guidance: T['group-conversation'] },
        { id: 'link', kind: 'quote-card', guidance: '会话底部最近的一条引用回复里的引用块（左侧竖线 + 原发送人 + 原文）' },
      ],
      setup: [node('teamily.openConversation', { target: 'conv' }, 1000)],
      actions: [{ type: 'tap', element: 'target.link', delayAfterMs: 1000 }, a('wait', { value: '1000', delayAfterMs: 1000 })],
      checks: [{ kind: 'baseline', expect: '点引用块后跳到被引用的原消息（每轮落在同一位置）', want: 'present' }],
      afterCheck: [...(surface === 'desktop-web' ? [] : [a('tap', { element: 'chat.back', delayAfterMs: 900 })]), node('teamily.openConversation', { target: 'conv' }, 1000), a('wait', { value: '1000', delayAfterMs: 1000 })],
    };
  }
  if (/keyboard|键盘/.test(t)) {
    return {
      title: '点一次输入框键盘即弹出',
      targets: [{ id: 'conv', kind: 'group-conversation', guidance: T['group-conversation'] }],
      setup: [node('teamily.openConversation', { target: 'conv' }, 800)],
      // chat.back (the on-screen button): the back KEY would only close the keyboard.
      actions: surface === 'desktop-web' ? [a('tap', { element: 'chatlist.search', delayAfterMs: 500 }), node('teamily.openConversation', { target: 'conv' }, 700), a('tap', { element: 'chat.composer', delayAfterMs: 800 })] : [a('tap', { element: 'chat.back', delayAfterMs: 700 }), node('teamily.openConversation', { target: 'conv' }, 900), a('tap', { element: 'chat.composer', delayAfterMs: 900 })],
      checks: [{ kind: 'ai', expect: 'The on-screen keyboard is shown after a single tap on the message input', want: 'present', onlyOnAnomaly: false }],
    };
  }
  if (/like|点赞|reaction/.test(t)) {
    return {
      title: '点赞后立即可见',
      targets: [
        { id: 'conv', kind: 'group-conversation', guidance: T['group-conversation'] },
        { id: 'msg', kind: 'others-text-message', guidance: T['others-text-message'] },
        { id: 'like', kind: 'like-action', guidance: '长按消息后出现的点赞/👍 表情按钮' },
      ],
      setup: [node('teamily.openConversation', { target: 'conv' }, 800)],
      actions: [{ type: 'longPress', element: 'target.msg', delayAfterMs: 900 }, { type: 'tap', element: 'target.like', delayAfterMs: 1000 }],
      checks: [{ kind: 'ai', expect: 'The liked message shows a like / 👍 reaction under it', want: 'present', onlyOnAnomaly: false }],
      // Toggle back so every round starts from "not liked".
      afterCheck: [{ type: 'longPress', element: 'target.msg', delayAfterMs: 900 }, { type: 'tap', element: 'target.like', delayAfterMs: 1000 }],
    };
  }
  return {
    title: '按步骤执行并核对预期',
    targets: [{ id: 'conv', kind: 'group-conversation', guidance: T['group-conversation'] }],
    setup: [node('teamily.openConversation', { target: 'conv' }, 800)],
    // Loop without side effects for other people (no sending): reopen + scroll the history.
    actions: [...(surface === 'desktop-web' ? [] : [a('tap', { element: 'chat.back', delayAfterMs: 700 })]), node('teamily.openConversation', { target: 'conv' }, 900), a('scroll', { value: 'up', delayAfterMs: 700 }), a('scroll', { value: 'down', delayAfterMs: 700 })],
    checks: [{ kind: surface === 'android-app' ? 'crash' : 'page-error', expect: '无崩溃 / 页面错误', want: 'absent' }],
  };
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
    let by: 'model' | 'rules' = 'model';
    let tpl = opts.useModel === false ? undefined : await modelTemplate(i, c, sc.text, surf);
    let plan = tpl && basePlan(i, c, sc.sub, surf, env, tpl, 'model');
    let v = plan ? validatePlan(plan) : undefined;
    if (!v?.ok) {
      if (v) console.warn(`[plan] model plan for ${i.id}/${sc.sub} rejected: ${v.errors.slice(0, 3).join('; ')} — using rule template`);
      by = 'rules';
      tpl = templateFor(`${sc.text} ${c.category === 'feature' ? i.featureArea : ''}`, c.category as TestPlan['category'], surf);
      plan = basePlan(i, c, sc.sub, surf, env, tpl, by);
      v = validatePlan(plan);
    }
    subcases.push({
      sub: sc.sub,
      title: `${sc.text.slice(0, 80)}`,
      surface: surf,
      substitution: subst ? { from: subst.from, to: surf, reason: subst.reason, alternatives: subst.alternatives } : undefined,
      plan: v.plan ?? plan!,
      planErrors: v.errors,
    });
  }
  return { issue: i, classification: c, status: 'plannable', reason: c.reason, subcases, deferredPart: c.partialMultiAccount ? '需要第二账号 @ 我才能产生的角标/推送部分：暂缓（账号池多账号调度后执行）' : undefined };
}

/** Apply the one-time confirmation: chosen sub-cases (and their surfaces) become fixed plans. */
export function applyApproval(d: Draft, approve: { sub: string; surface?: Surface }[]): TestPlan[] {
  const now = new Date().toISOString();
  return d.subcases
    .filter((s) => approve.some((a) => a.sub === s.sub))
    .map((s) => {
      const surf = approve.find((a) => a.sub === s.sub)?.surface ?? s.surface;
      const tpl = { title: s.plan.title, targets: s.plan.targets, setup: s.plan.setup, prepare: s.plan.prepare, prepareCheck: s.plan.prepareCheck, actions: s.plan.actions, checks: s.plan.checks, afterCheck: s.plan.afterCheck, acceptance: s.plan.acceptance };
      const plan: TestPlan = {
        ...s.plan,
        ...tpl,
        id: s.plan.id.replace(s.surface, surf),
        surface: surf,
        substitution: s.substitution ? { from: s.substitution.from, to: surf, reason: s.substitution.reason } : undefined,
        provenance: { ...s.plan.provenance, confirmedAt: now },
      };
      return plan;
    });
}
