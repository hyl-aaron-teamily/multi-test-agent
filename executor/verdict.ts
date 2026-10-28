// Verdict rule (milestone 5 §A.1): intermittent → one hit within the limits reproduces; always → 3
// consecutive hits reproduce. W2-2 §3.2: conclusions state what was observed — a bug run that did not
// reproduce is "未复现" with its denominator (attempts), never "fixed"; drift rounds are not attempts.
import type { TestPlan } from '../platform/schema/test-plan';

export type Conclusion = '已复现' | '未复现' | '未实现' | '部分实现' | '已实现' | '疑似误操作' | '转为 bug' | 'SKILL 失效' | '执行失败' | '计划不可执行' | '环境不合格';

export class VerdictTracker {
  hits = 0;
  consecutive = 0;
  /** Valid attempts recorded (drift rounds are never recorded). */
  rounds = 0;
  readonly hitRounds: number[] = [];

  constructor(private readonly rule: TestPlan['verdictRule']) {}

  /** Record one valid attempt (`round` = its round number); returns true when the rule is satisfied (stop). */
  record(hit: boolean, round = this.rounds + 1): boolean {
    this.rounds++;
    if (hit) {
      this.hits++;
      this.consecutive++;
      this.hitRounds.push(round);
    } else this.consecutive = 0;
    return this.reproduced();
  }

  reproduced(): boolean {
    return 'anyHit' in this.rule ? this.hits >= 1 : this.consecutive >= this.rule.consecutiveHits;
  }

  conclusion(): Conclusion {
    return this.reproduced() ? '已复现' : '未复现';
  }
}

/** Feature acceptance: all requirement items pass → 已实现, none → 未实现, else 部分实现. */
export function featureConclusion(results: { pass: boolean | null }[]): Conclusion {
  const decided = results.filter((r) => r.pass !== null);
  if (!decided.length) return '执行失败';
  const ok = decided.filter((r) => r.pass).length;
  return ok === decided.length && decided.length === results.length ? '已实现' : ok === 0 ? '未实现' : '部分实现';
}

/** Conclusions that say nothing about the product (the run did not get to a verdict). */
export const NO_VERDICT: Conclusion[] = ['执行失败', '计划不可执行', 'SKILL 失效', '环境不合格'];
