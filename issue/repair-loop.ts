// W3-7 §8.1 — locate → attribute → evidence → fix → validate → verify → continue or stop, in one task.
// Verification is the next run of the repaired plan: its warm-up gate is the check (a failing warm-up stops the
// run before the loop, ~35 s); when it passes, the same run goes on to the full budget (§8.1 ⑦ 「在同一任务里
// 跑完整预算」). The phone lease is released between runs (runPlan releases it), so the model wait holds nothing.
import type { RunResult } from '../engine/plan/run';
import { type FailurePoint, failurePoint } from '../engine/plan/failure-point';
import type { TestPlan } from '../platform/schema/test-plan';
import { type PlanRecord, patchRecord, revOf, stateOf } from './record';
import { type AskRepair, blockers, defaultAskRepair, deterministicFix, type Fix, fixFromAnswer, nextMove, repairCase, repairPrompt, type RepairStep, repairSystem } from './repair';

export interface LoopDeps {
  /** Run a plan (the task's environment, hooks). */
  run: (plan: TestPlan) => Promise<RunResult>;
  load: () => PlanRecord | undefined;
  save: (r: PlanRecord) => Promise<void>;
  /** The Issue text (validation of quotes; the quoted lines for the model). */
  raw?: string;
  /** D6 on the repaired plan: ok = may run now; otherwise why it waits for a person. */
  approve: (plan: TestPlan) => { ok: boolean; why: string };
  ask?: AskRepair;
  log?: (s: string) => void;
  /** W7-R13: the verified repair as a case in the memory service's Skill library. */
  remember?: (c: ReturnType<typeof repairCase>) => Promise<unknown>;
  /** R13 warnings for the plan (W3-7 §8.2). */
  warnings?: (plan: TestPlan) => string[];
  cancelled?: () => boolean;
}

export interface LoopOutcome {
  /** Runs made by the loop (reruns and repaired versions), in order. */
  runs: RunResult[];
  steps: RepairStep[];
  /** Why it stopped (one line). */
  stop: string;
  /** Set when it stopped for a person: the step, its evidence, and the suggestion that was not applied. */
  handoff?: { path: string; cause: FailurePoint['cause']; observed: string; suggestion?: Fix; why: string };
  /** 「执行端失败」: the block to fix (W3-7 §8.1 ⑪ re-queue key). */
  executor?: { path: string; detail: string };
}

/** Pure: the quoted Issue lines (what the quotes say), not the whole Issue. */
const quotedLines = (r: PlanRecord) => (r.envelope?.quotes ?? []).map((q) => `${q.id}${q.lines ? ` ${q.lines}` : ''}: ${q.text}`).join('\n');

/** Pure: a rev of the record whose content is the same as `env` (going back and forth). */
export function sameAsRev(r: PlanRecord, next: PlanRecord): number | undefined {
  const s = JSON.stringify(next.envelope);
  return r.revs?.find((x) => x.rev !== revOf(next) && JSON.stringify(x.snapshot.envelope) === s)?.rev;
}

const summary = (r: RunResult) => {
  const fp = failurePoint(r);
  return fp ? `${r.conclusion} @ ${fp.path || fp.phase}（${fp.observed.slice(0, 80)}）` : `${r.conclusion}${r.attempts ? `（有效 ${r.attempts.valid}，命中 ${r.attempts.hits}）` : ''}`;
};

/** After the first run of a model-authored plan's sub-case: repair while the failure point moves on. */
export async function repairLoop(first: RunResult, sub: string, d: LoopDeps): Promise<LoopOutcome> {
  const log = d.log ?? (() => {});
  const ask = d.ask ?? defaultAskRepair;
  const runs: RunResult[] = [];
  const steps: RepairStep[] = [];
  let r = first;
  let rerunFor: string | undefined;
  let plan: TestPlan | undefined;
  for (;;) {
    if (d.cancelled?.()) return { runs, steps, stop: '已取消' };
    const fp = failurePoint(r);
    if (!fp) {
      const passed = r.executability?.warmup === 'passed' || !!r.attempts;
      if (steps.length && passed) {
        log(`[repair] 修补后预热通过：${summary(r)}`);
        await d.remember?.(repairCase(r.issue, sub, steps, failurePoint(first)!)).catch((e) => log(`[repair] 修补案例没写进记忆服务：${(e as Error).message}`));
      }
      return { runs, steps, stop: steps.length ? `修补后通过：${summary(r)}` : `没有要修补的：${summary(r)}` };
    }
    log(`[repair] 失败点 ${fp.path || fp.phase}：${fp.cause}（${fp.basis}）— ${fp.observed.slice(0, 120)}`);
    if (fp.cause === 'environment') return { runs, steps, stop: `环境问题，不修补：${fp.observed.slice(0, 120)}` };
    // Executor / uncertain: the same plan once more, as it is (§8.1 ②).
    if ((fp.cause === 'executor' || fp.cause === 'uncertain') && rerunFor !== fp.path) {
      rerunFor = fp.path;
      log(`[repair] ${fp.cause === 'executor' ? '执行端' : '不确定'}：原样重跑一次`);
      plan ??= d.load()?.subcases.find((s) => s.sub === sub)?.plan;
      if (!plan) return { runs, steps, stop: '找不到计划，不能重跑' };
      r = await d.run(plan);
      runs.push(r);
      continue;
    }
    if (fp.cause === 'executor') return { runs, steps, stop: `执行端失败（重跑仍失败）：${fp.observed.slice(0, 120)}`, executor: { path: fp.path, detail: fp.observed } };
    // A plan failure (or 「不确定」 failing twice on the same path).
    const move = nextMove(steps, fp, undefined, []);
    if (!move.go) return { runs, steps, stop: move.why, handoff: { path: fp.path, cause: fp.cause, observed: fp.observed, why: move.why } };
    const rec = d.load();
    if (!rec?.envelope) return { runs, steps, stop: '计划记录没有模型交付（envelope），不能局部修补' };
    let fix: Fix | { stop: string } | undefined = deterministicFix(rec.envelope, sub, fp, r.evidence);
    let next: PlanRecord | undefined;
    let errors: string[] = [];
    for (let attempt = 0; attempt < 2 && !next; attempt++) {
      if (!fix || attempt) {
        const t0 = Date.now();
        const p = plan ?? rec.subcases.find((s) => s.sub === sub)?.plan;
        fix = fixFromAnswer(await ask(repairSystem(), repairPrompt({ env: rec.envelope, sub, fp, evidence: r.evidence, quoted: quotedLines(rec), history: steps.map((s) => ({ rev: s.rev, path: s.path, source: s.source, reason: s.reason, result: s.result ?? '' })), warnings: p ? d.warnings?.(p) : undefined, errors })));
        log(`[repair] 模型修补 ${Math.round((Date.now() - t0) / 1000)} s：${'stop' in fix ? fix.stop : `${fix.ops.length} 处修改 — ${fix.reason}`}`);
      }
      if ('stop' in fix!) return { runs, steps, stop: fix.stop, handoff: { path: fp.path, cause: fp.cause, observed: fp.observed, why: fix.stop } };
      const f = fix as Fix;
      const b = blockers(rec.envelope, sub, fp.path, f);
      if (b.length) return { runs, steps, stop: `修补不能自动应用：${b.join('；')}`, handoff: { path: fp.path, cause: fp.cause, observed: fp.observed, suggestion: f, why: b.join('；') } };
      try {
        const n = patchRecord(rec, f.ops, { source: f.source, reason: f.reason, raw: d.raw, by: 'repair' });
        if (stateOf(n) === '可运行') next = n;
        else errors = (n.partial ?? []).flatMap((p) => p.errors.map((e) => `${e.path}: ${e.message}`)).slice(0, 12);
      } catch (e) {
        errors = [(e as Error).message];
      }
      if (!next) log(`[repair] 修改没通过校验：${errors.slice(0, 3).join('；')}`);
    }
    if (!next) return { runs, steps, stop: `修补没通过校验（两次）：${errors.slice(0, 3).join('；')}`, handoff: { path: fp.path, cause: fp.cause, observed: fp.observed, suggestion: fix as Fix, why: '未通过校验的建议' } };
    const back = sameAsRev(rec, next);
    if (back !== undefined) return { runs, steps, stop: `修补把计划改回了 rev ${back}（来回改）`, handoff: { path: fp.path, cause: fp.cause, observed: fp.observed, suggestion: fix as Fix, why: '来回改' } };
    await d.save(next);
    const f = fix as Fix;
    steps.push({ rev: revOf(next), hash: next.hash, path: fp.path, source: f.source, reason: f.reason });
    plan = next.subcases.find((s) => s.sub === sub)?.plan;
    if (!plan) return { runs, steps, stop: `rev ${revOf(next)} 里没有子用例 ${sub}` };
    const ok = d.approve(plan);
    if (!ok.ok) return { runs, steps, stop: `修补待确认：${ok.why}`, handoff: { path: fp.path, cause: fp.cause, observed: fp.observed, why: `修补待确认（${ok.why}）` } };
    log(`[repair] rev ${revOf(next)}（${f.source}）@ ${fp.path}：${f.reason} → 重新运行`);
    rerunFor = undefined;
    r = await d.run(plan);
    runs.push(r);
    steps.at(-1)!.result = summary(r);
  }
}
