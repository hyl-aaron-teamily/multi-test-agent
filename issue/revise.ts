// Plan revision (W3-1 §8.2): a model-authored plan version that did not reproduce goes back to the model with
// its run evidence (SKILL §6) and comes back as the next version, at most 3. Triggers: the warm-up failed
// (not executable; includes a target that failed `must` 3 times), the drift rate exceeded the threshold, or no
// hit within the budget. Revising stops when the model diagnoses a missing block or the environment
// substitution. With full access on, the new version is approved by policy and queued at once; otherwise it
// waits for the usual approval.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from '../engine/plan/run';
import { DRIFT_THRESHOLD } from '../engine/plan/loop';
import { MAX_PLAN_VERSIONS, type RevisionMaterials } from './author';
import { DRAFTS_DIR, saveDraft } from './drafts';
import { issuePath } from './paths';
import { type Draft, reviseIssue, type VersionRecord } from './planner';

export type RevisionTrigger = RevisionMaterials['trigger'];

/** Pure: why a run of a model-authored plan should be revised (undefined = no revision: reproduced, legacy
 *  plan, cancelled, or a failure of the environment / tool that says nothing about the plan). */
export function revisionTrigger(r: Pick<RunResult, 'planVersion' | 'conclusion' | 'executability' | 'cancelled' | 'error' | 'conclusionDetail' | 'sub'>): RevisionTrigger | undefined {
  if (!r.planVersion || r.cancelled) return undefined;
  if (r.conclusion === '计划不可执行') return 'warmup';
  if (r.conclusion === '执行失败' && /目标核对连续|前置条件未建立|not in the @ picker/.test(`${r.error ?? ''} ${r.conclusionDetail}`)) return 'warmup';
  // Control: no hit is the expected result; a hit means the check / environment is wrong.
  if (r.sub === 'control' || /-control-/.test((r as { planId?: string }).planId ?? '')) return r.conclusion === '已复现' ? 'control-hit' : r.executability?.unstable ? 'drift' : undefined;
  if (r.conclusion === '已复现') return undefined;
  if (r.executability?.unstable) return 'drift';
  if (r.conclusion === '未复现') return 'no-hit';
  return undefined;
}

/** Pure: the drift reasons of a run, grouped. */
export function driftReasons(r: Pick<RunResult, 'roundLog'>): { reason: string; n: number }[] {
  const m = new Map<string, number>();
  for (const l of r.roundLog) for (const x of l.results) if (x.kind === 'drift') {
    const k = x.detail.replace(/\br\w{6}\b|\d+/g, '#').slice(0, 160);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n).slice(0, 10);
}

/** Pure: SKILL §6 materials from a run. */
export function materialsOf(r: RunResult, trigger: RevisionTrigger): RevisionMaterials {
  return {
    version: r.planVersion ?? 1,
    planIds: [r.planId],
    trigger,
    warmup: (r.warmup?.steps ?? []).map((w) => ({ step: w.step, action: w.action, expected: w.expected, observed: `${w.observed}${w.expect ? `；expect（${w.expect.role}）${w.expect.pass === null ? '读不出' : w.expect.pass ? '成立' : '不成立'}：${w.expect.detail}` : ''}`, pass: w.pass })),
    expectFailures: [...(r.mustLog ?? []).map((m) => ({ round: 0, at: `targets.${m.id}`, role: 'must', detail: `第 ${m.try} 次选中的目标不满足 must：${m.detail}` })), ...(r.expectLog ?? []).map((x) => ({ round: x.round, at: x.at, role: x.role, detail: `${x.pass === null ? '读不出' : '不成立'}：${x.detail}` }))],
    driftReasons: driftReasons(r),
    samples: r.samples ?? [],
    attempts: { valid: r.attempts?.valid ?? 0, hits: r.attempts?.hits ?? 0, drift: r.attempts?.drift ?? 0 },
    conclusion: r.conclusion,
    detail: r.conclusionDetail,
  };
}

/** Pure: one version's record (W3-1 §8.1). */
export function versionRecordOf(r: RunResult, taskId: string): VersionRecord {
  return {
    version: r.planVersion ?? 1,
    planIds: [r.planId],
    taskIds: [taskId],
    validated: true,
    warmup: r.executability?.warmup ?? (r.conclusion === '计划不可执行' ? 'failed' : r.warmup ? 'passed' : 'not-run'),
    driftRate: r.executability?.driftRate,
    valid: r.attempts?.valid ?? 0,
    hits: r.attempts?.hits ?? 0,
    wilson: r.attempts?.wilson,
    conclusion: r.conclusion,
  };
}

/** Pure: does the model's diagnosis stop revising (missing block / environment substitution)? */
export function stopsRevising(d: Pick<Draft, 'status' | 'envelope'>): VersionRecord['attribution'] | undefined {
  if (d.status === 'needs-block') return 'needs-block';
  // The diagnosis leads with its category (SKILL §6: 对象 / 触发 / 观察位置 / 区分度 / 环境替代 / 缺积木); only that
  // lead counts — the rest may well say what it is NOT (「观察位置不合格，不是缺积木」).
  const head = `${d.envelope?.revision?.diagnosis ?? ''}`.trim().split(/[：:，,。；;（(]/)[0];
  if (/缺积木|missing block|needs-block/i.test(head)) return 'needs-block';
  if (/环境替代|substitution/i.test(head)) return 'substitution';
  return undefined;
}

export interface RevisionOutcome {
  /** What happened, one line for logs / the task record. */
  note: string;
  draft?: Draft;
  /** Plan id of the new version (same sub-case and surface), when there is one. */
  planId?: string;
}

/** After a run of a model-authored plan: record the version's outcome in the saved draft, and when a trigger
 *  applies (and the cap / diagnosis allow) ask the model for the next version and save it. */
export async function reviseAfterRun(r: RunResult, taskId: string, sub: string, o: { revise?: typeof reviseIssue } = {}): Promise<RevisionOutcome> {
  const trigger = revisionTrigger(r);
  const f = join(DRAFTS_DIR, `${r.issue}.json`);
  if (!existsSync(f)) return { note: `没有 Issue ${r.issue} 的草稿，不修订` };
  const prev = JSON.parse(readFileSync(f, 'utf8')) as Draft;
  if (!r.planVersion || (prev.planVersion ?? 1) !== r.planVersion) return { note: `草稿已不是计划 v${r.planVersion ?? '?'}，不修订` };
  const rec = versionRecordOf(r, taskId);
  prev.history = [...(prev.history ?? []).filter((h) => h.version !== rec.version), rec];
  // The draft's own Issue file; drafts made before issueFile existed: issues/ (incl. upload/), then the samples.
  const file = [prev.issueFile, issuePath(r.issue), join('fixtures', 'issues', `${r.issue}.md`)].find((f): f is string => !!f && existsSync(f));
  if (!file) return { note: `找不到 Issue ${r.issue} 的原文文件，不修订` };
  prev.issueFile ??= file;
  const issueText = readFileSync(file, 'utf8');
  if (!trigger) {
    await saveDraft(prev, issueText, prev.env ?? r.env);
    return { note: `计划 v${r.planVersion}：${r.conclusion}，不需要修订` };
  }
  if (r.planVersion >= MAX_PLAN_VERSIONS) {
    rec.attribution = 'plan';
    await saveDraft(prev, issueText, prev.env ?? r.env);
    return { note: `计划 v1–v${r.planVersion} 未能复现：已到修订上限 ${MAX_PLAN_VERSIONS} 版，归因于计划` };
  }
  const next = await (o.revise ?? reviseIssue)(prev, materialsOf(r, trigger), { raw: issueText });
  if (!next) return { note: '没有生成新版本（草稿不可修订）' };
  rec.diagnosis = next.envelope?.revision?.diagnosis;
  next.history = prev.history;
  next.issueFile = prev.issueFile;
  const stop = stopsRevising(next);
  if (stop) {
    rec.attribution = stop;
    await saveDraft(prev, issueText, prev.env ?? r.env);
    return { note: `计划 v1–v${r.planVersion} 未能复现：模型诊断为${stop === 'needs-block' ? '缺积木' : '环境替代导致无法复现'}，停止修订（${(rec.diagnosis ?? next.reason).slice(0, 200)}）` };
  }
  const saved = await saveDraft(next, issueText, prev.env ?? r.env);
  if (saved.status !== 'plannable') return { note: `计划 v${next.planVersion} 未生成：${saved.reason}`, draft: saved };
  const sc = saved.subcases.find((s) => s.sub === sub) ?? saved.subcases[0];
  const { planIdOf } = await import('../platform/plans-v1');
  const planId = planIdOf({ issue: saved.issue.id, sub: sc.sub, surface: r.surface, version: saved.version ?? 1 });
  return { note: `${{ warmup: '预热不通过', drift: `偏离率超过 ${DRIFT_THRESHOLD * 100}%`, 'no-hit': '预算内未命中', 'control-hit': '对照组也命中' }[trigger]} → 计划 v${saved.planVersion}（${planId}）：${rec.diagnosis ?? ''}`.slice(0, 400), draft: saved, planId };
}
