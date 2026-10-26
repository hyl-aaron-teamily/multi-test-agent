// Run statistics. Action interval = gap between consecutive input operations inside a round; the
// round-end checkpoint, lifecycle ops and the step into afterCheck are not action intervals (M5 §C.2).
import type { CoordOp } from '../incident/recording-driver';
import { LIFECYCLE_OPS } from '../platform/schema/test-plan';

export interface Stats {
  steps: number;
  rounds: number;
  durationSec: number;
  avgIntervalMs: number;
  maxIntervalMs: number;
  /** Intervals above the plan's 1 s cap (with the per-op time of the device included). */
  intervalsOverCap: number;
  anomalyGateTriggers: number;
  suspectSignals: number;
  checkpointScreenshots: number;
  visionCalls: number;
  textModelCalls: number;
  launches: number;
  /** Rounds discarded because the screen was not where the plan expected (re-entered). */
  drifts: number;
  /** Check-based hits whose evidence was reviewed by the vision model. */
  evidenceReviews?: number;
  /** Model calls by purpose (e.g. "vision:checkpoint"). */
  modelCallsByPurpose?: Record<string, number>;
  /** Observation tiers that decided the round checks: tier → { n, ms }. */
  observeTiers?: Record<string, { n: number; ms: number }>;
  /** Locate tiers used outside the loop: tier → { n, ms }. */
  locateTiers?: Record<string, { n: number; ms: number }>;
}

export const newStats = (): Stats => ({ steps: 0, rounds: 0, durationSec: 0, avgIntervalMs: 0, maxIntervalMs: 0, intervalsOverCap: 0, anomalyGateTriggers: 0, suspectSignals: 0, checkpointScreenshots: 0, visionCalls: 0, textModelCalls: 0, launches: 0, drifts: 0 });

/** Pure: in-round action intervals of an op log. */
export function actionIntervals(ops: CoordOp[]): number[] {
  const isAfter = (x: CoordOp) => (x.label ?? '').startsWith('after:');
  const out: number[] = [];
  for (let i = 1; i < ops.length; i++) {
    const a = ops[i - 1];
    const b = ops[i];
    if (b.round > 0 && b.round === a.round && !LIFECYCLE_OPS.has(b.op) && !LIFECYCLE_OPS.has(a.op) && !(isAfter(b) && !isAfter(a))) out.push(b.at - a.at);
  }
  return out;
}

export function applyIntervals(stats: Stats, ops: CoordOp[], capMs: number): void {
  const iv = actionIntervals(ops);
  stats.avgIntervalMs = iv.length ? Math.round(iv.reduce((s, x) => s + x, 0) / iv.length) : 0;
  stats.maxIntervalMs = iv.length ? Math.max(...iv) : 0;
  stats.intervalsOverCap = iv.filter((x) => x > capMs).length;
  stats.launches = ops.filter((x) => x.op === 'launch').length;
}

/** Add one tier sample to a tier table. */
export function addTier(t: Record<string, { n: number; ms: number }>, tier: string, ms: number): void {
  const e = (t[tier] ??= { n: 0, ms: 0 });
  e.n++;
  e.ms += ms;
}
