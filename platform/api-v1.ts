import { issueExists, issueIds, issuePath } from '../issue/paths';
// /api/v1 (W2-3 §5–6): the one service the CLI (for agents) and the Web pages (for people) both call.
// Every answer is an envelope { status, code, exit, summary, data?, error? } built from the view models, so
// the CLI text, `--json` and the pages say the same thing. Consent-type actions (sensitive plans, full
// access, environment configuration items) are Web-only: the pages send `x-autotest-client: web`; the CLI
// never does. Local use without login — a process rule, not a security boundary (§5.1).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { classifyRules } from '../issue/classify';
import { parseIssue } from '../issue/parse';
import type { RunResult } from '../engine/plan/run';
import type { AgentResult } from '../engine/agent/run';
import { allowList, approve, classifyPlan, getApproval, getFullAccess, reject, reviewerName, setFullAccess, useApproval, webUrl } from './approval';
import { consentConfig, type EnvRecord, getEnv, listEnvs, unconsented } from './lifecycle/env';
import { STATUS, type Code, CodedError, apiError, outcome } from './lifecycle/status';
import { readAudit, writeJsonAtomic } from './lifecycle/store';
import type { Supervisor } from './lifecycle/supervisor';
import { createTask, getTask, isTerminal, listTasks, newTaskId, readEvents, readLedger, readResult, taskDir, type TaskRecord } from './lifecycle/task';
import { parsePlanId, planIdOf, planIdsOf, resolvePlan, savedDraft, staleFacts, versionFacts } from './plans-v1';
import { envView, exploreSummary, planText, planView, resultText, resultView, taskView, type ResultView } from './views';

export interface Envelope {
  status: number;
  code: Code;
  exit: number;
  summary: string;
  data?: unknown;
  /** Plain text rendering of `data` (CLI without --json). */
  text?: string;
  error?: ReturnType<typeof apiError>;
}

export const ok = (code: Code, summary: string, data?: unknown, text?: string): Envelope => ({ ...outcome(code), summary, data, text });
const fail = (code: Code, message: string, hint?: string): Envelope => ({ ...outcome(code), summary: message, error: apiError(code, message, hint) });

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  web: boolean;
}

export interface Ctx {
  sup?: Supervisor;
}


function issueSummary(id: string) {
  const text = readFileSync(issuePath(id), 'utf8');
  const i = parseIssue(id, text);
  const c = classifyRules(i);
  const d = savedDraft(id);
  const plans = d && d.status === 'plannable' ? planIdsOf(d) : [];
  return { id, title: i.title, frequency: i.frequency, platforms: i.platforms, category: c.category, reason: c.reason, draft: d ? { version: d.version ?? 1, hash: d.hash, status: d.status, reason: d.reason } : undefined, plans: plans.map((p) => ({ id: p, approval: approvalState(p) })) };
}

function approvalState(planId: string): string {
  const a = getApproval(planId);
  if (!a) return 'pending';
  if (a.rejected) return 'rejected';
  return `approved (${a.runsUsed}/${a.runsAllowed}, ${a.by})`;
}

/** The environment a plan runs on: requested one, else the first of its surface + service env (ready first). */
export function envFor(surface: string, serviceEnv: string, want?: string): EnvRecord | undefined {
  if (want) return getEnv(want);
  const c = listEnvs().filter((e) => e.surface === surface && e.serviceEnv === serviceEnv);
  return c.find((e) => e.state === 'ready') ?? c[0];
}

function explain(planId: string, o: { series?: number; maxRounds?: number } = {}) {
  const r = resolvePlan(planId);
  const env = envFor(r.plan.surface, r.plan.env);
  const classified = classifyPlan(r.plan, { series: o.series, maxRounds: o.maxRounds, allow: allowList() });
  const v = planView({ id: planId, hash: r.hash, plan: r.plan, classified, envConfig: (env?.configItems ?? []).map((c) => `${c.what}${c.consentedAt ? '（已同意）' : '（待同意）'}`), maxRounds: o.maxRounds, warmupFailures: r.draft.warmupFailures?.filter((w) => w.planId === r.plan.id) });
  if (classified.category === 'default' && v.approval.state === 'pending') v.approval.reasons = [...v.approval.reasons, '执行时自动批准（操作者 policy）'];
  return { r, env, classified, view: v };
}

function resultOf(t: TaskRecord): ResultView {
  if (t.kind === 'explore') {
    const a = readResult<{ code?: Code; agent?: AgentResult; report?: string; runDir?: string }>(t.id);
    return resultView(t, [], t.outcome?.code ?? a?.code ?? 'STILL_RUNNING', { report: a?.report, runDir: a?.runDir, explore: a?.agent && exploreSummary(a.agent) });
  }
  const res = readResult<{ code?: Code; runs?: RunResult[]; report?: string; runDir?: string; series?: { counted: number; reachedLoop: number; reproducedRuns: number; validRuns: number; pooled: { valid: number; hits: number } } }>(t.id);
  const code: Code = t.outcome?.code ?? res?.code ?? 'STILL_RUNNING';
  const s = res?.series;
  return resultView(t, res?.runs ?? [], code, { report: res?.report, runDir: res?.runDir, series: s && { runs: s.counted, reachedLoop: s.reachedLoop, reproducedRuns: s.reproducedRuns, validRuns: s.validRuns, valid: s.pooled.valid, hits: s.pooled.hits } });
}

const tv = (t: TaskRecord) => taskView(t, readEvents(t.id) as any, readLedger(t.id));

/** Environment refusals: offline / unfit (transient, so they come after the definitive checks). */
function envRefusalOf(env: EnvRecord): Envelope | undefined {
  if (env.state === 'offline') return fail('ENV_OFFLINE', `环境 ${env.id} 已下线`, 'autotest env check <envId>（或在环境页点「重新检查」）');
  if (env.state === 'unfit') return fail(/锁屏/.test(env.reason ?? '') ? 'ENV_LOCKED' : /不在线|离线/.test(env.reason ?? '') ? 'ENV_OFFLINE' : 'ENV_UNFIT', `环境 ${env.id} 不合格：${env.reason ?? ''}`, env.suggestion);
  return undefined;
}

/** Configuration items still to consent; full access consents them (recorded as such). */
function pendingConfig(env: EnvRecord) {
  const pending = unconsented(env);
  if (!pending.length || !getFullAccess().on) return pending;
  for (const c of pending) consentConfig(env.id, c.id, `full-access（${getFullAccess().by}）`);
  return [];
}

const EXPLORE_SURFACES = ['android-app', 'android-web', 'mobile-web', 'desktop-web'];

/** Submit a quick-tier task (§5.4, capability ①): a goal in plain words, run by the agent loop. Read-only
 *  by default; --writable needs full access (the risk rules still block payment / logout / delete …). */
function submitExplore(b: any): Envelope {
  const goal = String(b.explore ?? '').trim();
  if (!goal) return fail('BAD_INPUT', '--explore 需要一句目标，例如 "看看个人主页的通知铃铛能不能打开"');
  const mode = b.mode === 'task' ? 'task' : 'explore';
  const surface = String(b.surface ?? 'android-app');
  if (!EXPLORE_SURFACES.includes(surface)) return fail('BAD_INPUT', `--surface: ${EXPLORE_SURFACES.join(' | ')}`);
  for (const [k, flag, max] of [['maxSteps', 'max-steps', 3000], ['maxMinutes', 'max-minutes', 120]] as const) {
    if (b[k] !== undefined && b[k] !== null && !(Number.isInteger(Number(b[k])) && Number(b[k]) >= 1 && Number(b[k]) <= max)) return fail('BAD_INPUT', `--${flag}: 1..${max}`);
  }
  const serviceEnv = String(b.env ?? 'prod');
  const env = envFor(surface, serviceEnv, b.envId);
  if (!env) return fail(b.envId ? 'NOT_FOUND' : 'ENV_OFFLINE', b.envId ? `没有环境 ${b.envId}` : `没有 ${surface}@${serviceEnv} 的环境`, 'autotest env list');
  const writable = !!b.writable;
  if (writable && !getFullAccess().on) return fail('APPROVAL_REQUIRED', '可写探索（--writable）需要完全授权：它会真的发消息、改资料', webUrl('/'));
  const pending = pendingConfig(env);
  if (pending.length) return fail('APPROVAL_REQUIRED', `环境 ${env.id} 的配置项尚未同意：${pending.map((c) => c.what).join('；')}`, webUrl(`/env.html?id=${encodeURIComponent(env.id)}`));
  if (b.idempotencyKey) {
    const same = listTasks().find((t) => t.idempotencyKey === String(b.idempotencyKey) && !t.parent);
    if (same) return ok('ACCEPTED', `同一幂等键的任务已存在：${same.id}`, tv(same));
  }
  const er = envRefusalOf(env);
  if (er) return er;
  const what = mode === 'explore' ? '探索' : '自然语言任务';
  if (b.dryRun) return ok('OK', `演练：${what}「${goal}」将在 ${env.id} 上运行（${writable ? '可写' : '只读'}）`, { envId: env.id, envState: env.state, mode, writable });
  const id = newTaskId();
  const num = (v: unknown) => (v === undefined || v === null ? undefined : Number(v));
  const t = createTask({ id, kind: 'explore', issue: 'explore', planId: `explore:${mode}`, planHash: '-', envId: env.id, options: { maxSteps: num(b.maxSteps), maxMinutes: num(b.maxMinutes) }, explore: { goal, mode, writable }, idempotencyKey: b.idempotencyKey ? String(b.idempotencyKey) : undefined });
  return ok('ACCEPTED', `任务 ${id} 已排队：${what} @ ${env.id}`, tv(t));
}

/** Finding n of an exploration task (or exploration run dir) → issues/explore/<id>.md for the pro tier (§5.3). */
async function exploreIssue(ref: string, n: number): Promise<Envelope> {
  const dir = getTask(ref)?.runDir ?? resolve(ref);
  if (!normalize(dir).startsWith(resolve('midscene_run') + sep)) return fail('BAD_INPUT', `${ref} 不是探索任务，也不是 midscene_run 下的探索目录`);
  if (!existsSync(join(dir, 'result.json'))) return fail('NOT_FOUND', `${ref} 还没有探索结果`);
  const r = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as AgentResult;
  if (r.kind !== 'agent') return fail('BAD_INPUT', `${ref} 不是探索结果`);
  if (!r.findings.some((f) => f.n === n)) return fail('NOT_FOUND', `${ref} 没有发现 #${n}（共 ${r.findings.length} 个）`);
  const { writeFindingIssue } = await import('../engine/agent/to-issue');
  const out = await writeFindingIssue(r, n);
  return ok('OK', `Issue ${out.id} 已生成`, { issue: out.id, file: out.file }, `Issue ${out.id} → ${out.file}\n下一步：autotest draft create ${out.id}，再 plan explain / task run`);
}

/** Submit a task (§5.3 task run): resolve → hash → environment → policy → approval → task record. */
function submit(b: any, via: 'cli' | 'web'): Envelope {
  if (b.explore !== undefined && b.explore !== null) return submitExplore(b);
  const planId = String(b.planId ?? '');
  const series = b.series !== undefined ? Number(b.series) : undefined;
  if (series !== undefined && !(Number.isInteger(series) && series >= 1 && series <= 100)) return fail('BAD_INPUT', '--series: 1..100');
  const maxRounds = b.maxRounds !== undefined ? Number(b.maxRounds) : undefined;
  if (maxRounds !== undefined && !(Number.isInteger(maxRounds) && maxRounds >= 1 && maxRounds <= 1000)) return fail('BAD_INPUT', '--max-rounds: 1..1000');
  const r = resolvePlan(planId);
  if (b.hash && b.hash !== r.hash) return fail('PLAN_HASH_MISMATCH', `给出的计划哈希 ${b.hash} ≠ 当前计划 ${r.hash}`, '重新 plan explain 后用新的哈希');
  const env = envFor(r.plan.surface, r.plan.env, b.envId);
  if (!env) return fail(b.envId ? 'NOT_FOUND' : 'ENV_OFFLINE', b.envId ? `没有环境 ${b.envId}` : `没有 ${r.plan.surface}@${r.plan.env} 的环境`, 'autotest env list');
  if (env.surface !== r.plan.surface || env.serviceEnv !== r.plan.env) return fail('BAD_INPUT', `环境 ${env.id} 不是 ${r.plan.surface}@${r.plan.env}`);
  // Environment refusals come after the policy checks: those are definitive, an unfit phone is transient.
  const envRefusal = () => envRefusalOf(env);
  const pending = pendingConfig(env);
  if (pending.length) return fail('APPROVAL_REQUIRED', `环境 ${env.id} 的配置项尚未同意：${pending.map((c) => c.what).join('；')}`, webUrl(`/env.html?id=${encodeURIComponent(env.id)}`));
  const classified = classifyPlan(r.plan, { series, maxRounds, allow: allowList() });
  if (classified.category === 'refused') return fail('PLAN_NOT_EXECUTABLE', `计划触及硬约束：${classified.reasons.join('；')}`);
  const facts = versionFacts(r.plan, env.udid, env.appVersion);
  const n = series ?? 1;
  if (b.idempotencyKey) {
    const same = listTasks().find((t) => t.idempotencyKey === String(b.idempotencyKey) && !t.parent);
    if (same) return ok('ACCEPTED', `同一幂等键的任务已存在：${same.id}`, tv(same));
  }
  // Default-class plans are approved by the policy when no live approval exists (a person's approval is
  // honoured strictly: its run count runs out → 33).
  const cur = getApproval(planId);
  // An approval the policy or full access made is renewed when a bound version changed (App update, new
  // profile …); an explicit approval (a person on the Web, an agent's `plan approve`) is honoured strictly (→ 32 / 33).
  const machineMade = !!cur && (!!cur.auto || cur.by === 'policy' || cur.by.startsWith('full-access'));
  const curLive = cur && !cur.rejected && cur.planHash === r.hash && cur.runsUsed + n <= cur.runsAllowed && !(machineMade && staleFacts(cur.facts, facts).length);
  const willAuto = !cur?.rejected && !curLive && (!cur || machineMade || cur.planHash !== r.hash) && (classified.category === 'default' || getFullAccess().on);
  // Sensitive: only a person's sensitive approval (Web) counts; a policy approval of the plain plan does not.
  if (classified.category === 'sensitive' && !getFullAccess().on && !(cur && !cur.rejected && cur.category === 'sensitive' && cur.planHash === r.hash && !cur.auto && cur.by !== 'policy' && !cur.by.startsWith('full-access')))
    return fail('APPROVAL_REQUIRED', `敏感计划需要人在 Web 上同意：${classified.reasons.join('；')}`, webUrl(`/plan.html?id=${encodeURIComponent(planId)}${series ? `&series=${series}` : ''}`));
  if (b.dryRun) {
    if (!willAuto) useApproval(planId, r.hash, facts, n, true);
    const er = envRefusal();
    if (er) return er;
    return ok('OK', `演练：计划 ${planId} 将在 ${env.id} 上运行 ${n} 次（${classified.category === 'default' ? '默认允许' : '敏感'}；${willAuto ? '执行时自动批准' : `批准 ${cur?.runsUsed}/${cur?.runsAllowed}`}）`, { planId, hash: r.hash, envId: env.id, envState: env.state, category: classified.category, reasons: classified.reasons, messagesMax: classified.messages, approval: cur ?? null, autoApprove: willAuto });
  }
  if (willAuto) approve({ planId, planHash: r.hash, confirmedHash: r.hash, facts, classified, series, runs: n, via, auto: true });
  useApproval(planId, r.hash, facts, n, true);
  const er = envRefusal();
  if (er) return er;
  const ap = useApproval(planId, r.hash, facts, n);
  const id = newTaskId();
  const t = createTask({ id, kind: series && series > 1 ? 'series' : 'issue', issue: r.ref.issue, planId, planHash: r.hash, approvalId: ap.id, envId: env.id, series: series && series > 1 ? { runs: series } : undefined, options: { maxRounds, maxSteps: b.maxSteps, maxMinutes: b.maxMinutes }, idempotencyKey: b.idempotencyKey ? String(b.idempotencyKey) : undefined });
  // Confirmation = execution: the exact plan and draft are frozen into the task dir.
  writeJsonAtomic(join(taskDir(id), 'plan.json'), r.plan);
  writeJsonAtomic(join(taskDir(id), 'draft.json'), r.draft);
  return ok('ACCEPTED', `任务 ${id} 已排队：${planId} @ ${env.id}${n > 1 ? `，系列 ${n} 次` : ''}`, tv(t));
}

export async function apiV1(q: Req, ctx: Ctx): Promise<Envelope> {
  const p = q.path.replace(/^\/api\/v1/, '');
  const seg = p.split('/').filter(Boolean).map(decodeURIComponent);
  const M = q.method;
  try {
    if (M === 'GET' && seg[0] === 'issues' && !seg[1]) {
      const list = issueIds().map((id) => issueSummary(id));
      return ok('OK', `${list.length} 个 Issue`, list, list.map((i) => `${i.id.padEnd(6)} ${i.category.padEnd(18)} ${i.draft ? `草稿 v${i.draft.version} ${i.draft.status}` : '无草稿'}  ${i.plans.map((x) => `${x.id} [${x.approval}]`).join(', ')}`).join('\n'));
    }
    if (M === 'GET' && seg[0] === 'issues' && seg[1]) {
      if (!issueExists(seg[1])) return fail('NOT_FOUND', `没有 Issue ${seg[1]}`);
      const s = issueSummary(seg[1]);
      return ok('OK', `Issue ${s.id}：${s.category}；${s.draft ? `草稿 v${s.draft.version}（${s.draft.status}）` : '无草稿'}`, s, [`Issue ${s.id}：${s.title.slice(0, 120)}`, `类别：${s.category} — ${s.reason}`, s.draft ? `草稿 v${s.draft.version} ${s.draft.hash}（${s.draft.status}）` : '无草稿（autotest draft create）', ...s.plans.map((x) => `计划 ${x.id} [${x.approval}]`)].join('\n'));
    }
    if (seg[0] === 'drafts' && seg[1]) {
      if (!issueExists(seg[1])) return fail('NOT_FOUND', `没有 Issue ${seg[1]}`);
      if (M === 'POST') {
        const { loadDraft } = await import('../scripts/issue-cli');
        const d = await loadDraft(seg[1], (q.body.env ?? 'prod') as 'test' | 'prod', q.body.model !== false, q.body.redraft !== false);
        const plans = d.status === 'plannable' ? planIdsOf(d) : [];
        return ok('OK', `草稿 v${d.version ?? 1}（${d.status}）：${plans.length ? plans.join(', ') : d.reason}`, { issue: d.issue.id, version: d.version ?? 1, hash: d.hash, status: d.status, reason: d.reason, plans });
      }
      const d = savedDraft(seg[1]);
      if (!d) return fail('NOT_FOUND', `Issue ${seg[1]} 还没有草稿`, `autotest draft create ${seg[1]}`);
      const plans = d.status === 'plannable' ? planIdsOf(d) : [];
      const views = plans.filter((x) => parsePlanId(x).surface === d.subcases.find((s) => s.sub === parsePlanId(x).sub)?.surface).map((x) => explain(x).view);
      return ok('OK', `草稿 v${d.version ?? 1}（${d.status}）`, { issue: d.issue.id, version: d.version ?? 1, hash: d.hash, status: d.status, reason: d.reason, plans, views }, views.map(planText).join('\n\n') || d.reason);
    }
    if (seg[0] === 'plans' && seg[1]) {
      const planId = seg[1];
      if (M === 'GET' && !seg[2]) {
        const e = explain(planId, { series: q.query.get('series') ? Number(q.query.get('series')) : undefined, maxRounds: q.query.get('maxRounds') ? Number(q.query.get('maxRounds')) : undefined });
        return ok('OK', e.view.summary, { ...e.view, env: e.env ? envView(e.env) : undefined }, planText(e.view));
      }
      if (M === 'POST' && seg[2] === 'approve') {
        const series = q.body.series !== undefined ? Number(q.body.series) : undefined;
        const e = explain(planId, { series });
        const env = e.env;
        const a = approve({ planId, planHash: e.r.hash, confirmedHash: String(q.body.hash ?? ''), facts: versionFacts(e.r.plan, env?.udid, env?.appVersion), classified: e.classified, runs: q.body.runs !== undefined ? Number(q.body.runs) : undefined, series, via: q.web ? 'web' : 'cli', reviewer: q.web ? reviewerName() : undefined });
        return ok('OK', `计划 ${planId} 已批准（${a.by}，${a.runsAllowed} 次）`, a);
      }
      if (M === 'POST' && seg[2] === 'reject') {
        const a = reject(planId, String(q.body.note ?? ''), q.web ? reviewerName() : 'cli');
        return ok('OK', `计划 ${planId} 已驳回：${a?.rejected?.note}`, a);
      }
    }
    if (seg[0] === 'envs') {
      if (M === 'GET' && !seg[1]) {
        const list = listEnvs().map(envView);
        return ok('OK', `${list.length} 个环境`, list, list.map((e) => e.summary).join('\n'));
      }
      const env = seg[1] ? getEnv(seg[1]) : undefined;
      if (!env) return fail('NOT_FOUND', `没有环境 ${seg[1]}`, 'autotest env list');
      if (M === 'GET' && !seg[2]) {
        const v = envView(env);
        return ok('OK', v.summary, v, [v.summary, ...(v.check?.items ?? []).map((i) => `  ${i.ok ? '✓' : '✗'} ${i.id}: ${i.detail}`), ...v.configItems.map((c) => `  配置项 ${c.id}：${c.what}（${c.consented ? `已同意 ${c.by}` : '待同意'}）`)].join('\n'));
      }
      if (M === 'POST' && seg[2] === 'consent') {
        if (!q.web) return fail('APPROVAL_REQUIRED', '环境配置项只能在 Web 上同意', webUrl(`/env.html?id=${encodeURIComponent(env.id)}`));
        const e = consentConfig(env.id, String(q.body.item ?? ''), reviewerName());
        return ok('OK', `已同意 ${q.body.item}`, envView(e));
      }
      if (M === 'POST' && seg[2] === 'check') {
        if (!ctx.sup) return fail('PLATFORM_DOWN', '平台服务未启动', 'pnpm platform');
        if (env.state === 'leased') return fail('BAD_INPUT', `环境 ${env.id} 正被任务 ${env.lease?.taskId} 使用，结束后会自动检查`);
        await ctx.sup.check(env.id, q.web ? reviewerName() : 'cli');
        const v = envView(getEnv(env.id)!);
        const code: Code = v.state === 'ready' || v.state === 'offline' ? 'OK' : v.state === 'unfit' ? (/锁屏/.test(v.reason ?? '') ? 'ENV_LOCKED' : /不在线|离线|adb/.test(v.reason ?? '') ? 'ENV_OFFLINE' : 'ENV_UNFIT') : 'OK';
        return ok(code, v.summary, v);
      }
    }
    if (seg[0] === 'tasks') {
      if (M === 'POST' && !seg[1]) return submit(q.body, q.web ? 'web' : 'cli');
      if (M === 'GET' && !seg[1]) {
        const list = listTasks().filter((t) => q.query.get('all') || !t.parent).slice(0, Number(q.query.get('limit') ?? 50)).map(tv);
        return ok('OK', `${list.length} 个任务`, list, list.map((t) => t.summary).join('\n'));
      }
      const t = seg[1] ? getTask(seg[1]) : undefined;
      if (!t) return fail('NOT_FOUND', `没有任务 ${seg[1]}`, 'autotest task list');
      if (M === 'GET' && !seg[2]) {
        const v = tv(t);
        return ok('OK', v.summary, v, taskText(v));
      }
      if (M === 'GET' && seg[2] === 'wait') {
        const deadline = Date.now() + Math.min(25, Math.max(0, Number(q.query.get('timeout') ?? 20))) * 1000;
        let cur = t;
        while (!isTerminal(cur.state) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          cur = getTask(t.id)!;
        }
        const v = tv(cur);
        if (!isTerminal(cur.state)) return ok('STILL_RUNNING', v.summary, v, taskText(v));
        return ok(cur.outcome?.code ?? 'OK', v.summary, v, taskText(v));
      }
      if (M === 'POST' && seg[2] === 'cancel') {
        if (!ctx.sup) return fail('PLATFORM_DOWN', '平台服务未启动', 'pnpm platform');
        const done = await ctx.sup.cancel(t.id, q.web ? reviewerName() : 'cli');
        if (!done) return fail('BAD_INPUT', `任务 ${t.id} 已结束（${t.state}），不能取消`);
        const v = tv(getTask(t.id)!);
        return ok('OK', `已请求取消：${v.summary}`, v);
      }
    }
    if (M === 'POST' && seg[0] === 'explore' && seg[1] && seg[2] === 'issue') return exploreIssue(seg[1], Number(q.body.n));
    if (M === 'GET' && seg[0] === 'results' && seg[1]) {
      const t = getTask(seg[1]);
      if (!t) return fail('NOT_FOUND', `没有任务 ${seg[1]}`);
      if (!isTerminal(t.state)) return ok('STILL_RUNNING', `任务 ${t.id} 仍在运行（${t.state}）`, tv(t));
      const v = resultOf(t);
      return ok(v.code, v.sentence, v, resultText(v));
    }
    if (seg[0] === 'full-access') {
      if (M === 'POST') {
        if (!q.web) return fail('APPROVAL_REQUIRED', '完全授权只能在 Web 上开关', webUrl('/'));
        const v = setFullAccess(!!q.body.on, reviewerName());
        return ok('OK', v.on ? `完全授权已开启（${v.by}）` : '完全授权已关闭', v);
      }
      const v = getFullAccess();
      return ok('OK', v.on ? `完全授权开启中（${v.by}，${v.at}）` : '完全授权关闭', v);
    }
    if (M === 'GET' && seg[0] === 'audit') {
      const xs = readAudit().slice(-Number(q.query.get('limit') ?? 200));
      return ok('OK', `${xs.length} 条审计记录`, xs);
    }
    if (M === 'GET' && seg[0] === 'reviewer') return ok('OK', reviewerName(), { name: reviewerName() });
    return fail('NOT_FOUND', `没有接口 ${M} ${q.path}`, 'autotest help --json');
  } catch (e) {
    if (e instanceof CodedError) return fail(e.code, e.message, e.hint);
    return fail('UNCAUGHT', (e as Error).message.split('\n')[0]);
  }
}

export function taskText(v: ReturnType<typeof taskView>): string {
  return [v.summary, v.progress.phaseText ? `  进度：${v.progress.phaseText}${v.progress.round !== undefined ? ` 第 ${v.progress.round} 轮` : ''}${v.progress.step !== undefined ? ` 第 ${v.progress.step} 步` : ''}（${v.progress.at ?? '-'}）` : '', v.endedBy ? `  结束方式：${v.endedBy}${v.endedAt ? `，停在 ${v.endedAt}` : ''}` : '', v.partial ? `  部分结果：有效尝试 ${v.partial.valid}，命中 ${v.partial.hits}（${v.partial.note}）` : '', `  副作用：进入 ${v.ledger.entered.join('、') || '-'}；键入 ${v.ledger.typedInto.join('、') || '-'}；发送 ${v.ledger.sent} 条`].filter(Boolean).join('\n');
}

export { STATUS, planIdOf };
