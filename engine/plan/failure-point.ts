// W3-7 §8.1 ①② — where a run of an Issue plan stopped (a path in the plan) and whose failure it is.
// Only a plan failure is repaired; an executor failure never costs the plan anything (it is rerun once, then
// recorded as 「执行端失败」 against the block); the environment waits for the environment; 「不确定」 is rerun
// once and counts as the plan's when it fails on the same path again.
import type { RunResult } from './run';

export type Cause = 'environment' | 'executor' | 'plan' | 'uncertain';

export interface FailurePoint {
  phase: 'preflight' | 'prepare' | 'warmup' | 'loop' | 'run';
  /** Plan path (`baseline[0]`, `actions[2].expect`, `targets.msg.must`, `setup[1]`, `afterCheck[0]` …); '' = none. */
  path: string;
  expected: string;
  observed: string;
  cause: Cause;
  /** Why this cause (one line, for the record). */
  basis: string;
}

type Run = Pick<RunResult, 'conclusion' | 'conclusionDetail' | 'cancelled' | 'error' | 'failure' | 'warmup' | 'at' | 'errorKind' | 'executability' | 'roundLog' | 'mustLog'>;

/** Pure: reading failed (an exception, no reader) rather than reading a result. */
const unreadable = (s: string) => /read failed|has no reader|cannot be read|读不出|unreadable/i.test(s);

/** Pure: the failure point of a run, undefined when there is nothing to repair (reproduced, cancelled, a
 *  verdict reached without instability). */
export function failurePoint(r: Run): FailurePoint | undefined {
  if (r.cancelled) return undefined;
  const text = `${r.error ?? ''} ${r.conclusionDetail}`;
  if (r.conclusion === '环境不合格' || r.failure?.kind === 'env') return { phase: 'preflight', path: '', expected: '设备可用', observed: r.conclusionDetail || r.error || '', cause: 'environment', basis: r.failure?.rule ?? '预检' };
  if (r.errorKind === 'environment') return { phase: r.at ? 'prepare' : 'run', path: r.at ?? '', expected: '环境就绪', observed: r.error ?? '', cause: 'environment', basis: 'Node 报环境问题' };
  if (r.conclusion === 'SKILL 失效') return { phase: 'run', path: '', expected: 'SKILL 元素在屏', observed: r.conclusionDetail, cause: 'executor', basis: 'SKILL 失效（积木的事）' };

  // ---- warm-up: the failing step carries its path (warmup.ts)
  if (r.conclusion === '计划不可执行') {
    const st = r.warmup?.steps.find((s) => s.pass === false) ?? r.warmup?.steps.at(-1);
    const path = st?.path ?? '';
    const observed = st?.observed ?? r.conclusionDetail;
    const base = { phase: 'warmup' as const, path, expected: st?.expected ?? '', observed };
    if (st?.kind === 'executor') return { ...base, cause: 'executor', basis: 'Node 在正确页面上但动作没生效' };
    if (st?.kind === 'environment') return { ...base, cause: 'environment', basis: 'Node 报环境问题' };
    if (st?.kind === 'precondition') return { ...base, cause: 'plan', basis: 'Node 不在该在的页面上（前面的步骤写错了）' };
    if (unreadable(observed) || unreadable(st?.expect?.detail ?? '')) return { ...base, cause: 'uncertain', basis: '读数为空（读取异常或无法读取）' };
    // The effect gate of an action (screen did not change / region did not show): a read result, but it can be the
    // executor's tap that missed as well as a wrong step — rerun once before blaming the plan.
    if (/^actions\[\d+\]$/.test(path) && !/expect/.test(observed)) return { ...base, cause: 'uncertain', basis: '动作的效果没出现（可能是执行端，也可能是计划）' };
    return { ...base, cause: 'plan', basis: '检查读到了，结果不成立' };
  }

  // ---- preparation (and errors escaping the warm-up): the path the executor was on
  if (r.conclusion === '执行失败' && r.error) {
    const phase = r.at && /^actions\[/.test(r.at) ? ('warmup' as const) : r.at ? ('prepare' as const) : ('run' as const);
    const base = { phase, path: r.at ?? '', expected: '', observed: r.error };
    if (/目标核对连续/.test(text)) return { ...base, path: r.at ?? `targets.${r.mustLog?.at(-1)?.id ?? ''}.must`, expected: '目标满足 must', cause: 'plan', basis: 'must 连续不通过' };
    if (/前置条件未建立/.test(text)) return { ...base, expected: '前置条件成立', cause: unreadable(text) ? 'uncertain' : 'plan', basis: '前置检查读到了，不成立' };
    if (r.errorKind === 'executor') return { ...base, cause: 'executor', basis: 'Node 在正确页面上但动作没生效' };
    if (r.errorKind === 'precondition') return { ...base, cause: 'plan', basis: 'Node 不在该在的页面上（前面的步骤写错了）' };
    return { ...base, cause: 'uncertain', basis: '没打标记的异常' };
  }

  // ---- loop: the round drift above the threshold → the most frequent reason's path
  if (r.executability?.unstable) {
    const reasons = new Map<string, number>();
    for (const l of r.roundLog) for (const x of l.results) if (x.kind === 'drift') reasons.set(x.detail, (reasons.get(x.detail) ?? 0) + 1);
    const [top] = [...reasons].sort((a, b) => b[1] - a[1]);
    const path = top?.[0].match(/(?:afterCheck|baseline|actions|require)\[\d+\](?:\.expect)?/)?.[0] ?? 'actions';
    return { phase: 'loop', path, expected: '每轮前置成立', observed: top ? `${top[1]} 轮：${top[0]}` : r.conclusionDetail, cause: 'plan', basis: `整轮偏离超过阈值（${(r.executability.driftRate * 100).toFixed(0)}%）` };
  }
  return undefined;
}

/** Pure: execution order of plan paths (preparation → warm-up proof → actions → restore), for "the failure point
 *  moved on" (§8.1 ⑦). Same order = same path. */
export function pathRank(path: string): number {
  const n = (re: RegExp) => Number(path.match(re)?.[1] ?? 0);
  if (/^targets\./.test(path)) return 100;
  if (/^setup\[/.test(path)) return 200 + n(/^setup\[(\d+)\]/);
  if (/^prepare\[/.test(path)) return 300 + n(/^prepare\[(\d+)\]/);
  if (/^prepareChecks?/.test(path)) return 400 + n(/^prepareChecks\[(\d+)\]/);
  if (/^baseline\[/.test(path)) return 500 + n(/^baseline\[(\d+)\]/);
  if (/^actions\[\d+\]/.test(path)) return 600 + 2 * n(/^actions\[(\d+)\]/) + (/\.expect$/.test(path) ? 1 : 0);
  if (/^afterCheck/.test(path)) return 800 + n(/^afterCheck\[(\d+)\]/);
  return 900;
}

/** Pure: plan notation → JSON pointer of the plan record (issue/record.ts): `actions[2].expect` →
 *  `/subcases/main/plan/actions/2/expect`; `targets.msg.must` → `/subcases/main/plan/targets/msg/must`. */
export function toPointer(sub: string, path: string): string {
  const p = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).join('/');
  return `/subcases/${sub}/plan${p ? `/${p}` : ''}`;
}
