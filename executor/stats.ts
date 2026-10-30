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
  /** Pre-tap checks outside the loop (W2-4 §4.3); byPhase never has a loop entry. */
  preTap?: { checked: number; pass: number; corrected: number; blocked: number; uncertain: number; vision: number; byPhase: Record<string, number>; lines: string[] };
  /** Hierarchy reads by tree backend (W2-4 §4.1) and fallbacks to uiautomator. */
  treeBackend?: { reads: Record<string, { n: number; p50: number; p95: number }>; fallbacks: number; firstFallback?: string };
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

/** Attempts of a bug run (W2-2 §3.1): a round is a valid attempt when its own precondition held and no
 *  operation drift happened; drift rounds are counted separately and never decide anything. */
export interface Attempts {
  /** All rounds played (valid + drift). */
  rounds: number;
  valid: number;
  drift: number;
  hits: number;
  /** Per-round hit rate over valid attempts (0 when none). */
  rate: number;
  /** Wilson 95% interval of the per-round hit rate. */
  wilson: [number, number];
  /** 0 hits: rule-of-three 95% upper bound of the per-round reproduction probability (3/n). */
  upper95?: number;
}

/** Pure: Wilson score interval (95% by default) for k successes in n trials. */
export function wilson(k: number, n: number, z = 1.959964): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const mid = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  const r = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 10_000) / 10_000;
  return [r(mid - half), r(mid + half)];
}

/** Pure: attempts record from round counts. */
export function attemptsOf(valid: number, drift: number, hits: number): Attempts {
  const a: Attempts = { rounds: valid + drift, valid, drift, hits, rate: valid ? Math.round((hits / valid) * 10_000) / 10_000 : 0, wilson: wilson(hits, valid) };
  if (!hits && valid) a.upper95 = Math.round(Math.min(1, 3 / valid) * 10_000) / 10_000;
  return a;
}

const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`;

/** Pure: one-line statement of the attempts (report / conclusion detail). Facts only: no "fixed". */
export function attemptsText(a: Attempts): string {
  const drift = a.drift ? `；另有 ${a.drift} 轮操作偏离（不计入）` : '';
  if (!a.valid) return `0 次有效尝试（共 ${a.rounds} 轮，全部偏离）——无法得出复现结论`;
  if (!a.hits) return `${a.valid} 次有效尝试未复现；单次复现概率 95% 上界 ≈ ${pct(a.upper95 ?? 1)}（3/n）${drift}`;
  return `${a.valid} 次有效尝试中命中 ${a.hits} 次；单轮命中率 ${pct(a.rate)}（Wilson 95% 区间 ${pct(a.wilson[0])}–${pct(a.wilson[1])}）${drift}`;
}
