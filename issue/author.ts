// Model-authored test cases (W3-1 §7): the model reads the Issue file as is (plus its screenshots, rule B7)
// and designs each case from scratch with the SKILL building blocks only — no templates, no example plans.
// Prompt = skills/plan-authoring/SKILL.md + the block catalog generated from the executor (catalog.ts).
// The delivery (one JSON envelope) is checked by the validator; on errors the list goes back to the model
// once; still failing → the draft says 「无法生成计划」 with the errors. A revision (§8.2) is the same call
// with the previous envelope and the run evidence.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { modelCall, type Slot } from '../core/context/assemble';
import { modelConfigured, visionConfigured } from '../core/model/llm';
import { observationOf } from '../engine/observe';
import { loadConversations } from '../platform/conversations';
import type { IssueContract } from '../platform/schema/contract';
import { type Audit, DEFAULT_LIMITS, FeasibilityZ, OracleZ, QuoteZ, RevisionZ, type Surface, type TestPlan, TraceZ, UnderstandingZ, verdictRuleFor } from '../platform/schema/test-plan';
import { SKILL_VERSION } from '../skills/teamily/vocab';
import { blockCatalog } from './catalog';
import { DRAFTS_DIR } from './drafts';
import { issueImages } from './images';
import type { NormalizedIssue } from './parse';
import { expectsOf, validateAuthored, validatePlan } from './validate';

export const SKILL_FILE = resolve('skills/plan-authoring/SKILL.md');
/** Revision cap (W3-1 defaults): v1 + at most two revisions. */
/** Per-version run budget (W3-1 defaults): 30 valid attempts or 15 minutes, no early stop on a hit. */
export const VERSION_BUDGET = { maxRounds: 30, maxMinutes: 15 } as const;

export const SubcaseZ = z.object({
  sub: z.string().min(1),
  oracle: OracleZ,
  /** TestPlan fields the model writes (SKILL §5.2); the executor fills the rest. */
  plan: z.record(z.string(), z.unknown()),
  trace: z.array(TraceZ).default([]),
});

export const EnvelopeZ = z.object({
  quotes: z.array(QuoteZ).min(1),
  understanding: UnderstandingZ,
  feasibility: FeasibilityZ,
  subcases: z.array(SubcaseZ).default([]),
  revision: RevisionZ.nullable().default(null),
  selfCheck: z.record(z.string(), z.string()).default({}),
  risks: z.array(z.string()).default([]),
});
export type Envelope = z.infer<typeof EnvelopeZ>;

/** Fields the executor owns (SKILL §5.2): whatever the model writes there is replaced. */
const EXECUTOR_FIELDS = ['id', 'issueRef', 'category', 'surface', 'env', 'limits', 'verdictRule', 'provenance', 'issueSurfaces', 'audit', 'contract', 'coverage', 'substitution'];

export interface AuthorContext {
  issue: NormalizedIssue;
  /** The Issue file as is (the model reads this, not the parsed fields). */
  raw: string;
  surface: Surface;
  env: 'test' | 'prod';
  category: TestPlan['category'];
  /** Plan version this delivery becomes (1 = first design). */
  version: number;
  substitution?: { from: string; to: Surface; reason: string };
}

export interface Authored {
  envelope?: Envelope;
  /** One plan per sub-case (validated; errors per sub-case). */
  subcases: { sub: string; plan?: TestPlan; errors: string[] }[];
  /** Envelope-level errors (unparseable answer, schema). */
  errors: string[];
  /** Model calls made (1 or 2). */
  calls: number;
}

/** The system prompt as slots: SKILL then the block catalog (both stable across Issues: a cacheable prefix). */
export function systemSlots(): Slot[] {
  return [
    { name: 'skill', role: 'system', stable: true, content: readFileSync(SKILL_FILE, 'utf8') },
    { name: 'catalog', role: 'system', stable: true, content: blockCatalog() },
  ];
}

export function systemPrompt(): string {
  return systemSlots().map((x) => x.content as string).join('\n\n');
}

/** Pure: the user message — the Issue file verbatim plus what the executor fixed (surface, allow list, version). */
export function userPrompt(cx: AuthorContext, extra: { previous?: Envelope; materials?: RevisionMaterials; errors?: string[] } = {}): string {
  const conv = loadConversations().construct;
  const allow = conv.allow;
  const out = [
    `# Issue ${cx.issue.id}（原文，逐字）`,
    cx.raw,
    '',
    '# 执行条件（由执行器决定）',
    `- 执行端：${cx.surface}${cx.substitution ? `（替代执行：Issue 端 ${cx.substitution.from} → ${cx.surface}；R9 写明现象在新端上可能不一样的地方）` : ''}`,
    `- 环境：${cx.env}`,
    `- 允许构造数据（发消息 / 引用回复）的会话：${allow.length ? allow.map((a) => `"${a}"`).join('、') : '（无：需要构造数据的计划写 feasibility.status = unconstructible）'}；会话目标（kind: conversation）的 guidance 逐字写成 titled "<名称>"${allow.length ? `，例如 titled "${allow[0]}"` : ''}`,
    ...(conv.member ? [`- 允许清单会话里可以 @ 的成员（另一个测试账号）：「${conv.member}」；登录的测试账号自己不在 @ 选择器里`] : []),
    '- 只在 android-app 上执行（网页端不运行）。需要第二个账号或另一端的 Issue（对方发消息、对方 @ 我、多端同步）用一台手机交替登录完成：teamily.relogin {as: "other"} 切到另一个测试账号，{as: "self"} 切回；切换后要重新进入会话（setup 不会自动重跑）',
    `- 本次交付是计划 v${cx.version}${cx.version > 1 ? '（修订版：填写 revision）' : ''}`,
  ];
  if (extra.previous) out.push('', `# 上一版（v${cx.version - 1}）的外层 JSON`, JSON.stringify(extra.previous));
  if (extra.materials) out.push('', '# 运行证据（SKILL §6 修订材料）', revisionText(extra.materials));
  if (extra.errors?.length) out.push('', '# 你上一次交付的校验错误（逐条改正后重新交付完整 JSON）', ...extra.errors.map((e) => `- ${e}`));
  out.push('', '只输出一个 JSON 对象（SKILL §5.1）。');
  return out.join('\n');
}

/** Pure: an envelope → one TestPlan per sub-case (executor fields filled), validated (validatePlan + R-rules). */
export function compile(env: Envelope, cx: AuthorContext): Authored['subcases'] {
  return env.subcases.map((sc) => {
    const sub = sc.sub.replace(/\W+/g, '_').slice(0, 24) || 'main';
    const body = Object.fromEntries(Object.entries(sc.plan).filter(([k]) => !EXECUTOR_FIELDS.includes(k)));
    // Launch and login are the executor's (cold start + sign-in, then the home list): dropped from setup.
    // A region written as "page/region" (or with the page repeated) is split into the schema's two fields.
    const fixRegion = (k: any) => (k && typeof k.region === 'string' && k.region.includes('/') && !k.region.startsWith('element:') ? { ...k, page: k.region.split('/')[0], region: k.region.split('/').slice(1).join('/') } : k);
    const fixAction = (a: any) => (a?.expect?.check ? { ...a, expect: { ...a.expect, check: fixRegion(a.expect.check) } } : a);
    for (const key of ['checks', 'baseline', 'prepareChecks']) if (Array.isArray(body[key])) body[key] = (body[key] as unknown[]).map(fixRegion);
    if (body.prepareCheck && !Array.isArray(body.prepareCheck)) body.prepareCheck = fixRegion(body.prepareCheck);
    if (Array.isArray(body.prepareCheck)) body.prepareCheck = (body.prepareCheck as unknown[]).map(fixRegion);
    for (const key of ['setup', 'prepare', 'actions', 'afterCheck']) if (Array.isArray(body[key])) body[key] = (body[key] as unknown[]).map(fixAction);
    // prepareCheck is one check; a list (models often write one) becomes prepareCheck + prepareChecks.
    if (Array.isArray(body.prepareCheck)) {
      const [first, ...rest] = body.prepareCheck as unknown[];
      body.prepareCheck = first;
      body.prepareChecks = [...rest, ...((body.prepareChecks as unknown[]) ?? [])];
    }
    // The trace keeps pointing at the same steps: setup[i] is renumbered after the dropped ones.
    let trace = sc.trace;
    if (Array.isArray(body.setup)) {
      const steps = body.setup as { type?: string; node?: { name?: string } }[];
      const keep = steps.map((a) => a?.type !== 'launch' && a?.node?.name !== 'teamily.login');
      const newIndex = keep.map((k, i) => (k ? keep.slice(0, i).filter(Boolean).length : -1));
      body.setup = steps.filter((_, i) => keep[i]);
      trace = sc.trace.flatMap((t) => {
        const m = t.at.match(/^setup\[(\d+)\]$/);
        if (!m) return [t];
        const n = newIndex[Number(m[1])];
        return n === undefined || n < 0 ? [] : [{ ...t, at: `setup[${n}]` }];
      });
    }
    const audit: Audit = { version: cx.version, sub, quotes: env.quotes, understanding: env.understanding, feasibility: env.feasibility, oracle: sc.oracle, trace, selfCheck: env.selfCheck, risks: env.risks, revision: env.revision };
    const raw = {
      title: `Issue ${cx.issue.id}`,
      targets: [],
      setup: [],
      actions: [],
      checks: [],
      ...body,
      id: `${cx.issue.id}${sub === 'main' ? '' : `-${sub}`}-${cx.surface}-v${cx.version}`,
      issueRef: cx.issue.id,
      category: cx.category,
      surface: cx.surface,
      issueSurfaces: cx.issue.platforms,
      ...(cx.substitution ? { substitution: cx.substitution } : {}),
      env: cx.env,
      limits: { ...DEFAULT_LIMITS, ...VERSION_BUDGET, untilBudget: true },
      verdictRule: verdictRuleFor(cx.category),
      audit,
      provenance: { generatedBy: 'model', skillVersion: SKILL_VERSION },
    };
    const v = validatePlan(raw);
    if (!v.plan) return { sub, errors: v.errors.map((e) => `subcases[${sub}].plan ${explain(e)}`) };
    const plan = { ...v.plan, contract: contractOf(v.plan) };
    const errors = [...v.errors, ...validateAuthored(plan, cx.raw)].map((e) => `subcases[${sub}] ${e}`);
    return { sub, plan, errors };
  });
}

/** Pure: a schema error the model can act on (zod says only "Invalid input" for a union mismatch). */
export function explain(e: string): string {
  if (/(^|\.)match: Invalid input/.test(e)) return `${e} — match 必须是一个对象：{"exact":"…"} | {"contains":"…"} | {"regex":"…"}（要找的文字写在这里）`;
  if (/(^|\.)scope: Invalid input/.test(e)) return `${e} — scope 只能是 "screen" | "composer" | "quote-cards" | {"target":"<id>","within":<px>,"withinX":<px>} | {"message":"<锚点文字>"} | {"targetBubble":"<id>"}`;
  if (/prepareCheck: .*expected object, received array/.test(e)) return `${e} — prepareCheck 只能是一个 CheckPoint 对象；多个前置条件请合成一条检查，或把其余的放进 baseline`;
  if (/(^|\.)must: /.test(e)) return `${e} — must = {"sender":"self|others|any","content":"text|link|image|card|any","contains":"<文字>"}`;
  return e;
}

/** Pure: compat contract from the audit (older readers: report lead, evidence review phenomenon). */
export function contractOf(p: TestPlan): IssueContract | undefined {
  const a = p.audit;
  if (!a) return undefined;
  const oracle = expectsOf(p).find((x) => x.at === a.oracle.at)?.check ?? p.checks[0];
  return {
    issueRef: p.issueRef,
    sub: a.sub,
    preconditions: [{ id: 'logged-in', text: '已登录', establish: 'executor' }, ...(p.prepare.length ? [{ id: 'unmapped', text: '计划在准备阶段构造的前置数据', establish: 'construct' as const }] : [])],
    trigger: { semantics: 'model', text: a.understanding.trigger.slice(0, 300), params: {} },
    observable: { observation: oracle ? observationOf(oracle) : 'unmapped', text: a.understanding.expected.slice(0, 600), phenomenon: a.understanding.phenomenon.slice(0, 800) },
    provenance: { by: 'model', skillVersion: SKILL_VERSION, model: process.env.ISSUE_PLANNER_MODEL ?? process.env.MIDSCENE_MODEL_NAME },
  };
}

/** Per-call side channel: where to log, and why the call gave nothing (set by the default ask). Per call, not
 *  module state: Issues are designed in parallel (regress-w3 --parallel 3). */
export interface AskMeta {
  logs?: { raw: string; manifest: string };
  failure?: string;
}
type Ask = (system: string, user: string, images: Parameters<typeof issueImages>[0], meta?: AskMeta) => Promise<unknown>;

/** Pure: the per-Issue log files next to the draft (gitignored). */
export const authorLogs = (issueId: string, dir = DRAFTS_DIR) => ({ raw: join(dir, `${issueId}.calls.jsonl`), manifest: join(dir, `${issueId}.context.jsonl`) });

/** The model call: with the Issue's screenshots when a vision model is configured (B7), text otherwise.
 *  The answer is never dropped silently: the raw text is in `<id>.calls.jsonl` and the failure reason is kept. */
const defaultAsk: Ask = async (system, user, images, meta = {}) => {
  const shots = visionConfigured() && images.length ? await issueImages(images) : [];
  const sys = systemSlots();
  const slots: Slot[] = [
    ...(sys.map((x) => x.content).join('\n\n') === system ? sys : [{ name: 'system', role: 'system' as const, stable: true, content: system }]),
    { name: 'issue', role: 'user', content: user },
    { name: 'issue-images', role: 'user', content: shots },
  ];
  const r = await modelCall({ purpose: 'plan-author', slots, timeoutMs: 180_000, correct: true, rawLog: meta.logs?.raw, manifestLog: meta.logs?.manifest });
  meta.failure = r.ok ? undefined : r.fail === 'parse' || r.fail === 'truncated' ? `模型输出无法解析（${r.error.slice(0, 160)}），原始输出已保存` : `模型调用失败（${r.error.slice(0, 160)}）`;
  return r.ok ? r.value : undefined;
};

/** One delivery: ask, compile, validate; on errors ask once more with the error list. */
export async function author(cx: AuthorContext, extra: { previous?: Envelope; materials?: RevisionMaterials } = {}, ask: Ask = defaultAsk): Promise<Authored> {
  if (!modelConfigured() && ask === defaultAsk) return { subcases: [], errors: ['未配置模型：W3-1 起计划只能由模型从原文设计（不再有规则模板）'], calls: 0 };
  const logs = authorLogs(cx.issue.id);
  // W3-6 §8.4 ④: a first design is two stages (+ an ops-only fix); a revision stays one call.
  // AUTOTEST_PLAN_TWO_STAGE=0 keeps the one-call path; injected asks (tests) use it unless set to 1.
  const two = process.env.AUTOTEST_PLAN_TWO_STAGE ?? (ask === defaultAsk ? '1' : '0');
  if (!extra.previous && cx.version === 1 && two === '1') return (await import('./design')).authorTwoStage(cx, { ask, userPrompt: (c) => userPrompt(c), logs });
  const system = systemPrompt();
  let errors: string[] = [];
  let last: Authored = { subcases: [], errors: [], calls: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const meta: AskMeta = { logs };
    const ans = await ask(system, userPrompt(cx, { ...extra, errors: attempt ? errors : undefined }), cx.issue.images ?? [], meta);
    const parsed = EnvelopeZ.safeParse(ans);
    if (!parsed.success) {
      errors = ans === undefined ? [meta.failure ?? '模型没有返回可解析的 JSON'] : parsed.error.issues.slice(0, 20).map((i) => `envelope ${i.path.join('.')}: ${i.message}`);
      last = { subcases: [], errors, calls: attempt + 1 };
      continue;
    }
    const env = parsed.data;
    if (cx.version > 1 && !env.revision) {
      errors = ['revision: a revised plan (v2+) must fill revision {from, evidence, diagnosis, changes}'];
      last = { envelope: env, subcases: [], errors, calls: attempt + 1 };
      continue;
    }
    if (env.feasibility.status !== 'plannable') return { envelope: env, subcases: [], errors: [], calls: attempt + 1 };
    if (!env.subcases.length) {
      errors = ['subcases: a plannable delivery needs at least one sub-case'];
      last = { envelope: env, subcases: [], errors, calls: attempt + 1 };
      continue;
    }
    const subs = compile(env, cx);
    errors = subs.flatMap((s) => s.errors);
    last = { envelope: env, subcases: subs, errors: [], calls: attempt + 1 };
    if (!errors.length) return last;
  }
  return { ...last, errors };
}

// ---------------------------------------------------------------- revision materials (SKILL §6)

export interface RevisionMaterials {
  version: number;
  planIds: string[];
  /** Why the version is revised: warm-up failed / drift above threshold / no hit within the budget. */
  trigger: 'warmup' | 'drift' | 'no-hit' | 'control-hit';
  warmup: { step: number; action: string; expected: string; observed: string; pass: boolean | null }[];
  /** expect / baseline failures (which step, what was read). */
  expectFailures: { round: number; at: string; role: string; detail: string }[];
  driftReasons: { reason: string; n: number }[];
  /** Sampled low-resolution screenshots (paths). */
  samples: string[];
  attempts: { valid: number; hits: number; drift: number };
  conclusion: string;
  detail: string;
}

/** Pure: the materials as prompt text. */
export function revisionText(m: RevisionMaterials): string {
  const why = { warmup: '预热不通过（计划不可执行）', drift: '偏离率超过阈值（触发未稳定生效）', 'no-hit': '预算内一次都没命中', 'control-hit': '对照组也命中（正常对象上检查不通过：检查或观察位置有问题）' }[m.trigger];
  return [
    `- 修订原因：${why}`,
    `- 上一版（v${m.version}）计划：${m.planIds.join(', ')}；结论 ${m.conclusion} — ${m.detail.slice(0, 400)}`,
    `- 有效尝试 ${m.attempts.valid}，命中 ${m.attempts.hits}，偏离 ${m.attempts.drift}`,
    '- 预热每一步：',
    ...(m.warmup.length ? m.warmup.map((w) => `  - 第 ${w.step} 步 ${w.action}：预期 ${w.expected}；实际 ${w.observed}（${w.pass === null ? '未核验' : w.pass ? '通过' : '不通过'}）`) : ['  - （没有预热记录）']),
    '- expect / baseline 失败记录（最多 20 条）：',
    ...(m.expectFailures.length ? m.expectFailures.slice(0, 20).map((e) => `  - 第 ${e.round} 轮 ${e.at}（${e.role}）：${e.detail.slice(0, 200)}`) : ['  - 无']),
    '- 偏离原因：',
    ...(m.driftReasons.length ? m.driftReasons.map((d) => `  - ${d.n} 次：${d.reason.slice(0, 200)}`) : ['  - 无']),
    `- 定期采样截图：${m.samples.length} 张${m.samples.length ? `（${m.samples.slice(-3).join(', ')}）` : ''}`,
  ].join('\n');
}
