// View models (W2-3 §6.1, G1): one structured object per thing — plan, environment, task, result — from
// which the CLI text, `--json` and the Web pages are all rendered, so their sentences and numbers agree.
// Plain-Chinese steps come from the Node templates (node-specs.ts `zh`) and the plan structure, never
// written by hand. `schemaVersion` changes only on breaking changes (snapshot tests guard it).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RunResult } from '../executor/run';
import { attemptsText } from '../executor/stats';
import { nodeSpec } from '../skills/teamily/node-specs';
import { ELEMENTS, REGIONS } from '../skills/teamily/vocab';
import { type Approval, type Classified, getApproval, roundBound } from './approval';
import type { EnvRecord } from './lifecycle/env';
import { STATUS, type Code } from './lifecycle/status';
import { PHASE_TEXT, type TaskRecord, type LedgerEntry } from './lifecycle/task';
import type { CheckPoint, PlannedAction, TestPlan } from './schema/test-plan';

export const VIEW_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- plan

export interface PlanStep {
  stage: 'setup' | 'prepare' | 'warmup' | 'loop' | 'check' | 'after' | 'epilogue' | 'acceptance';
  text: string;
  /** Element id (fixed, calibrated) or target id (picked by the model at preparation). */
  element?: string;
  byModel?: boolean;
  sends?: boolean;
}

export interface PlanView {
  schemaVersion: number;
  kind: 'PlanView';
  id: string;
  hash: string;
  issue: string;
  title: string;
  summary: string;
  purpose: string;
  surface: string;
  env: string;
  substitution?: { from: string; to: string; reason: string };
  steps: PlanStep[];
  verdict: string[];
  impact: { messagesMax: number; conversations: string[]; data: string[]; envConfig: string[]; extraSettings: string[] };
  uncertain: string[];
  modelCalls: string[];
  estimate: { minSec: number; maxSec: number; basis: 'history' | 'first-estimate'; samples: number; text: string };
  approval: { category: Classified['category']; reasons: string[]; state: 'approved' | 'rejected' | 'pending'; by?: string; runs?: string; note?: string };
}

const elementText = (id: string) => ELEMENTS.find((e) => e.id === id)?.meaning ?? id;
const tagTextDefault = (s: string) => s.replace(/\{token\}/g, '<运行标记>').replace(/\{round\}/g, '<轮号>');

/** Pure: what a target means to a person (conversation title when the guidance names it). */
export function targetText(p: Pick<TestPlan, 'targets'>, id: string): string {
  const t = p.targets.find((x) => x.id === id);
  if (!t) return id;
  const title = t.guidance.match(/titled "([^"]+)"/)?.[1];
  if (title) return title;
  if (/Personal AI/i.test(t.guidance)) return '自己的 Personal AI 会话';
  return `${t.kind}（运行时由模型按说明选定）`;
}

/** Pure: a planned action in plain Chinese. */
export function stepText(a: PlannedAction, p: Pick<TestPlan, 'targets'>, keepTokens = false): Omit<PlanStep, 'stage'> {
  const tagText = keepTokens ? (s: string) => s : tagTextDefault;
  if (a.type === 'node' && a.node) {
    const spec = nodeSpec(a.node.name);
    const inp = a.node.input as Record<string, unknown>;
    const text = (spec?.zh ?? a.node.name).replace(/\{target:(\w+)\}/g, (_, k) => targetText(p, String(inp[k] ?? ''))).replace(/\{(\w+)\}/g, (_, k) => tagText(String(inp[k] ?? '')));
    const tid = String(inp.target ?? inp.to ?? '');
    const byModel = !!tid && !p.targets.find((x) => x.id === tid)?.guidance.match(/titled "|Personal AI/i);
    return { text, sends: /发出/.test(text), ...(tid ? { element: `target.${tid}`, byModel } : {}) };
  }
  const el = a.element?.startsWith('target.') ? `目标「${targetText(p, a.element.slice(7))}」` : a.element ? `「${elementText(a.element)}」` : '';
  switch (a.type) {
    case 'tap':
      return { text: `点击${el}`, element: a.element };
    case 'longPress':
      return { text: `长按${el}`, element: a.element };
    case 'type':
      return { text: `在输入框键入「${tagText(a.value ?? '')}」` };
    case 'key':
      return { text: `按 ${a.value} 键` };
    case 'wait':
      return { text: `等待 ${a.value} 毫秒` };
    case 'idle':
      return { text: `不做任何操作 ${Math.round(Number(a.value ?? 0) / 1000)} 秒` };
    case 'back':
      return { text: '按返回键' };
    case 'swipe':
    case 'scroll':
      return { text: `向${{ up: '上', down: '下', left: '左', right: '右' }[a.value ?? 'up'] ?? a.value}滑动` };
    case 'require':
      return { text: `确认输入框里有「${tagText(a.requires?.composerHas ?? '')}」（没有 = 本轮操作偏离，不计入）` };
    case 'exitApp':
      return { text: '回到桌面（App 留在后台）' };
    case 'killApp':
      return { text: '结束 App 进程' };
    case 'reload':
      return { text: '重新加载（App：结束后重新启动）' };
    case 'launch':
      return { text: '启动 App' };
    default:
      return { text: a.type };
  }
}

/** Pure: a check in plain Chinese (what is looked at, what counts). */
export function checkText(k: CheckPoint, p: Pick<TestPlan, 'targets'>): string {
  const tagText = tagTextDefault;
  const m = k.match ? ('exact' in k.match ? `「${tagText(k.match.exact)}」` : 'contains' in k.match ? `含「${tagText(k.match.contains)}」` : `匹配 /${k.match.regex}/`) : '';
  const where = k.kind === 'text' ? (k.scope === 'composer' ? '输入框里的文字' : typeof k.scope === 'object' && 'message' in k.scope ? `本轮那条含「${tagText(k.scope.message)}」的消息` : typeof k.scope === 'object' && 'target' in k.scope ? `目标「${targetText(p, k.scope.target)}」附近` : '屏幕上的文字') : k.kind === 'visual-region' ? `${k.page} 页的「${REGIONS.find((r) => r.page === k.page && r.region === k.region)?.meaning ?? k.region}」` : k.kind === 'crash' ? 'App 是否崩溃' : k.kind === 'keyboard' ? '软键盘' : k.kind === 'ai' ? '截图（视觉模型判断）' : k.kind;
  return `看${where}${m ? `是否${k.want === 'absent' ? '不' : ''}为${m}` : ''}：应「${tagText(k.expect)}」`;
}

/** One earlier run of the same plan: its duration and how many loop rounds it ran (warm-up excluded). */
export interface PastRun {
  sec: number;
  rounds: number;
  at?: string;
}

const overheadOf = (p: TestPlan) => 60 + p.targets.length * 15 + (p.prepare.length ? 20 : 0);

/** Pure: duration interval of one run. History → each past run rescaled to this run's round count
 *  (overhead + per-round time), then median ~ max; none → steps × budget ("首次估算"). */
export function estimate(p: TestPlan, h: (number | PastRun)[], maxRounds?: number): PlanView['estimate'] {
  const rounds = maxRounds ?? p.limits.maxRounds ?? 20;
  const overhead = overheadOf(p);
  if (h.length) {
    const pred = h.map((x) => {
      if (typeof x === 'number') return x;
      const a = Math.min(overhead, x.sec * 0.8);
      return a + ((x.sec - a) / Math.max(1, x.rounds + 1)) * (rounds + 1);
    });
    const s = [...pred].sort((a, b) => a - b);
    const med = s[Math.floor((s.length - 1) / 2)];
    const max = s[s.length - 1];
    const lo = Math.round(med * 0.8);
    const hi = Math.round(Math.max(max * 1.2, med * 1.5));
    return { minSec: lo, maxSec: hi, basis: 'history', samples: h.length, text: `约 ${fmtSec(lo)} – ${fmtSec(hi)}（同计划最近 ${h.length} 次运行）` };
  }
  const per = p.actions.reduce((n, a) => n + 1.5 + (a.delayAfterMs ?? 300) / 1000 + (a.type === 'idle' ? Number(a.value ?? 0) / 1000 : 0) + (a.node?.name === 'teamily.tapRewrite' ? 6 : 0), 0) + p.checks.length * 2;
  const lo = Math.round(overhead + per * (rounds + 1) * 0.7);
  const hi = Math.min(Math.round(overhead * 2 + per * (roundBound(p, maxRounds) + 1) * 1.5), p.limits.maxMinutes * 60 + overhead * 2);
  return { minSec: lo, maxSec: hi, basis: 'first-estimate', samples: 0, text: `约 ${fmtSec(lo)} – ${fmtSec(hi)}（首次估算：步数 × 步骤预算）` };
}

export const fmtSec = (s: number) => (s < 90 ? `${s} 秒` : `${Math.round(s / 60)} 分钟`);

/** Durations of earlier runs of a plan (TestPlan id, e.g. 2010-android-app-v1): new task results and old
 *  Issue run dirs. Runs that never reached the app (环境不合格) are left out. */
export function planHistory(testPlanId: string, roots = [resolve('platform/state/tasks'), resolve('midscene_run/issues')], before?: string): PastRun[] {
  const out: PastRun[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      const f = join(root, d, 'result.json');
      if (!existsSync(f)) continue;
      try {
        const r = JSON.parse(readFileSync(f, 'utf8')) as { results?: RunResult[]; runs?: RunResult[] };
        for (const x of [...(r.results ?? []), ...(r.runs ?? [])])
          if (x.planId === testPlanId && x.stats?.durationSec && x.conclusion !== '环境不合格' && !x.cancelled && (!before || x.startedAt < before)) out.push({ at: x.startedAt, sec: x.stats.durationSec, rounds: x.attempts?.rounds ?? x.stats.rounds ?? 0 });
      } catch {
        /* torn / old format */
      }
    }
  }
  // The same run is in both roots when a task wrote its Issue report: keep one per start time.
  const seen = new Set<string>();
  return out
    .filter((x) => (seen.has(x.at!) ? false : (seen.add(x.at!), true)))
    .sort((a, b) => b.at!.localeCompare(a.at!))
    .slice(0, 10);
}

export function planView(o: { id: string; hash: string; plan: TestPlan; classified: Classified; envConfig?: string[]; history?: (number | PastRun)[]; approval?: Approval; maxRounds?: number; warmupFailures?: { at: string; detail: string }[] }): PlanView {
  const p = o.plan;
  const steps: PlanStep[] = [];
  const add = (stage: PlanStep['stage'], xs: PlannedAction[] | undefined) => {
    for (const a of xs ?? []) steps.push({ stage, ...stepText(a, p) });
  };
  add('setup', p.setup);
  add('prepare', p.prepare);
  if (p.category === 'feature') for (const a of p.acceptance ?? []) steps.push({ stage: 'acceptance', text: `验收「${a.text}」：${a.actions.map((x) => stepText(x, p).text).join(' → ') || '不操作'}；${checkText(a.check, p)}` });
  else {
    add('loop', p.actions);
    for (const k of p.checks) steps.push({ stage: 'check', text: checkText(k, p) });
    add('after', p.afterCheck);
    if (p.epilogue) {
      add('epilogue', p.epilogue.actions);
      steps.push({ stage: 'epilogue', text: `只记录、不参与判定：${checkText(p.epilogue.check, p)}` });
    }
  }
  const tagText = tagTextDefault;
  const rounds = o.maxRounds ?? p.limits.maxRounds;
  const rule = 'consecutiveHits' in p.verdictRule ? '连续 3 轮命中才算「已复现」' : '任意 1 轮命中即算「已复现」';
  const verdict =
    p.category === 'feature'
      ? ['逐项执行验收项：全部通过 = 已实现；部分通过 = 部分实现；全部不通过 = 未实现', '读不出的项记「未验证」，不算通过']
      : [
          `每轮执行上面的循环步骤，然后检查：${p.checks.map((k) => `「${tagText(k.expect)}」`).join('、')}；检查不成立 = 本轮命中`,
          `${rule}；${rounds ? `最多 ${rounds} 次有效尝试` : `最多 ${p.limits.maxSteps} 步`}，或 ${p.limits.maxMinutes} 分钟`,
          '本轮自身的前提（如输入框里确有刚键入的文字）不成立 = 操作偏离：不计入有效尝试，也不算命中；偏离超过 10 次即停止',
          '开始循环前先跑 1 轮预热（逐步核对），不计入结果',
        ];
  const convs = [...new Set(p.targets.filter((t) => /conversation/.test(t.kind)).map((t) => targetText(p, t.id)))];
  const sendSteps = steps.filter((s) => s.sends);
  const data = [
    ...(sendSteps.length ? [`发送的消息都带本次运行标记（如「autotest-${p.issueRef} <运行标记> <轮号>」），发出后不删除、不撤回`] : []),
    ...(steps.some((s) => /键入/.test(s.text) && !s.sends) ? ['输入框里的草稿（结束时清空，不发送）'] : []),
  ];
  const uncertain: string[] = [];
  for (const t of p.targets) if (!/titled "|Personal AI/i.test(t.guidance)) uncertain.push(`目标「${t.id}」由模型在准备阶段选定（${t.guidance.slice(0, 80)}），选定后冻结为坐标`);
  for (const a of [...p.actions, ...p.prepare, ...p.setup]) {
    const sd = a.node && nodeSpec(a.node.name)?.serverDependent;
    if (sd && !uncertain.includes(sd)) uncertain.push(sd);
  }
  if (p.substitution) uncertain.push(`替代执行：Issue 端 ${p.substitution.from} → 实际 ${p.surface}；结论不能直接代表 ${p.substitution.from} 端`);
  if (p.coverage === 'not-covered') uncertain.push('计划未覆盖 Issue 描述的现象：结论只说明有没有崩溃');
  if (p.provenance.generatedBy === 'model') uncertain.push('计划由模型组合（不是验证过的模式），预热轮逐步核对后才进入循环');
  if (p.checks.some((k) => k.kind === 'ai')) uncertain.push('有视觉模型判断的检查：结果可能误判，命中会再做证据复核');
  for (const w of o.warmupFailures ?? []) uncertain.push(`上次预热失败（${w.at}）：${w.detail.slice(0, 100)}`);
  const modelCalls = [
    ...p.targets.filter((t) => !/titled "|Personal AI/i.test(t.guidance)).map((t) => `准备阶段：视觉模型选定目标「${t.id}」（1 次）`),
    ...(p.targets.some((t) => /titled "|Personal AI/i.test(t.guidance)) ? ['准备阶段：按文字定位指定会话（先读界面文字，找不到才用视觉模型）'] : []),
    ...(p.checks.some((k) => k.kind === 'ai') ? ['每轮检查：视觉模型判断截图'] : []),
    ...(p.category !== 'feature' ? ['命中时：视觉模型复核证据（每次命中 1 次）'] : ['验收项读不出时：视觉模型判断截图']),
  ];
  const ap = o.approval ?? getApproval(o.id);
  const state = ap?.rejected ? 'rejected' : ap?.planHash === o.hash ? 'approved' : 'pending';
  const est = estimate(p, o.history ?? planHistory(p.id), o.maxRounds);
  const purpose = p.category === 'feature' ? `验收 Issue ${p.issueRef}：${p.title}` : `在 ${p.surface} 上重复「${p.title}」，看 Issue ${p.issueRef} 描述的现象会不会出现`;
  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    kind: 'PlanView',
    id: o.id,
    hash: o.hash,
    issue: p.issueRef,
    title: p.title,
    purpose,
    summary: `${purpose}；最多发送 ${o.classified.messages} 条消息；${est.text}；${o.classified.category === 'default' ? '默认允许' : o.classified.category === 'sensitive' ? '敏感计划，需人在 Web 同意' : '触及硬约束，拒绝执行'}`,
    surface: p.surface,
    env: p.env,
    substitution: p.substitution,
    steps,
    verdict,
    impact: { messagesMax: o.classified.messages, conversations: convs, data, envConfig: o.envConfig ?? [], extraSettings: [] },
    uncertain,
    modelCalls,
    estimate: est,
    approval: { category: o.classified.category, reasons: o.classified.reasons, state, by: ap?.rejected?.by ?? ap?.by, runs: ap && !ap.rejected ? `${ap.runsUsed}/${ap.runsAllowed}` : undefined, note: ap?.rejected?.note },
  };
}

// ---------------------------------------------------------------- environment

export interface EnvView {
  schemaVersion: number;
  kind: 'EnvView';
  id: string;
  state: EnvRecord['state'];
  stateText: string;
  summary: string;
  since: string;
  reason?: string;
  suggestion?: string;
  lease?: { taskId: string; pid?: number; at: string };
  dirty?: { reason: string; at: string };
  baseline?: { at: string; ok: boolean; items: { id: string; ok: boolean; detail: string }[] };
  configItems: { id: string; what: string; why: string; restore: string; consented: boolean; by?: string }[];
  device: string;
  account?: string;
  appVersion?: string;
}

export const ENV_STATE_TEXT: Record<EnvRecord['state'], string> = { offline: '下线', checking: '检查中', ready: '就绪', leased: '使用中', recovering: '恢复中', unfit: '不合格', quarantined: '已隔离', draining: '下线中' };

export function envView(e: EnvRecord): EnvView {
  const summary = `${e.id}：${ENV_STATE_TEXT[e.state]}${e.lease ? `（任务 ${e.lease.taskId}）` : ''}${e.reason ? ` — ${e.reason}` : ''}${e.suggestion ? `；建议：${e.suggestion}` : ''}`;
  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    kind: 'EnvView',
    id: e.id,
    state: e.state,
    stateText: ENV_STATE_TEXT[e.state],
    summary,
    since: e.stateSince,
    reason: e.reason,
    suggestion: e.suggestion,
    lease: e.lease && { taskId: e.lease.taskId, pid: e.lease.proc?.pid, at: e.lease.at },
    dirty: e.dirty,
    baseline: e.baseline && { at: e.baseline.at, ok: e.baseline.ok, items: e.baseline.items.map(({ id, ok, detail }) => ({ id, ok, detail })) },
    configItems: e.configItems.map((c) => ({ id: c.id, what: c.what, why: c.why, restore: c.restore, consented: !!c.consentedAt, by: c.consentedBy })),
    device: e.device,
    account: e.account,
    appVersion: e.appVersion,
  };
}

// ---------------------------------------------------------------- result

export interface ResultRun {
  planId: string;
  conclusion: string;
  sentence: string;
  basis: string[];
  attempts?: { valid: number; hits: number; drift: number; rate: number; wilson: [number, number]; upper95?: number; text: string };
  flags: { evidenceReview: string; substituted: string; selfCheck: string };
  failure?: { kind: 'env' | 'tool'; kindText: string; rule: string; reason: string; suggestion: string };
  durationSec?: number;
  runTag?: string;
}

export interface ResultView {
  schemaVersion: number;
  kind: 'ResultView';
  taskId: string;
  code: Code;
  status: number;
  sentence: string;
  complete: boolean;
  runs: ResultRun[];
  series?: { runs: number; reachedLoop: number; reproducedRuns: number; validRuns: number; valid: number; hits: number };
  ended?: { by?: string; at?: string; envRecovery?: string };
  evidence: { report?: string; runDir?: string; incidents: string[] };
}

const SUGGEST: Record<'env' | 'tool', string> = { env: '环境问题：按环境页的建议处理（解锁 / 重连 / 重新检查），然后只重跑这一项', tool: '工具问题：查看报告里的错误与截图，修代码或重新标定 SKILL 后只重跑这一项' };

/** Pure: one run's conclusion sentence (the same words everywhere). */
export function runSentence(r: Pick<RunResult, 'conclusion' | 'attempts' | 'conclusionDetail' | 'cancelled' | 'substitution' | 'surface'>): string {
  if (r.cancelled) return `已取消：不完整，不给结论${r.attempts ? `（中断前 ${r.attempts.valid} 次有效尝试、命中 ${r.attempts.hits} 次）` : ''}`;
  const a = r.attempts ? `：${attemptsText(r.attempts)}` : '';
  const sub = r.substitution ? `（替代执行 ${r.substitution.from} → ${r.surface}）` : '';
  if (['已复现', '未复现', '疑似误操作', '转为 bug'].includes(r.conclusion)) return `${r.conclusion}${a}${sub}`;
  return `${r.conclusion}${sub}：${r.conclusionDetail.slice(0, 160)}`;
}

export function resultRun(r: RunResult): ResultRun {
  const reviewed = r.hits.filter((h) => h.review);
  return {
    planId: r.planId,
    conclusion: r.cancelled ? '已取消' : r.conclusion,
    sentence: runSentence(r),
    basis: r.lead ? [`触发路径：${r.lead.trigger}（${r.lead.triggerBasis}）`, `出现位置：${r.lead.location}（${r.lead.locationBasis}）`, `推测机制（未验证）：${r.lead.mechanism}`] : r.acceptance ? r.acceptance.map((x) => `${x.text}：${x.pass === null ? '未验证' : x.pass ? '通过' : '不通过'}（${x.detail.slice(0, 80)}）`).slice(0, 3) : [r.conclusionDetail.slice(0, 160)],
    attempts: r.attempts && { valid: r.attempts.valid, hits: r.attempts.hits, drift: r.attempts.drift, rate: r.attempts.rate, wilson: r.attempts.wilson, upper95: r.attempts.upper95, text: attemptsText(r.attempts) },
    flags: {
      evidenceReview: r.hits.length ? (reviewed.length ? `已复核 ${reviewed.length}/${r.hits.length} 次命中` : '命中未复核（视觉模型不可用）') : r.dismissed?.length ? `复核排除误报 ${r.dismissed.length} 次` : '无命中，无需复核',
      substituted: r.substitution ? `替代执行（${r.substitution.from} → ${r.surface}）` : '非替代执行',
      selfCheck: '工具自检：未接入（P1）',
    },
    failure: r.failure && { kind: r.failure.kind, kindText: r.failure.kind === 'env' ? '环境' : '工具', rule: r.failure.rule, reason: r.failure.reason.slice(0, 300), suggestion: SUGGEST[r.failure.kind] },
    durationSec: r.stats?.durationSec,
    runTag: r.runTag,
  };
}

export function resultView(t: TaskRecord, runs: RunResult[], code: Code, extra: { series?: ResultView['series']; report?: string; runDir?: string } = {}): ResultView {
  const rr = runs.map(resultRun);
  const complete = !!t.endedBy ? t.endedBy === 'normal' : t.state === 'done';
  const where = t.endedAt?.phase ? `停在${PHASE_TEXT[t.endedAt.phase] ?? t.endedAt.phase}${t.endedAt.round !== undefined ? ` 第 ${t.endedAt.round} 轮` : ''}${t.endedAt.step !== undefined ? ` 第 ${t.endedAt.step} 步` : ''}` : '';
  const recov = t.recovery ? (t.recovery.result === 'recovered' ? '环境已恢复' : t.recovery.result === 'pending' ? '环境恢复中' : `环境${t.recovery.result === 'unfit' ? '不合格' : '已隔离'}（${t.recovery.reason ?? ''}）`) : '环境恢复结果未知';
  const sentence = !complete ? `${STATUS[code].text}：不完整，不给结论${where ? `（${where}）` : ''}；${recov}` : extra.series ? `系列 ${extra.series.runs} 次：复现 ${extra.series.reproducedRuns}/${extra.series.validRuns} 次；有效尝试 ${extra.series.valid}、命中 ${extra.series.hits}` : rr.map((r) => r.sentence).join('；') || STATUS[code].text;
  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    kind: 'ResultView',
    taskId: t.id,
    code,
    status: STATUS[code].status,
    sentence,
    complete,
    runs: rr,
    series: extra.series,
    ended: { by: t.endedBy, at: where || undefined, envRecovery: recov },
    evidence: { report: extra.report ?? t.report, runDir: extra.runDir ?? t.runDir, incidents: runs.flatMap((r) => r.incidents) },
  };
}

// ---------------------------------------------------------------- task

export interface TaskView {
  schemaVersion: number;
  kind: 'TaskView';
  id: string;
  state: TaskRecord['state'];
  stateText: string;
  summary: string;
  planId: string;
  envId: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress: { phase?: string; phaseText?: string; round?: number; step?: number; at?: string; summary?: string };
  heartbeatAt?: string;
  timeline: { at: string; state?: string; phase?: string }[];
  endedBy?: string;
  endedAt?: string;
  partial?: TaskRecord['partial'];
  ledger: { entered: string[]; typedInto: string[]; sent: number; settings: string[] };
  recovery?: TaskRecord['recovery'];
  outcome?: { code: Code; status: number; exit: number; summary: string };
  cancelRequested: boolean;
}

export const TASK_STATE_TEXT: Record<TaskRecord['state'], string> = { queued: '排队', 'waiting-env': '等环境', preflight: '预检', running: '运行中', finishing: '收尾', recovering: '恢复中', done: '完成', 'env-unfit': '环境不合格', failed: '失败', interrupted: '中断', cancelled: '已取消', 'timed-out': '超时' };

export function taskView(t: TaskRecord, events: { at: string; type: string; state?: unknown; phase?: unknown }[], ledger: LedgerEntry[]): TaskView {
  const pos = t.progress;
  const ph = pos.phase ? PHASE_TEXT[pos.phase] : undefined;
  const where = ph ? `${ph}${pos.round !== undefined ? ` 第 ${pos.round} 轮` : ''}${pos.step !== undefined ? ` 第 ${pos.step} 步` : ''}` : '';
  const endedAt = t.endedAt?.phase ? `${PHASE_TEXT[t.endedAt.phase]}${t.endedAt.round !== undefined ? ` 第 ${t.endedAt.round} 轮` : ''}${t.endedAt.step !== undefined ? ` 第 ${t.endedAt.step} 步` : ''}` : undefined;
  const summary = `任务 ${t.id}（${t.planId} @ ${t.envId}）：${TASK_STATE_TEXT[t.state]}${where && !t.finishedAt ? `，${where}` : ''}${t.outcome ? ` — ${t.outcome.summary}` : ''}`;
  const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    kind: 'TaskView',
    id: t.id,
    state: t.state,
    stateText: TASK_STATE_TEXT[t.state],
    summary,
    planId: t.planId,
    envId: t.envId,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    progress: { ...pos, phaseText: ph },
    heartbeatAt: t.heartbeatAt,
    timeline: events.filter((e) => e.type === 'state' || e.type === 'progress').map((e) => ({ at: e.at, state: e.state as string | undefined, phase: e.phase as string | undefined })),
    endedBy: t.endedBy,
    endedAt,
    partial: t.partial,
    ledger: { entered: uniq(ledger.filter((l) => l.kind === 'enter-conversation').map((l) => l.target)), typedInto: uniq(ledger.filter((l) => l.kind === 'type').map((l) => l.target)), sent: ledger.filter((l) => l.kind === 'send').length, settings: uniq(ledger.filter((l) => l.kind === 'setting').map((l) => l.value)) },
    recovery: t.recovery,
    outcome: t.outcome && { code: t.outcome.code, status: STATUS[t.outcome.code].status, exit: STATUS[t.outcome.code].exit, summary: t.outcome.summary },
    cancelRequested: !!t.cancelRequested,
  };
}

// ---------------------------------------------------------------- text renderings (CLI)

export function planText(v: PlanView): string {
  const out = [`计划 ${v.id}  [哈希 ${v.hash}]`, `目的：${v.purpose}`, ...(v.substitution ? [`替代执行：${v.substitution.from} → ${v.substitution.to}`] : []), '步骤：'];
  const STAGE: Record<PlanStep['stage'], string> = { setup: '开始', prepare: '准备', warmup: '预热', loop: '每轮', check: '每轮检查', after: '检查后', epilogue: '结束前', acceptance: '验收' };
  v.steps.forEach((s, i) => out.push(`  ${i + 1}. [${STAGE[s.stage]}] ${s.text}${s.byModel ? '（运行时由模型选）' : ''}`));
  out.push('怎样算复现：', ...v.verdict.map((x) => `  - ${x}`));
  out.push(`影响：最多发送 ${v.impact.messagesMax} 条消息${v.impact.conversations.length ? `，会话：${v.impact.conversations.join('、')}` : ''}`, ...v.impact.data.map((x) => `  - ${x}`), `  - 环境配置项：${v.impact.envConfig.join('；') || '无'}`, `  - 额外改动的手机设置：${v.impact.extraSettings.join('；') || '无'}`);
  out.push('不确定点：', ...(v.uncertain.length ? v.uncertain.map((x) => `  - ${x}`) : ['  - 无']));
  out.push('模型调用：', ...v.modelCalls.map((x) => `  - ${x}`));
  out.push(`预计耗时：${v.estimate.text}`, `审批：${v.approval.category === 'default' ? '默认允许' : v.approval.category === 'sensitive' ? '敏感计划（Web 同意）' : '拒绝（硬约束）'} — ${v.approval.reasons.join('；')}；状态 ${v.approval.state}${v.approval.by ? `（${v.approval.by}）` : ''}${v.approval.runs ? `，已用 ${v.approval.runs}` : ''}`);
  return out.join('\n');
}

export function resultText(v: ResultView): string {
  const out = [`结论：${v.sentence}`, `状态码：${v.code}（${v.status}）`];
  for (const r of v.runs) {
    out.push(`- ${r.planId}：${r.sentence}`);
    if (r.attempts) out.push(`  有效尝试 ${r.attempts.valid}，命中 ${r.attempts.hits}，偏离 ${r.attempts.drift}`);
    for (const b of r.basis) out.push(`  依据：${b}`);
    out.push(`  标识：${r.flags.evidenceReview}；${r.flags.substituted}；${r.flags.selfCheck}`);
    if (r.failure) out.push(`  失败归类：${r.failure.kindText}（${r.failure.rule}）— ${r.failure.reason}`, `  建议：${r.failure.suggestion}`);
  }
  if (v.ended?.at || v.ended?.envRecovery) out.push(`结束：${v.ended.by ?? '-'}${v.ended.at ? `，${v.ended.at}` : ''}；${v.ended.envRecovery}`);
  if (v.evidence.report) out.push(`报告：${v.evidence.report}`);
  return out.join('\n');
}

// ---------------------------------------------------------------- calibration screenshot marks (plan page)

/** Node → the fixed element it acts on (for marking it on the calibration screenshot). */
const NODE_ELEMENT: Record<string, string> = { 'teamily.sendMessage': 'chat.send', 'teamily.tapSend': 'chat.send', 'teamily.clearComposer': 'chat.composer', 'teamily.typeMention': 'chat.composer', 'teamily.tapRewrite': 'chat.rewrite', 'teamily.freezeMention': 'chat.composer', 'teamily.quoteReply': 'chat.composer', 'teamily.openPage': 'nav.me' };

export interface StepMark {
  step: number;
  element: string;
  page: string;
  /** /api/v1/refs/<path> of the calibration screenshot. */
  image: string;
  box: [number, number, number, number];
  viewport: { width: number; height: number };
}

/** Pure: marks for the plan page — each step's element on its page's calibration screenshot. Target steps
 *  (picked by the model at run time) get no mark. */
export function stepMarks(v: PlanView, plan: TestPlan, profile: { viewport: { width: number; height: number }; elements: Record<string, { page: string; box?: number[] }>; refs: Record<string, { image: string }> } | undefined): StepMark[] {
  if (!profile) return [];
  const out: StepMark[] = [];
  const actions = [...plan.setup, ...plan.prepare, ...(plan.category === 'feature' ? [] : plan.actions)];
  v.steps.forEach((s, i) => {
    let el = s.element && !s.element.startsWith('target.') ? s.element : undefined;
    if (!el) {
      const a = actions.find((x) => x.node && stepText(x, plan).text === s.text);
      el = a?.node ? NODE_ELEMENT[a.node.name] : undefined;
    }
    if (!el && /输入框/.test(s.text) && s.stage !== 'check') el = 'chat.composer';
    const e = el ? profile.elements[el] : undefined;
    const ref = e ? profile.refs[e.page] : undefined;
    if (e?.box && ref) out.push({ step: i + 1, element: el!, page: e.page, image: ref.image, box: e.box.slice(0, 4) as StepMark['box'], viewport: profile.viewport });
  });
  return out;
}
