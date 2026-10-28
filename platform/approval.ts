// Approval policy (W2-3 §5.1, F3). Operations inside the app under test are allowed by default (approved
// by `policy`); sensitive plans need a person's button on the Web; full access approves everything; hard
// rules (§9) are refused whatever the switch. An approval binds the plan hash, SKILL / profile / App /
// Issue versions and the number of runs it allows; execution checks all of them (31 / 32 / 33).
// Local only, no login: "CLI cannot approve sensitive plans" is a process rule, not a security boundary.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { constructionAllowed, loadConversations } from './conversations';
import { CodedError } from './lifecycle/status';
import { audit, readJson, stateRoot, withLock, writeJsonAtomic } from './lifecycle/store';
import { staleFacts, type VersionFacts } from './plans-v1';
import type { PlannedAction, TestPlan } from './schema/test-plan';

export const SENSITIVE = { maxMessages: 50, maxSeries: 20 };

export type ApprovalClass = 'default' | 'sensitive' | 'refused';

export interface Classified {
  category: ApprovalClass;
  /** Why (each a plain sentence). */
  reasons: string[];
  /** Upper bound of messages one run sends. */
  messages: number;
}

const SEND = new Set(['teamily.sendMessage', 'teamily.quoteReply', 'teamily.tapSend']);
const sends = (xs: PlannedAction[] | undefined) => (xs ?? []).filter((a) => a.node && SEND.has(a.node.name)).length;
/** Operation drifts stop a run after 10 (executor/loop.ts) — the 11th ends it. */
export const MAX_DRIFT_ROUNDS = 11;

/** Pure: upper bound of loop rounds (valid attempts + drift rounds, capped by the step limit). */
export function roundBound(p: TestPlan, maxRounds?: number): number {
  const bySteps = Math.floor((p.limits.maxSteps ?? 1000) / Math.max(1, p.actions.length));
  const r = maxRounds ?? p.limits.maxRounds;
  return r ? Math.min(r + MAX_DRIFT_ROUNDS, bySteps) : bySteps;
}

/** Pure: upper bound of messages one run of the plan sends (warm-up round included). */
export function messageBound(p: TestPlan, maxRounds?: number): number {
  if (p.category === 'feature') return sends(p.setup) + sends(p.prepare) + (p.acceptance ?? []).reduce((n, a) => n + sends(a.actions), 0);
  const perRound = sends(p.actions) + sends(p.afterCheck);
  return sends(p.setup) + sends(p.prepare) + sends(p.correctPath) + perRound * (roundBound(p, maxRounds) + 1) + sends(p.epilogue?.actions);
}

const OUTSIDE_KEYS = /^(home|app_switch|settings|power|3|187|26)$/i;
const HARD = /delete|recall|撤回|删除|unsend|locksettings|lockscreen|password|pin\b/i;

/** Pure: classify a plan (+ how it is run). `allow` = allow-listed construction conversations. */
export function classifyPlan(p: TestPlan, o: { series?: number; maxRounds?: number; allow?: string[] } = {}): Classified {
  const all = [...p.setup, ...p.prepare, ...p.actions, ...p.afterCheck, ...(p.correctPath ?? []), ...(p.epilogue?.actions ?? []), ...(p.acceptance ?? []).flatMap((a) => a.actions)];
  const refused: string[] = [];
  const sensitive: string[] = [];
  for (const a of all) {
    const name = a.node?.name ?? '';
    if (HARD.test(name) || (a.type === 'type' && /locksettings/i.test(a.value ?? ''))) refused.push(`动作 ${name || a.type} 触及硬约束（删除 / 撤回消息、锁屏 PIN）`);
    if (name && !name.startsWith('teamily.')) sensitive.push(`动作 ${name} 不是被测软件的 SKILL 操作`);
    if (a.type === 'key' && OUTSIDE_KEYS.test(a.value ?? '')) sensitive.push(`按键 ${a.value} 会离开被测软件（系统界面）`);
  }
  const messages = messageBound(p, o.maxRounds);
  // Sending only into allow-listed conversations (prod): elsewhere is a hard refusal.
  if (messages > 0 && p.env === 'prod' && o.allow) {
    for (const t of p.targets.filter((t) => /conversation/.test(t.kind))) {
      const title = t.guidance.match(/titled "([^"]+)"/)?.[1];
      const own = /Personal AI/i.test(t.guidance);
      if (!own && !(title && constructionAllowed(title, o.allow))) refused.push(`会在允许清单外的会话发送消息（目标 ${t.id}：${t.guidance.slice(0, 60)}）`);
    }
  }
  if (messages > SENSITIVE.maxMessages) sensitive.push(`单次运行最多发送 ${messages} 条消息（> ${SENSITIVE.maxMessages}）`);
  if ((o.series ?? 1) > SENSITIVE.maxSeries) sensitive.push(`系列 ${o.series} 次（> ${SENSITIVE.maxSeries}）`);
  if (refused.length) return { category: 'refused', reasons: refused, messages };
  if (sensitive.length) return { category: 'sensitive', reasons: sensitive, messages };
  return { category: 'default', reasons: ['计划只用 SKILL Node 操作被测软件，按策略默认允许'], messages };
}

// ---------- full access

export interface FullAccess {
  on: boolean;
  by?: string;
  at?: string;
}
const faFile = () => join(stateRoot(), 'full-access.json');
export const getFullAccess = (): FullAccess => readJson<FullAccess>(faFile()) ?? { on: false };

export function setFullAccess(on: boolean, by: string): FullAccess {
  const v: FullAccess = { on, by, at: new Date().toISOString() };
  writeJsonAtomic(faFile(), v);
  audit({ by, action: on ? 'full-access.on' : 'full-access.off', object: 'full-access' });
  return v;
}

// ---------- reviewer

export function reviewerName(file = resolve('platform/reviewer.local.yaml')): string {
  if (!existsSync(file)) return 'reviewer';
  const raw = (yaml.load(readFileSync(file, 'utf8')) ?? {}) as { name?: string };
  return raw.name ? String(raw.name) : 'reviewer';
}

// ---------- approvals

export interface Approval {
  id: string;
  planId: string;
  planHash: string;
  facts: VersionFacts;
  category: ApprovalClass;
  reasons: string[];
  /** Runs allowed (a series of N counts N). */
  runsAllowed: number;
  runsUsed: number;
  series?: number;
  by: string;
  at: string;
  rejected?: { by: string; note: string; at: string };
}

const apDir = () => join(stateRoot(), 'approvals');
const apFile = (id: string) => join(apDir(), `${id}.json`);
const apId = (planId: string) => planId.replace(/[^\w.@-]/g, '_');

export function listApprovals(): Approval[] {
  if (!existsSync(apDir())) return [];
  return readdirSync(apDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson<Approval>(join(apDir(), f))!)
    .filter(Boolean);
}

export const getApproval = (planId: string) => readJson<Approval>(apFile(apId(planId)));

export interface ApproveInput {
  planId: string;
  planHash: string;
  /** The hash the caller confirmed (must equal planHash → else 31). */
  confirmedHash: string;
  facts: VersionFacts;
  classified: Classified;
  runs?: number;
  series?: number;
  /** 'cli' | 'web:<reviewer>'. Sensitive plans: web only (or full access). */
  via: 'cli' | 'web';
  reviewer?: string;
}

/** Approve a plan. Default class → by `policy`; sensitive → a person on the Web, or `full-access`; refused
 *  → never. Re-approving resets the run count. */
export function approve(i: ApproveInput): Approval {
  if (i.confirmedHash !== i.planHash) throw new CodedError('PLAN_HASH_MISMATCH', `确认的计划哈希 ${i.confirmedHash} ≠ 当前计划 ${i.planHash}`, '重新查看计划（plan explain）再确认');
  const c = i.classified;
  if (c.category === 'refused') throw new CodedError('PLAN_NOT_EXECUTABLE', `计划触及硬约束，任何情况下都不执行：${c.reasons.join('；')}`);
  const fa = getFullAccess();
  let by: string;
  if (c.category === 'default') by = i.via === 'web' ? (i.reviewer ?? reviewerName()) : 'policy';
  else if (i.via === 'web') by = i.reviewer ?? reviewerName();
  else if (fa.on) by = `full-access（${fa.by} 开启）`;
  else throw new CodedError('APPROVAL_REQUIRED', `敏感计划需要人在 Web 上同意：${c.reasons.join('；')}`, `打开 ${webUrl(`/plan.html?id=${encodeURIComponent(i.planId)}`)}`);
  const a: Approval = { id: apId(i.planId), planId: i.planId, planHash: i.planHash, facts: i.facts, category: c.category, reasons: c.reasons, runsAllowed: i.series ?? i.runs ?? 1, runsUsed: 0, series: i.series, by, at: new Date().toISOString() };
  writeJsonAtomic(apFile(a.id), a);
  audit({ by, action: 'plan.approve', object: i.planId, after: { hash: i.planHash, runs: a.runsAllowed, category: c.category }, basis: c.reasons.join('；') });
  return a;
}

export function reject(planId: string, note: string, by: string): Approval | undefined {
  if (!note.trim()) throw new CodedError('BAD_INPUT', '驳回必须填写意见');
  const a = getApproval(planId);
  const rec: Approval = a ?? { id: apId(planId), planId, planHash: '', facts: { skillVersion: '' }, category: 'default', reasons: [], runsAllowed: 0, runsUsed: 0, by: '', at: '' };
  rec.rejected = { by, note: note.trim(), at: new Date().toISOString() };
  writeJsonAtomic(apFile(rec.id), rec);
  audit({ by, action: 'plan.reject', object: planId, basis: note.trim() });
  return rec;
}

/** Check an approval before a run and use `n` runs of it (31 / 32 / 33 / 30). Atomic under a lock. */
export function useApproval(planId: string, planHash: string, facts: VersionFacts, n: number): Approval {
  return withLock(`approval-${apId(planId)}`, () => {
    const a = getApproval(planId);
    if (!a || !a.planHash) throw new CodedError('APPROVAL_REQUIRED', `计划 ${planId} 尚未批准`, '先 autotest plan approve <planId> --hash <h>（敏感计划在 Web 同意）');
    if (a.rejected) throw new CodedError('APPROVAL_REQUIRED', `计划 ${planId} 已被 ${a.rejected.by} 驳回：${a.rejected.note}`, '修改后重新生成草稿并审核');
    if (a.planHash !== planHash) throw new CodedError('PLAN_HASH_MISMATCH', `执行的计划哈希 ${planHash} ≠ 批准的 ${a.planHash}`, '重新审核计划');
    const stale = staleFacts(a.facts, facts);
    if (stale.length) throw new CodedError('PLAN_STALE', `批准后版本变化：${stale.join('；')}`, '重新审核计划（plan explain → plan approve）');
    if (a.runsUsed + n > a.runsAllowed) throw new CodedError('APPROVAL_EXHAUSTED', `已用 ${a.runsUsed}/${a.runsAllowed} 次，本次需要 ${n} 次`, '重新批准以获得新的运行次数');
    a.runsUsed += n;
    writeJsonAtomic(apFile(a.id), a);
    audit({ by: 'platform', action: 'approval.use', object: planId, after: `${a.runsUsed}/${a.runsAllowed}` });
    return a;
  });
}

export const webUrl = (path: string) => `http://localhost:${process.env.PLATFORM_PORT ?? 3210}${path}`;

/** Allow-listed construction conversations (prod). */
export const allowList = () => loadConversations().construct.allow;
