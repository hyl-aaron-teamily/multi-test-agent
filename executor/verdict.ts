// Verdict rule (milestone 5 §A.1): intermittent → one hit within the limits reproduces;
// always → 3 consecutive hits reproduce. No reproduction rate is reported.
import type { TestPlan } from '../platform/schema/test-plan';

export type Conclusion = '已复现' | '未复现（疑似已修复）' | '未复现（上限内未出现）' | '未实现' | '部分实现' | '已实现' | '疑似误操作' | '转为 bug' | 'SKILL 失效' | '执行失败';

export class VerdictTracker {
  hits = 0;
  consecutive = 0;
  rounds = 0;
  readonly hitRounds: number[] = [];

  constructor(private readonly rule: TestPlan['verdictRule']) {}

  /** Record one round; returns true when the rule is satisfied (stop). */
  record(hit: boolean): boolean {
    this.rounds++;
    if (hit) {
      this.hits++;
      this.consecutive++;
      this.hitRounds.push(this.rounds);
    } else this.consecutive = 0;
    return this.reproduced();
  }

  reproduced(): boolean {
    return 'anyHit' in this.rule ? this.hits >= 1 : this.consecutive >= this.rule.consecutiveHits;
  }

  conclusion(category: TestPlan['category']): Conclusion {
    if (this.reproduced()) return '已复现';
    return category === 'bug-always' ? '未复现（疑似已修复）' : '未复现（上限内未出现）';
  }
}

/** Feature acceptance: all requirement items pass → 已实现, none → 未实现, else 部分实现. */
export function featureConclusion(results: { pass: boolean | null }[]): Conclusion {
  const decided = results.filter((r) => r.pass !== null);
  if (!decided.length) return '执行失败';
  const ok = decided.filter((r) => r.pass).length;
  return ok === decided.length && decided.length === results.length ? '已实现' : ok === 0 ? '未实现' : '部分实现';
}
