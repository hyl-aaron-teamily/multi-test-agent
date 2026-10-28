// /api/v1 (W2-3 §5–6): the one service the CLI (for agents) and the Web pages (for people) both call.
// Every answer is an envelope { status, code, exit, summary, data?, error? } built from the view models, so
// the CLI text, `--json` and the pages say the same thing. Consent-type actions (sensitive plans, full
// access, environment configuration items) are Web-only: the pages send `x-autotest-client: web`; the CLI
// never does. Local use without login — a process rule, not a security boundary (§5.1).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { profileKey } from '../drivers/factory';
import { classifyRules } from '../issue/classify';
import { parseIssue } from '../issue/parse';
import type { RunResult } from '../executor/run';
import { loadProfile } from '../skills/profile';
import { allowList, approve, classifyPlan, getApproval, getFullAccess, reject, reviewerName, setFullAccess, useApproval, webUrl } from './approval';
import { consentConfig, type EnvRecord, getEnv, listEnvs, unconsented } from './lifecycle/env';
import { STATUS, type Code, CodedError, apiError, outcome } from './lifecycle/status';
import { readAudit, writeJsonAtomic } from './lifecycle/store';
import type { Supervisor } from './lifecycle/supervisor';
import { createTask, getTask, isTerminal, listTasks, newTaskId, readEvents, readLedger, readResult, taskDir, type TaskRecord } from './lifecycle/task';
import { parsePlanId, planIdOf, planIdsOf, resolvePlan, savedDraft, versionFacts } from './plans-v1';
import { envView, planText, planView, resultText, resultView, stepMarks, taskView, type ResultView } from './views';

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

const ISSUES = () => resolve('issues');

function issueSummary(id: string) {
  const text = readFileSync(join(ISSUES(), `${id}.md`), 'utf8');
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
  const prof = loadProfile(profileKey(r.plan.surface, r.plan.env, env?.udid));
  return { r, env, classified, view: v, marks: stepMarks(v, r.plan, prof as any) };
}

function resultOf(t: TaskRecord): ResultView {
  const res = readResult<{ code?: Code; runs?: RunResult[]; report?: string; runDir?: string; series?: { counted: number; reachedLoop: number; reproducedRuns: number; validRuns: number; pooled: { valid: number; hits: number } } }>(t.id);
  const code: Code = t.outcome?.code ?? res?.code ?? 'STILL_RUNNING';
  const s = res?.series;
  return resultView(t, res?.runs ?? [], code, { report: res?.report, runDir: res?.runDir, series: s && { runs: s.counted, reachedLoop: s.reachedLoop, reproducedRuns: s.reproducedRuns, validRuns: s.validRuns, valid: s.pooled.valid, hits: s.pooled.hits } });
}

const tv = (t: TaskRecord) => taskView(t, readEvents(t.id) as any, readLedger(t.id));

/** Submit a task (§5.3 task run): resolve → hash → environment → policy → approval → task record. */
function submit(b: any, via: 'cli' | 'web'): Envelope {
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
  if (env.state === 'quarantined') return fail('ENV_QUARANTINED', `环境 ${env.id} 已隔离：${env.reason ?? ''}`, env.suggestion ?? webUrl(`/env.html?id=${encodeURIComponent(env.id)}`));
  if (env.state === 'offline') return fail('ENV_OFFLINE', `环境 ${env.id} 已下线`, 'autotest env check <envId>（或在环境页点「重新检查」）');
  if (env.state === 'unfit') return fail(/锁屏/.test(env.reason ?? '') ? 'ENV_LOCKED' : /不在线|离线/.test(env.reason ?? '') ? 'ENV_OFFLINE' : 'ENV_UNFIT', `环境 ${env.id} 不合格：${env.reason ?? ''}`, env.suggestion);
  const pending = unconsented(env);
  if (pending.length) return fail('APPROVAL_REQUIRED', `环境 ${env.id} 的配置项尚未同意：${pending.map((c) => c.what).join('；')}`, webUrl(`/env.html?id=${encodeURIComponent(env.id)}`));
  const classified = classifyPlan(r.plan, { series, maxRounds, allow: allowList() });
  if (classified.category === 'refused') return fail('PLAN_NOT_EXECUTABLE', `计划触及硬约束：${classified.reasons.join('；')}`);
  const facts = versionFacts(r.plan, env.udid, env.appVersion);
  const n = series ?? 1;
  if (b.idempotencyKey) {
    const same = listTasks().find((t) => t.idempotencyKey === String(b.idempotencyKey) && !t.parent);
    if (same) return ok('ACCEPTED', `同一幂等键的任务已存在：${same.id}`, tv(same));
  }
  if (b.dryRun) {
    const a = getApproval(planId);
    return ok('OK', `演练：计划 ${planId} 将在 ${env.id} 上运行 ${n} 次（${classified.category === 'default' ? '默认允许' : '敏感'}；批准 ${a ? `${a.runsUsed}/${a.runsAllowed}` : '无'}）`, { planId, hash: r.hash, envId: env.id, envState: env.state, category: classified.category, reasons: classified.reasons, messagesMax: classified.messages, approval: a ?? null });
  }
  // Default-class plans are approved by the policy when no live approval exists (a person's approval is
  // honoured strictly: its run count runs out → 33).
  const cur = getApproval(planId);
  const curLive = cur && !cur.rejected && cur.planHash === r.hash && cur.runsUsed + n <= cur.runsAllowed;
  if (!cur?.rejected && !curLive && (!cur || cur.by === 'policy' || cur.planHash !== r.hash) && (classified.category === 'default' || getFullAccess().on))
    approve({ planId, planHash: r.hash, confirmedHash: r.hash, facts, classified, series, runs: n, via });
  // Sensitive: only a person's sensitive approval (Web) counts; a policy approval of the plain plan does not.
  if (classified.category === 'sensitive' && !getFullAccess().on && !(cur && !cur.rejected && cur.category === 'sensitive' && cur.planHash === r.hash && cur.by !== 'policy'))
    return fail('APPROVAL_REQUIRED', `敏感计划需要人在 Web 上同意：${classified.reasons.join('；')}`, webUrl(`/plan.html?id=${encodeURIComponent(planId)}${series ? `&series=${series}` : ''}`));
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
      const list = readdirSync(ISSUES()).filter((f) => f.endsWith('.md')).map((f) => issueSummary(f.slice(0, -3)));
      return ok('OK', `${list.length} 个 Issue`, list, list.map((i) => `${i.id.padEnd(6)} ${i.category.padEnd(18)} ${i.draft ? `草稿 v${i.draft.version} ${i.draft.status}` : '无草稿'}  ${i.plans.map((x) => `${x.id} [${x.approval}]`).join(', ')}`).join('\n'));
    }
    if (M === 'GET' && seg[0] === 'issues' && seg[1]) {
      if (!existsSync(join(ISSUES(), `${seg[1]}.md`))) return fail('NOT_FOUND', `没有 Issue ${seg[1]}`);
      const s = issueSummary(seg[1]);
      return ok('OK', `Issue ${s.id}：${s.category}；${s.draft ? `草稿 v${s.draft.version}（${s.draft.status}）` : '无草稿'}`, s, [`Issue ${s.id}：${s.title.slice(0, 120)}`, `类别：${s.category} — ${s.reason}`, s.draft ? `草稿 v${s.draft.version} ${s.draft.hash}（${s.draft.status}）` : '无草稿（autotest draft create）', ...s.plans.map((x) => `计划 ${x.id} [${x.approval}]`)].join('\n'));
    }
    if (seg[0] === 'drafts' && seg[1]) {
      if (!existsSync(join(ISSUES(), `${seg[1]}.md`))) return fail('NOT_FOUND', `没有 Issue ${seg[1]}`);
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
        return ok('OK', e.view.summary, { ...e.view, marks: e.marks, env: e.env ? envView(e.env) : undefined }, planText(e.view));
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
        return ok('OK', v.summary, v, [v.summary, ...(v.baseline?.items ?? []).map((i) => `  ${i.ok ? '✓' : '✗'} ${i.id}: ${i.detail}`), ...v.configItems.map((c) => `  配置项 ${c.id}：${c.what}（${c.consented ? `已同意 ${c.by}` : '待同意'}）`)].join('\n'));
      }
      if (M === 'POST' && seg[2] === 'consent') {
        if (!q.web) return fail('APPROVAL_REQUIRED', '环境配置项只能在 Web 上同意', webUrl(`/env.html?id=${encodeURIComponent(env.id)}`));
        const e = consentConfig(env.id, String(q.body.item ?? ''), reviewerName());
        return ok('OK', `已同意 ${q.body.item}`, envView(e));
      }
      if (M === 'POST' && ['check', 'recover', 'offline', 'online'].includes(seg[2])) {
        if (!ctx.sup) return fail('PLATFORM_DOWN', '平台服务未启动', 'pnpm platform');
        const by = q.web ? reviewerName() : 'cli';
        if (seg[2] === 'offline') await ctx.sup.offline(env.id, by);
        else if (seg[2] === 'recover') await ctx.sup.recover(env.id);
        else await ctx.sup.online(env.id, by);
        const v = envView(getEnv(env.id)!);
        const code: Code = v.state === 'ready' || v.state === 'offline' ? 'OK' : v.state === 'quarantined' ? 'ENV_QUARANTINED' : v.state === 'unfit' ? (/锁屏/.test(v.reason ?? '') ? 'ENV_LOCKED' : /不在线|离线|adb/.test(v.reason ?? '') ? 'ENV_OFFLINE' : 'ENV_UNFIT') : 'OK';
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
        // A terminal task with a closed recovery (or none needed) is final.
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
  return [v.summary, v.progress.phaseText ? `  进度：${v.progress.phaseText}${v.progress.round !== undefined ? ` 第 ${v.progress.round} 轮` : ''}${v.progress.step !== undefined ? ` 第 ${v.progress.step} 步` : ''}（${v.progress.at ?? '-'}）` : '', v.endedBy ? `  结束方式：${v.endedBy}${v.endedAt ? `，停在 ${v.endedAt}` : ''}` : '', v.partial ? `  部分结果：有效尝试 ${v.partial.valid}，命中 ${v.partial.hits}（${v.partial.note}）` : '', v.recovery ? `  环境恢复：${v.recovery.result}${v.recovery.reason ? ` — ${v.recovery.reason}` : ''}` : '', `  副作用：进入 ${v.ledger.entered.join('、') || '-'}；键入 ${v.ledger.typedInto.join('、') || '-'}；发送 ${v.ledger.sent} 条`].filter(Boolean).join('\n');
}

/** /api/v1/refs/<profile dir>/<file>: calibration screenshots (read-only, inside skills/teamily/refs). */
export function refFile(rel: string): string | undefined {
  const root = resolve('skills/teamily/refs');
  const full = normalize(resolve(root, decodeURIComponent(rel).replace(/^refs\//, '')));
  return full.startsWith(root + sep) && existsSync(full) ? full : undefined;
}

export { STATUS, planIdOf };
